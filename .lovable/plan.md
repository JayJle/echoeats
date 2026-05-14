## 目标

1. 移除「美团」评分行（前端 ratings 列表里的固定项）。
2. 想办法补上「大众点评」的真实评分数字（X.X / 5）。

---

## 关于大众点评评分的现实情况

大众点评**没有任何公开/免费的官方 API**可以查询店铺评分：

- 官方开放平台早已对个人开发者关闭，仅向签约商户/连锁品牌开放，且不含评分查询接口。
- 第三方聚合 API（聚合数据、APISpace 等）大多已下架点评数据，少数还在的需付费 + 实名企业资质。
- 直接爬 `dianping.com` / `m.dianping.com` 有强反爬（字体加密、滑块、IP 封禁），Firecrawl 也只能拿到搜索结果列表的店名，**评分数字会被加密成乱码**，不稳定。

所以"拿到准确的大众点评 4.5 分"这种字段在工程上**不现实**。我推荐两条务实路线，请你选一条：

### 方案 A（推荐）：用 Perplexity 提取「网评评分」

复用已经接入的 Perplexity，让它在抓真实网评时**顺便提取一个评分**：
- 扩展 `fetchReviewSummary` 的 JSON schema，新增 `dianpingRating`（number 或 null）和 `dianpingRatingSource`（"dianping" / "xiaohongshu_mention" / "unknown"）。
- Prompt 明确要求："如果在大众点评页面/小红书帖子里看到该店的点评评分（如 4.5 分），返回数字；查不到就返回 null，禁止编造。"
- 前端 ratings 行展示为 `4.5 / 5（网评，来源：大众点评）`，查不到时显示 `—`。
- 优点：零额外成本（已经在调 Perplexity）、零额外延迟、不会编数据。
- 缺点：覆盖率不是 100%，小店 / 新店常拿不到；准确度依赖 Perplexity 的引用源。

### 方案 B：用 Firecrawl 抓大众点评搜索页

- 接 Firecrawl，对每家候选店调一次 `m.dianping.com/searchshop?keyword=...` 的 scrape。
- 现实问题：评分数字在大众点评 H5 上是**加密字体**渲染，markdown 里出来是 `&#xe6f4;&#xe...` 这种乱码，**拿不到可用数字**。能稳定拿到的只有店名 + 地址 + 商圈。
- 等于花了 Firecrawl 额度但还是没拿到评分 → **不推荐**。

### 方案 C：放弃大众点评评分，只显示 Google 评分

- 直接把「大众点评」整行从 ratings 里删掉，跟「美团」一起删。
- 卡片更干净，不会出现"暂无评分"的占位行。
- 缺点：失去了"多平台口碑"的视觉表达。

---

## 我推荐方案 A

理由：你已经付了 Perplexity 的钱在做网评摘要，让它顺手抽一个评分数字几乎是零成本，且明确标注了来源/不编造。拿不到时显示 `—`，比假装有数据要诚实。

---

## 技术改动（方案 A + 删美团）

文件：`src/lib/echo.functions.ts`

1. **`ReviewSummary` 类型**：新增
   ```ts
   dianpingRating: number | null;       // 0-5，找不到为 null
   dianpingRatingSource: "dianping" | "xiaohongshu_mention" | "other" | "unknown";
   ```

2. **`fetchReviewSummary` 的 Perplexity prompt + json_schema**：
   - 增加字段说明："仅当在大众点评店铺页或小红书帖子里**直接看到**该店的点评评分时返回数字（0-5，最多一位小数），找不到必须返回 null，禁止根据'好评多'等模糊信号自己估算。"
   - schema 加上对应的 properties + required。

3. **`candidateRatings(p, review)` 函数签名扩展**：
   - 接收 `ReviewSummary | null`。
   - 删除 `{ platform: "美团", score: null }` 这一行。
   - 大众点评行：`review?.dianpingRating != null ? \`${review.dianpingRating.toFixed(1)} / 5（网评）\` : null`。
   - Tabelog / Yelp 行保持现状（占位）。

4. **`searchRestaurants` 里调用 `candidateRatings`**：把已经在 `reviewById` Map 里的 summary 传进去。

5. **AI prompt 微调**（可选）：告诉 Gemini 现在 candidate 多了 `realWorldReviews.dianpingRating` 字段，可作为口碑参考。

---

## 不改的部分

- 前端组件 / 路由：ratings 是数组，删一行不需要改 UI（卡片自动少一行）。
- `buildLinks`、硬条件过滤、Google Places 调用：都不动。
- 不引入 Firecrawl，不爬大众点评。

---

## 风险与预期

- 大概**30%-60%** 的候选能拿到大众点评数字（北上广深热门餐厅命中率高，海外/小店命中率低）；其余显示 `—`，与现状一致。
- Perplexity 偶尔会把"网友打分高"翻译成具体数字 → 已在 prompt 里明令禁止 + 要求 source。极端情况下仍可能有 1-2% 的幻觉评分，可接受范围。

请确认走方案 A，我就开始实现。如果想要 B 或 C 直接说编号即可。