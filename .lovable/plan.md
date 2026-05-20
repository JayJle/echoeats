## 目标

当前同一家餐厅的网评摘要只调一次 Perplexity，覆盖 Yelp/TripAdvisor/Google Maps（JP 再加 Tabelog）。Perplexity 实际倾向于只引用 Google Maps，导致 UI 上来源经常只剩 `Google Reviews`。改为**按平台拆成并行子查询**，让 Yelp / TripAdvisor 有独立的命中机会。

## 改动范围

只改 `src/lib/echo.functions.ts` 里评论摘要部分。`ReviewSummary` 类型、`mergeReviewSummaries`、`googleReviewsToSummary`、结果页 UI **全部不动**。

## 技术方案

### 1. 新增 `fetchPlatformReview(platform, ...)`
- 入参增加 `platform: "yelp" | "tripadvisor" | "tabelog"`。
- `search_domain_filter` **只放该平台的域**（yelp → `["yelp.com"]`；tripadvisor → 所有 `tripadvisor.*` 变体；tabelog → `["tabelog.com"]`）。
- prompt 收紧成「只在 {该平台} 上找这家店，找不到就返回空」，去掉「多个平台二选一」的语义，避免模型偷懒只回 Google。
- citation 白名单同步收紧到该平台；现有反幻觉规则（citation 必须命中白名单否则整段丢弃）原样保留。
- 保留每个调用 20s `AbortController` 熔断。
- 返回 `ReviewSummary | null`。

### 2. 重写 `fetchReviewSummary` 为编排器
- 平台列表：默认 `["yelp", "tripadvisor"]`；`country === "JP"` 时追加 `"tabelog"`。
- 用 `Promise.allSettled` **并行**调子查询。
- 合并非 null 结果：
  - `reviewHighlights` / `commonComplaints`：按平台轮询取条目并去重，分别裁到 5 / 3。
  - `sentiment`：多数票，平票回退到更严的（mixed > negative > positive）。
  - `sourceCount`：所有子查询 `validCitations` 之和。
  - `sources`：所有子查询 `sources` 的并集。
- 全部子查询失败/空 → 返回 `null`（与现有行为一致）。

### 3. 超时与并发特性（保留"永不超时"）
- 子查询并行，wrapper 最坏耗时仍 ~20s。
- 任一平台 abort/HTTP 失败不影响其它平台。
- 外层 `asCompleted` + 每任务 `yield` 进度的机制不动，字节流持续 flush。

### 4. 日志
- 每个子查询保留 `[Perplexity] <platform> <name>: ...` 日志，方便在 server-function-logs 里看到具体哪个平台命中/落空。

## 不改的事

- `ReviewSummary` 类型、`SOURCE_ENUM`、`googleReviewsToSummary`、`mergeReviewSummaries`、UI 渲染。
- 国内大众点评分支完全不动。
- Tabelog 已有的 `fetchTabelogInfo` 直拉路径不动。

---

## 技术小白版描述

现在的逻辑相当于：让一个调研员去 3 家点评网站（Yelp、TripAdvisor、Google）查一家店，他通常嫌麻烦只去了最容易的 Google，回来说"只有 Google 有"。

改完之后：派 3 个调研员同时出发，每人专门盯一家网站，谁找到归谁。3 个人一起跑、互不打扰，总时间和原来一个人差不多，但能查到的来源更全。

## 用户视角的效果

- 结果页"来源"标签经常会同时出现 Yelp / TripAdvisor，而不是只有 Google Reviews。
- 评价亮点 / 吐槽更丰富，因为综合了不同平台的真实评论。
- 这家店在 Yelp/TripAdvisor 上确实没收录时，**仍然不会瞎编**，会照实只显示 Google —— 不会出现"假来源"。
- 等待时间与现在基本相同（最多多 1-2 秒，几乎无感）。

## 预期效果

- Yelp / TripAdvisor 命中率显著提升（具体提升幅度看 Perplexity 实际索引情况，但至少不会再被"懒回答"漏掉）。
- 反幻觉约束不变，不会引入假数据。

## 可能存在的负面效果

- **Perplexity 速率限制**：单家店从 1 次调用变 2-3 次，若同时有大量请求，可能更容易遇到 Perplexity 限流（HTTP 429）。已有的兜底是 429 时该平台返回 null，**不影响其它平台、也不会卡死整体流程**，最坏表现就是"那一次某个平台没数据"，跟现在"Perplexity 没找到"的体验完全一致。
- **某些店原本只引用了 Google**：拆查后若 Yelp/TripAdvisor 都没命中，UI 仍只显示 Google —— 这种店的体验和现在一样，没有退化。
- 没有功能 / 字段 / UI 的破坏性变更。

## 成本

- **Perplexity API 调用量：每家店 ×2（非日本）或 ×3（日本）**。按当前 top10×菜系数 的扇出来算，整体 Perplexity 支出大约翻 2-3 倍。
- 其它成本不变：Google Places、Lovable AI Gateway、Supabase 调用都没动。
- **可选后续优化（本次不做）**：按 `placeId` 加 24h 缓存，能把重复查询的 Perplexity 成本砍掉 70%+。如果上线后看到费用涨得明显再做。
