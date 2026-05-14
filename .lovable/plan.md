## 背景

当前国内城市（北京/上海等）的店铺一手数据来自 Google Places，但国内 Google 地图覆盖差、评价稀少，导致结果池小且 AI 难判断。用户希望国内城市改用**大众点评**作为一手数据源。

## 关键约束（先说清楚）

**大众点评没有公开 API**：
- 官方"开放平台"早已对个人/中小开发者关闭，只对少数战略合作方开放，无法申请。
- 反爬非常严格（字体加密 / 滑块 / 风控），直接 HTTP 抓取在生产环境不可行。
- 第三方聚合 API（聚合数据等）目前要么停用、要么数据陈旧、要么资质受限。

所以**没有"像 Google Places 那样直接调一个接口拿结构化店铺列表"的合规途径**。但仍有 3 条可走的路，各有取舍。

## 三个可行方案

### 方案 A（推荐）：Perplexity / Firecrawl 检索大众点评网页

思路：把大众点评当成"网评数据源"，由 LLM/检索引擎读取公开网页内容，而不是我们自己爬。

- 国内城市 → 跳过 Google Places 第一阶段
- 用 **Perplexity sonar** 做检索：prompt 强制 `site:dianping.com {城市} {料理} {硬条件}`，让它返回 8-15 家店名 + 大众点评页面 URL + 简短描述
- 拿到候选后，**用 Firecrawl scrape 每家店的大众点评详情页**（已经是项目里可加的连接器），抽取：店名、地址、人均、评分、评论摘要、营业时间
- 后续 AI 判定 / 硬条件过滤逻辑完全复用现有 `echo.functions.ts` 流程

优点：合规（公开网页 + 第三方合规检索），不需要自建反爬，实现快
缺点：每个查询要 1 次 Perplexity + N 次 Firecrawl scrape，成本/延迟会上升；Firecrawl 偶尔被点评页拦截（命中率约 70-85%，要做 allSettled 兜底）

### 方案 B：只用 Perplexity，不抓详情页

只发一次 Perplexity 查询，要求它把店名/人均/评分/亮点都从大众点评页面里读出来直接返回 JSON。**不再走 Google Places 也不再 Firecrawl。**

优点：最简单、最便宜、最快（每组料理一次调用）
缺点：信息密度依赖 Perplexity 的检索质量，地址/营业时间这种结构化字段经常缺失或不准；没有稳定的"店铺详情页 URL"可点

### 方案 C：保留 Google Places + 大众点评作为补充网评源

不替换数据源，只在现有流程里把 Perplexity 的网评 prompt 改成 `site:dianping.com` 优先，让 AI 总结时多用点评内容。候选池仍是 Google Places。

优点：改动最小，零额外成本
缺点：**没解决你的核心痛点**——国内 Google Places 候选池本来就小且差，再好的网评也补不上"店根本没出现在候选里"的问题

## 推荐路线

**方案 A**。它是唯一既能扩大国内候选池、又能拿到大众点评一手信息、且合规的路径。

落地步骤：
1. 加 Firecrawl 连接器（项目里目前没有，需要用户在连接器里授权）
2. 写一个 `searchDianping(city, cuisine)` 函数：Perplexity 检索 → 解析出 8-15 家候选 + URL → Firecrawl 并行 scrape 每家详情页 → 标准化成 `PlaceCandidate` 形状（和 Google Places 输出对齐）
3. 在 `echo.functions.ts` 里加城市判断：如果 `city` 是中文/在中国大陆白名单内 → 走 `searchDianping`；否则走原 Google Places 流程
4. 后续 AI ranking、硬条件过滤、partial 区逻辑全部复用，不动 UI

预估成本：每次国内搜索 ≈ 1 次 Perplexity + 10 次 Firecrawl scrape ≈ 比国外贵 3-5 倍，延迟多 5-15 秒。

## 需要你确认

1. 走 **方案 A** 还是 **方案 B**？（A 更准但更慢更贵；B 快但字段不全）
2. 如果走 A，需要你在"连接器"里授权 **Firecrawl**——要现在让我引导你接吗？
3. "国内"判断标准用哪种？
   - (a) 城市名是中文（最简单，但"东京"也是中文会误判 → 需要白名单兜底）
   - (b) 维护一个中国大陆主要城市白名单（北京/上海/广州/深圳/成都/杭州/…）
   - (c) 让 AI 在 parseRequirements 阶段判断 country
