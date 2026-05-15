## 目标
按优先级 1–4 一次性落地：评价/Tabelog 缓存、Tabelog URL 校验、Places FieldMask 复查、AI 排序模型升级。其它逻辑（候选召回、料理保真、回退分区、UI、Step 流程）保持不变。

---

## 1. 评价 + Tabelog 数据库缓存（B1）

### 新建表（migration）
```text
review_cache
  place_id     text PK
  city         text not null
  payload      jsonb not null          -- ReviewSummary 整体序列化
  fetched_at   timestamptz default now()

tabelog_cache
  place_id     text PK
  payload      jsonb not null          -- TabelogInfo 整体序列化
  fetched_at   timestamptz default now()
```
两表均 **不开 RLS**（仅服务端 `supabaseAdmin` 读写，不暴露给前端）。

### 新建 `src/lib/review-cache.server.ts`
- `getCachedReview(placeId)` / `putCachedReview(placeId, city, summary)`
- `getCachedTabelog(placeId)` / `putCachedTabelog(placeId, info)`
- TTL 常量 `CACHE_TTL_MS = 7 * 24 * 3600 * 1000`，超期视为未命中
- 任何 DB 错误 → `console.warn` + 返回 `null`，**不阻塞主流程**
- 用 `supabaseAdmin`，并发上限不需要额外控制

### 接入 `src/lib/echo.functions.ts`
- **评价部分**（约 786–811 行）：循环每个 top 候选时先查 `getCachedReview`，命中则直接 merge 进 `reviewById`；未命中才进 `fetchReviewSummary` 任务列表。任务完成后对每条新结果调用 `putCachedReview`。
- **Tabelog 部分**（约 817–840 行）：`runWorker` 里先 `getCachedTabelog`，命中跳过外部调用；未命中才走 `fetchTabelogInfo`，成功后 `putCachedTabelog`。
- 加日志：`[Cache] review hit X/Y`、`[Cache] tabelog hit X/Y`，方便后续观察命中率。

---

## 2. Tabelog URL 正则校验（A3）

### 改动 `src/lib/tabelog.server.ts`（约 150–155 行 parse 阶段）
拿到 `json.url` 后立即校验：
```ts
const TABELOG_DETAIL_RE = /^https:\/\/tabelog\.com\/[a-z]+\/A\d+\/A\d+\/\d+\/?$/i;
if (url && !TABELOG_DETAIL_RE.test(url)) {
  console.warn(`[Tabelog] reject non-detail url: ${url}`);
  return null;   // 整条记录丢弃，进 cache 时也不写
}
```
确保只有 `https://tabelog.com/{pref}/A{n}/A{m}/{id}/` 这种"店铺详情页"才被采纳；搜索/列表/排行榜页一律弃。

---

## 3. Places FieldMask 复查（B4）

复查 `src/lib/google-places.server.ts` 中 `FIELD_MASK`（21–36 行）。当前已经是 FieldMask 模式（不是返回所有字段），无浪费字段：每一项在 `echo.functions.ts` 都有引用（rating / userRatingCount / priceLevel / openNow / websiteUri / googleMapsUri / primaryType / editorialSummary / location / reviews / photos）。

**结论：本项无需改动**。在最终回复中明确说明已检查、当前 FieldMask 已最优，避免误以为漏做。

---

## 4. AI 排序模型升级（A1）

### 改动 `src/lib/echo.functions.ts`
- **第 34 行**（Step 1 菜系拓展）：保持 `gemini-3-flash-preview`（任务简单，flash 够用，省钱省延迟）
- **第 883 行**（Step 3 排序匹配）：改为 `google/gemini-2.5-pro`
  - 多约束推理（硬条件 + 避雷 + 软条件 + 料理保真 + 价格币种判断）需要 pro 级模型
  - 单次成本预计 +20–40%，延迟 +2–4s
  - 准确率提升体现在：硬条件误判减少、回退区分错率降低、`aiSummary` 措辞更贴合用户需求

---

## 不动的部分
- Google Places 调用、`filterByCuisineRelevance`、料理保真规则
- Perplexity prompt 内容（`fetchReviewSummary`、`fetchTabelogInfo` 自身不改）
- `compositeScore` 公式、回退分区、徽章显示
- `/results` 路由 UI、`FeedbackPanel`、重新开始确认弹窗
- `search_sessions` / `search_feedback` 既有表

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 缓存让差评/价格变化感知滞后 7 天 | TTL 7 天足够新鲜；用户可"重新开始"重新触发 |
| URL 正则太严漏掉合法详情页 | 正则覆盖了 Tabelog 所有公开店铺页格式；漏判时退化为"该店无 Tabelog 信号"，不影响 Google 评价主链路 |
| pro 模型偶发限流 / 延迟波动 | `gemini-2.5-pro` 走 Lovable AI Gateway，自动重试；超时上限不变 |
| 缓存表无限增长 | 单条 < 2KB，万级行可忽略；后续可加定期 vacuum |

---

## 预期效果

- **第二次起同店搜索**：Perplexity 调用降至 0，step 3 阶段省 5–15s
- **首次搜索**：仍跑全量，但 AI 排序更准确（pro 模型）
- **错误店铺渗透**：Tabelog 张冠李戴消除
- **总成本**：缓存命中场景 ↓50–70%，未命中场景 ↑10–15%（pro 模型差价），日均预计净降 30–50%

---

## 给非技术读者
1. **缓存评价**：把每家店的评价和 Tabelog 资料存进自己的数据库，7 天内同一家店再被搜到就直接用旧数据，省掉付费 API 调用。
2. **Tabelog 网址校验**：只接受真正的店铺详情页网址，过滤掉搜索结果页，避免拿错评分。
3. **Places 字段检查**：确认只拉取需要的字段，没有浪费 Google API 配额。
4. **AI 模型升级**：把最后一步"排序+匹配"换成更聪明的模型，准确率明显提升，代价是单次稍贵稍慢。