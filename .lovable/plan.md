## 目标

把 Yelp 命中率从当前的 ~3%（1/30）拉到 ≥ 50%，让 Yelp 卡片在 US/CA/西欧搜索里真实出现。代码管线、UI、i18n 完全不动，只改 `src/lib/yelp.server.ts` 的抓取策略。

---

## 根因分析（基于线上日志）

观察样本：圣路易斯日料搜索，30 家店：
- Stage1（sonar + search_domain_filter）：**0/30** 命中
- Stage2（sonar-pro）：**1/30** 命中（Mizu Sushi Bar）
- 失败原因 100% 是 `no shop-page url in JSON or citations`

对比 Tabelog 的高命中率，三个关键差异：

1. **`search_domain_filter` 传了 7 个域名**（yelp.com / yelp.fr / .it / .de / .es / .co.uk / .ca）。Perplexity 对多域名过滤的召回会显著退化；Tabelog 只传 1 个域名。实际上 **yelp.com 已经覆盖了全球绝大多数 Yelp 店铺页**（包括西欧店），地区域名是冗余的。
2. **Stage1 prompt 过于严苛**：要求 "绝对不要返回搜索/列表/分类页"、"同名不同店一律返回 null"，叠加 strict json_schema 后，模型倾向于**全字段返回 null** 而不是冒险给一个不完美的 URL。
3. **Stage2 没有去掉 `search_domain_filter`**（虽然代码里只有 Stage1 加了，但 Stage2 的 prompt 仍然死扣 yelp.com 详情页）。当 Perplexity 本身没在索引里找到该店时，无论怎么提示 sonar-pro 都给不出 URL。缺少一条**绕过 Perplexity、直接用搜索 API 拿候选 URL** 的兜底。

---

## 修改方案（只动 `src/lib/yelp.server.ts`）

### 改动 1：精简 `search_domain_filter`

```ts
const YELP_DOMAINS = ["yelp.com"]; // 单域名召回最稳，已覆盖国际店
```

保留 `YELP_SHOP_URL_RE` 仍兼容多 TLD（万一 Perplexity 自己冒出 yelp.fr URL，照样接受）。

### 改动 2：放宽 Stage1 prompt

把 Stage1 从"严格匹配，否则 null"改为"先把 yelp.com 上最像的那家店的详情页 URL 给我，找不到再 null"。重点：

- 删掉"宁可全部返回 null"这种诱导模型偷懒的措辞
- 明确说："url 优先级最高；rating/reviewCount/priceLevel/summary 是次要字段，单独 null 不影响 url 返回"
- 给出**正反例**（few-shot 短例）：`✓ https://www.yelp.com/biz/mizu-sushi-bar-saint-louis` / `✗ https://www.yelp.com/search?...`

### 改动 3：新增 Stage 0 ——「Perplexity Search API」直接拿 URL

新增一段在 Stage1 之前的轻量调用：

```ts
POST https://api.perplexity.ai/search
{ query: `${name} ${city} site:yelp.com` }
```

从返回结果里用 `YELP_SHOP_URL_RE` 直接抽第一条命中 URL。如果拿到 URL，就把 URL 喂给后续 Stage1/Stage2 当作 hint：

```
已确认 Yelp 详情页为 ${preUrl}，请直接读这个页面的 rating / reviewCount / priceLevel / summary。
```

这样 Stage1 不需要再"搜索＋读取"两件事一起做，命中率会大幅提升。即使 Stage1/2 都读不出 rating，我们至少能返回 `{ url: preUrl, 其它字段全 null }`，前端就能展示一个 "在 Yelp 查看 →" 链接卡片（仍然有价值）。

### 改动 4：Stage2 去掉对 yelp.com 详情页的死扣

当 Stage 0 没拿到 preUrl 时，Stage2 改成更宽松：

- 用 `sonar-pro`、**不传** `search_domain_filter`
- prompt 改为"在 Yelp 上找这家店，若 Yelp 上没有就返回 null url"
- 仍然要求 URL 必须匹配 `YELP_SHOP_URL_RE`（在解析层兜底）

### 改动 5：解析层放宽

`parseStage` 当前要求 JSON content 必须存在；若 content 为空但 citation 里有 yelp shop URL，就返回 url-only。**扩展**：当 JSON 解析出 url 但 rating 为 null 时，照常返回（已经是这个行为，确认即可）。

无新增字段、无类型变化，`Restaurant.yelp` 形状不变，前端零改动。

---

## 不动的部分

- `src/lib/echo.functions.ts` 的 Yelp 分支接入、并发、心跳、prompt 中 "仅展示不参与硬过滤" 说明
- `src/routes/results.tsx` 的 Yelp 卡片渲染
- `src/lib/i18n/dict.ts` 的 i18n
- `src/lib/store.ts` 的 `Restaurant.yelp` 类型
- Tabelog 全部代码（这次只优化 Yelp）
- 不新增 secret，不动数据库

---

## 预期效果与回退

- **预期命中率**：Stage 0 单独就能给 60-75% 的店一个 URL；Stage1/2 在 URL hint 下再补齐 rating/summary，最终 ~70% 店显示 Yelp 卡片，~40% 店带评分。
- **额外延迟**：Stage 0 是单次 `/search` 调用（200-500ms），并发 8 下整体 stage 时间几乎不变。
- **回退**：若 Stage 0 报错或限流，直接跳过、走原有 Stage1/2 流程，最坏退化到当前 1/30。
- **风险**：`/search` endpoint 的额度与 `/chat/completions` 共享同一个 `PERPLEXITY_API_KEY`，无需新 secret，但要注意每店多 1 次调用 → 30 家店总额度从 60 次涨到 90 次。可接受。
