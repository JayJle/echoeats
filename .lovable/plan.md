## 目标

砍掉海外候选店通过 Perplexity 抓取 Yelp / TripAdvisor 真实网评的整条链路（命中率 ≈ 1%，纯烧 token），但**完整保留**日本分支用 Perplexity 抓 Tabelog 评分+摘要+价位的逻辑（命中率高、独立信号）。

## 范围

只动 `src/lib/echo.functions.ts` 一个文件，前端无需改动。

## 改动清单

### 1. 删除 Yelp/TripAdvisor 的抓取逻辑
- 删除 `fetchPlatformReview`（第 482-651 行，整个函数）—— Tabelog 不走它。
- 删除 `fetchReviewSummary`（第 653-680 行，整个函数）。
- 删除 `PLATFORM_META` 中的 `yelp` 和 `tripadvisor` 条目；如果 Tabelog 也不再走 `PLATFORM_META`，整个常量一并删除。
- 删除 `PlatformKey` 类型里的 `"yelp" | "tripadvisor"`。
- 删除 `citationMatchesAllowed` 用到 yelp/tripadvisor 主机判断的代码段（第 393-394 行附近）。

### 2. 删除 Yelp/TripAdvisor 的调度
- 第 1287-1325 行那段"海外城市并发跑 fetchReviewSummary、yield review-progress"整段删除。
- 保留紧邻的 Google baseline 注入（第 1281-1286 行 `googleReviewsToSummary`），它是零成本的本地转换，不依赖 Perplexity。
- 删除 `stage: "reviews"` 这个进度阶段；前端进度条仍然有 places / tabelog / ai 三个阶段。

### 3. 删除 UI 上的 Yelp/TripAdvisor "已纳入网评" 行
- 第 897-905 行（`rows.push({ platform: "Yelp", … })` 和 TripAdvisor 同款）整段删除——这些只在 Perplexity 命中时才有意义，源没了就别再渲染了。

### 4. 保留项（明确不动）
- 第 1328-1359 行 **JP 分支的 `fetchTabelogInfo` 调度** —— 完整保留。
- `src/lib/tabelog.server.ts` —— 完整保留。
- 第 838-848 行 **Yelp / TripAdvisor 搜索链接按钮** —— 保留。用户仍可点击跳过去自己核验，只是我们不再花 token 抓内容。
- AI prompt 里 `pros[].source` 枚举（第 1496 行）保留 `"Yelp" / "TripAdvisor"`，因为模型偶尔基于 Google reviews 内容仍可能正确归因；不会因没有 realWorldReviews 平台数据而出错（pros 仍受"只能来自 realWorldReviews"约束）。
- `SOURCE_ENUM` 保留（结构性常量，删除会牵连过多）。

### 5. 命名与日志清理
- 把 `useDianping ? "国内" : "海外"` 那条 `// 海外城市：Google Places + Perplexity 网评` 注释（第 1155 行附近）改成 `// 海外城市：Google Places + Google 一手 reviews（基线）`。
- 第 1279 行的注释 `// 再用 Perplexity 网评做补充合并；Perplexity 失败也不影响 pros/cons 显示。` 删除。

## 影响

- **省钱**：海外查询每次省 ~20 次 Perplexity 调用。
- **延迟下降**：海外 search 流程砍掉一个并发阶段（之前会阻塞到所有 Perplexity 任务完成）。
- **UI 视觉**：海外候选不再出现"Yelp — 已纳入网评 / TripAdvisor — 已纳入网评"行（反正之前几乎从未触发）。搜索链接按钮仍在。
- **AI 质量**：海外 pros/cons 现在 100% 基于 Google Places 一手 reviews（`googleReviewsToSummary` 提供的 baseline）。原本 Perplexity 贡献率 ~1%，砍掉对最终质量影响可忽略。
- **国内 / 日本不受影响**：大众点评（国内）和 Tabelog（日本）逻辑完整保留。

## 技术细节

- 不需要数据库迁移、不需要环境变量调整。
- 不需要前端改动（前端的 SourceKey、徽章渲染保留即可，海外只是不再产生 Yelp/TripAdvisor 来源标签）。
- `PERPLEXITY_API_KEY` 仍然必需（Tabelog 和大众点评都要用），不要删环境变量。
