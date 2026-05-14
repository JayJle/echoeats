## 目标

在现有 Google Places 真实候选 + Gemini 排序流程的基础上，新增"网友真实口碑"维度，让结果不再只看 Google 评分。

- **D 部分**：增强跳转链接，用户一键到大众点评/小红书查原始评价
- **E 部分**：在 AI 排序前用 Perplexity 抓取每家候选的网评摘要，喂给 Gemini，让排序、`aiSummary`、`pros/cons` 真正反映真实口碑

## 改动范围

只动 `src/lib/echo.functions.ts` 一个文件，加一个新 connector（Perplexity）。前端无需改动 —— `pros/cons/aiSummary/links` 字段都已经在用。

## 详细方案

### 1. D：增强跳转链接（`buildLinks`）

当前只在 Google 上加 `site:dianping.com` 搜索。改成：

- **中文城市**（已有判断逻辑）：直接生成大众点评 H5 搜索深链
  `https://m.dianping.com/searchshop?keyword={店名}&regionname={城市}`
  （手机点开会拉起 App，桌面端 fallback 到 Google `site:` 搜索）
- **新增小红书链接**：所有城市都加
  `https://www.xiaohongshu.com/search_result?keyword={店名+城市}`
- **日本城市**（已有判断逻辑）：保留 Tabelog `site:` 搜索

链接顺序按平台权威度排（中国：大众点评 > 小红书 > Google；日本：Tabelog > Google；其它：Google > 小红书）。

### 2. E：Perplexity 真实口碑摘要

#### 2a. 接入 Perplexity connector
通过 `standard_connectors--connect` 加 `perplexity`，注入 `PERPLEXITY_API_KEY` 到 server runtime。

#### 2b. 新增 `fetchReviewSummaries` 函数
在 `searchRestaurants` 里，**Google Places 拿到候选后、AI 排序前**插入一步：

```text
对每组前 N 家候选（N=5，控制成本与延迟）：
  并行调用 Perplexity sonar 模型
  query: "{店名} {城市} 真实顾客评价 大众点评 小红书 优缺点"
  search_recency_filter: "year"
  使用结构化输出（json_schema）：
    { reviewHighlights: [...3-5 条], commonComplaints: [...0-3 条],
      sentiment: "positive|mixed|negative", sourceCount: number }
```

如果 `PERPLEXITY_API_KEY` 缺失或调用失败 → 跳过该步骤、不阻断主流程，仅在日志打 warning。

#### 2c. 把摘要喂给 Gemini 排序 prompt
在候选 JSON 里多加一个 `realWorldReviews` 字段。Prompt 增加规则：

- "**优先依据 realWorldReviews 中的真实顾客反馈** 来判断匹配度，而不是只看 Google 评分"
- "若 `commonComplaints` 命中用户的硬条件/避雷项 → 设 `hardFilterPass=false` 或大幅扣分"
- "`pros/cons` 必须从 reviewHighlights / commonComplaints 里取真实素材，不要泛泛而谈"

#### 2d. 控制成本
- 每组只对 top 5 候选做 Perplexity 调用（按 Google 评分排）
- 整个搜索成本 ≈ `料理数 × 5` 次 sonar 调用 + 1 次 Gemini 排序
- 加 8 秒超时，单家失败不影响其它

### 3. 错误处理 & 兜底

- Perplexity 未连接：完全跳过 E 步骤，回到当前 Google-only 排序，不报错
- Perplexity 429/402：在返回的 `error` 字段里附加提示，但仍返回 Google + Gemini 结果
- 单家超时：该家 `realWorldReviews=null`，Gemini 自然降权

## 不在范围

- 不爬大众点评原站（反爬+法律风险，前面已说明）
- 不接第三方付费聚合 API
- 不改前端 UI（链接和文案字段都已存在）
- 不改硬条件解析逻辑（上一轮刚加强过）

## 后续可选

- 把 Perplexity 摘要缓存到 Lovable Cloud 的 KV/表里（按 placeId+7 天 TTL），重复搜索同店时直接命中
- 在卡片里单独显示 "网友说" 折叠区块（需要前端改动，本次不做）