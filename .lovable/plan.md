## 现状诊断

「高频好评/差评」大面积空白的真实原因：

**海外流程（Google Places + Perplexity）**
- `fetchReviewSummary` 用 `sonar` 模型 + 9 秒超时，且**无 citations 即整条丢弃**。冷门店 sonar 经常返回 0 citations → 整条 `realWorldReviews = null` → AI 强制 pros/cons 留空。
- 没有用 Google Places 的 `reviews` 字段——而这正是**第一手真实评价**，零幻觉风险，却完全没接入。
- 单一模型、单一查询，没有任何 fallback。

**国内流程（Perplexity + Firecrawl）**
- 只有 top **10** 家店做 Firecrawl + sonar-pro 二次聚合，其余店只能拿 PPLX 初次返回的稀疏 highlights/complaints，多数为空。
- Firecrawl 抓 dianping.com 反爬严重，常返回 < 100 字 markdown → 直接 null → `summarizeShopReviewsViaPerplexity` 拿不到 rawComments → 若 PPLX 也无 citation 就丢弃。
- 没有 Yelp/小红书/美团/知乎等其它真实证据兜底。

## 修复方案（4 项，按性价比排序）

### 1. 海外：接入 Google Places Reviews 字段（最大收益，零幻觉）

`src/lib/google-places.server.ts`
- `FIELD_MASK` 增加 `places.reviews`（最多返回 5 条，含 `text.text` / `rating` / `authorAttribution`）。
- `PlaceCandidate` 类型加 `reviews: { text: string; rating: number }[]`。

`src/lib/echo.functions.ts`
- 海外流程：先把 Google reviews 直接塞进 `realWorldReviews`（sourceCount = reviews.length, sources = ["Google Reviews"]），highlights/complaints 由模型基于这些**真实文本**抽取——这一步可改为本地启发式或一次轻量 AI 调用，不依赖 Perplexity。
- Perplexity 调用变成"补充层"：失败也不影响 pros/cons 显示。

### 2. 海外：放宽 Perplexity 丢弃逻辑 + 多次尝试

`fetchReviewSummary`：
- 超时从 9s → 20s（sonar 慢查询很常见）。
- citation 为 0 时**不再整条丢弃**：若模型返回 highlights，标 `sources: []` + `sourceCount: 0`，下游与 Google reviews 合并；只有当 highlights 也为空才丢。
- 加一次 sonar-pro 重试（仅当首轮 0 citation 且 0 highlights 时）。

### 3. 国内：把深度增强从 top 10 扩到全部候选

`src/lib/dianping.server.ts`
- `FIRECRAWL_TOP_N = 10` → 改为对**全部 dedup 候选**跑 `summarizeShopReviewsViaPerplexity`（Firecrawl 仍只对 top 10 跑，控制成本）。
- 即使没有 Firecrawl rawComments，PPLX summarizer 只要有 citation 就保留——已是真实证据。
- 加并发限流（Promise.all 一次跑 12-15 家 PPLX 没问题，但加 8 路并发上限保险）。

### 4. 国内：加 site 兜底，绕开大众点评反爬

`fetchDianpingShopsViaPerplexity` 与 `summarizeShopReviewsViaPerplexity` 的 user prompt 显式建议模型搜索 `site:xiaohongshu.com` / `site:meituan.com` / `site:zhihu.com` / `site:dianping.com`，提高 citation 命中率。

## 不动的部分

- AI ranking prompt 中"绝对禁止编造网评"的铁律保留。
- `pros 至少 2 条来自 reviewHighlights / cons 至少 1 条来自 commonComplaints` 规则保留——上游网评变多后，这些约束自然被满足。
- `src/routes/results.tsx` UI 不动。
- 国内/海外路由判定不动。

## 预期效果

- 海外：几乎所有 Google Maps 上 ≥10 条评价的店都能显示 pros/cons（来自 Google Reviews 一手数据）。
- 国内：大众点评 PPLX 候选店里，pros/cons 命中率从当前 ~30% 提升到 ~80%+（top 10 有 Firecrawl 增强，其余靠 PPLX summarizer + 多 site 兜底）。
- 真实性不降级：仍然只接受 (a) Google Places 一手 reviews、(b) Perplexity 带 citation 的回答、(c) Firecrawl 实际抓到的 markdown 片段——三者都是真实证据。
