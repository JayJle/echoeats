## 目标

把 Yelp 命中率显著提高（保守估计 35% → 70%+），同时把"挂错店"风险控制在低位。预算：每家餐厅最多比当前多 1 次 Perplexity 调用；保留 Perplexity-only 方案（不引入 Yelp Fusion）；找到 URL 但置信度不够时**展示但带"未核实"提示**而不是直接丢弃。

---

## 当前命中率低的根因（基于 `src/lib/yelp.server.ts`）

1. **Stage 0 只跑一条 query**：`{name} {area} site:yelp.com`。如果地址 area 抽取不准（比如东京/伦敦的地区名）或商家名含本地化字符，单条 query 经常召不回。
2. **Stage 0 没有打分**：返回的第 1 个 `/biz/` URL 就被采用，slug 完全不验证与店名/城市匹配。
3. **Stage 1 即使带了 preUrl 也常常给出 `url: null`**（Perplexity 没真正抓页面），导致 Stage 2 也只能拿到 preUrl 兜底；preUrl 一旦错了，错误会传到底。
4. **没有"低置信度"分级**：要么完整卡，要么彻底丢，缺少中间档。

---

## 方案（只改 `src/lib/yelp.server.ts` + UI 一处低置信度标记）

### 改动 1：Stage 0 改为多变体并发查询 + 候选打分

把单条 `/search` 调用换成 **2–3 条并发**：

- Q1：`"{name}" {city} site:yelp.com`（带引号锁名字，更精准）
- Q2：`{name} {streetTokens} site:yelp.com`（用地址里的街道关键词，对小店尤其有效）
- Q3：`{name} site:yelp.com/biz`（只在前两条都没召回时再跑，name-only 兜底）

合并三批结果，对每个 `/biz/<slug>` URL 打分：

- slug 包含店名核心 token（normalize 后去空格/连字符比对）：+3
- slug 或 title 包含城市名 / 城市拼音：+2
- snippet 文本里出现地址中的街道名或门牌号：+2
- 同一 URL 在多条 query 里都出现：+1
- 评分 ≥ 5 视为**高置信度**，3–4 为**中置信度**，1–2 为**低置信度**

只保留 top1 进入 Stage 1，并把分档作为 `confidence` 字段透传。

### 改动 2：Stage 1 精简，Stage 2 仅在中/低置信度时跑

- 高置信度（≥5）：直接用 Stage 1 一次 sonar 调用补 rating/reviewCount/priceLevel/summary，不跑 Stage 2。
- 中置信度（3–4）：跑 Stage 1，若字段空再跑 Stage 2。Stage 2 prompt 增加一条"先核对店名+地址是否吻合，吻合再读字段，不吻合就把 url 设为 null"。
- 低置信度（1–2）：跳过 Stage 1，**直接跑 Stage 2** 让 sonar-pro 做一次"名字+地址匹配核验"，若核验通过则返回字段+`confidence: "low"`；不通过则丢弃 URL。

净调用次数：高置信度 1+1=2 次，比现在的 1+1+(可能)1 略少；中/低 2+1=3 次，比现在多 1 次。整体平均略低于"2x 当前"预算。

### 改动 3：YelpInfo 增加 `confidence` 字段

```ts
export type YelpInfo = {
  rating: string | null;
  reviewCount: number | null;
  url: string | null;
  priceLevel: "$" | "$$" | "$$$" | "$$$$" | null;
  summary: string | null;
  confidence: "high" | "medium" | "low";  // 新增
};
```

`echo.functions.ts` 里 candidate 透传时把 `confidence` 一并带上。

### 改动 4：UI 低置信度提示

在 `src/routes/results.tsx` 第 742 行的 Yelp 卡片里，当 `r.yelp.confidence === "low"`，标题右侧加一个 `Badge`（淡灰）："可能不准 / Unverified match"。加两条 i18n key：
- `results.yelp.unverified`：中文「可能不是同一家」/ 英文「Unverified match」

### 改动 5：地址解析增强（`extractArea` + 新 `extractStreetTokens`）

新增 `extractStreetTokens(address)`：从地址首段拆出街道关键词（去掉门牌号、邮编、国家），返回最多 3 个 token。Stage 0 Q2 用它。

### 改动 6：负缓存 TTL（轻量）

当前 `cache` 永久存 `null`，导致一旦某家没命中就再也不会重试。把 `null` 结果改为带时间戳的弱缓存（30 分钟过期），命中结果仍永久缓存。

---

## 不动的部分

- `echo.functions.ts` 的排序、AI prompt、Tabelog 流程
- `yelp.server.ts` 的并发数 / 超时
- 不新增 secret、不动数据库、不引入新依赖
- Yelp 字段仍**不参与 AI 排序硬过滤**（保持现状）

---

## 预期与回退

- **预期命中率**：当前约 30–40%（基于上轮日志）→ 70–85%。"低置信度但正确"的卡占 10–15%，会带 unverified 标记。
- **预期错配率**：通过 slug 打分 + Stage 2 核验，错配率应低于 5%；剩余错配也会被打成 low 并标 unverified。
- **延迟**：单家平均 +0.5–1.5s（Stage 0 三条并发不会线性叠加，Stage 2 仅中/低置信度跑）。
- **回退**：所有改动集中在 `yelp.server.ts` + UI 一处 + i18n 两条。回滚 = 还原文件。
