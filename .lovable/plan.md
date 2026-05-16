# 评论源统一锁域：Yelp + Google Maps + TripAdvisor（+ 日本保留 Tabelog）

## 目标

所有**非国内**城市（含日本、欧美、东南亚等）的评论补充阶段，Perplexity 只允许从白名单域抓取，把误读率从 ~15-20% 压到 5-8%。

- **海外通用白名单**：Yelp + Google Maps + TripAdvisor
- **日本**：在通用白名单基础上 **额外加 Tabelog**（日本最权威餐厅站），Tabelog 单独 pipeline 完全保留
- **国内**：Dianping pipeline 完全不动

## 改动范围

只动 `src/lib/echo.functions.ts` 里的 `fetchReviewSummary` 及其调用方。

## 技术细节

### 1. fetchReviewSummary 锁域（按 region 动态白名单）

```ts
const BASE_DOMAINS = [
  "yelp.com",
  "google.com/maps", "maps.google.com", "goo.gl/maps",
  "tripadvisor.com", "tripadvisor.co.uk", "tripadvisor.ca",
  "tripadvisor.com.au", "tripadvisor.com.sg", "tripadvisor.com.hk",
  "tripadvisor.jp",
];

const domains = region === "JP"
  ? [...BASE_DOMAINS, "tabelog.com"]
  : BASE_DOMAINS;

// Perplexity body
search_domain_filter: domains
```

把已有的 `googleMapsUri`（含 `place_id`）拼进 user prompt，让 sonar 优先从这条 URL 切入，再用店名+地址在 Yelp / TripAdvisor（日本再加 Tabelog）各补一轮。

### 2. Prompt 收紧

只问三个字段：

- `reviewHighlights`（≤25 字 × 3-5 条）
- `commonComplaints`（≤25 字 × 0-3 条）
- `sentiment`（positive / mixed / negative）

**移除**：`dianpingRating`（海外/日本都没意义）、`priceLevel`（用 Google Places 自带，日本另有 Tabelog `priceJPY`）。

### 3. Citation 强校验

收到响应后过滤 `citations[]`，只保留 host 命中白名单的链接。citation < 2 条 → 整次响应作废，回退到只用 Google Places API 自带的 5 条原始评论。

### 4. sources 字段固定

- 海外：`["Yelp", "Google Reviews", "TripAdvisor"]`
- 日本：`["Yelp", "Google Reviews", "TripAdvisor", "Tabelog"]`

由 citation 实际命中决定显示哪几个，不让模型自由声明。

### 5. 外链清理

附给店铺卡片的外链：
- 保留：Google Maps URL、Yelp 搜索 URL、TripAdvisor 搜索 URL
- 日本额外保留：Tabelog URL（来自 `fetchTabelogInfo` 的单独结果）
- 删除：小红书搜索链接

### 6. 不动的部分

- **国内（CN/HK/TW）**：Dianping pipeline 完全保留，不走 Perplexity 海外白名单
- **日本 Tabelog 专用 pipeline**（`tabelog.server.ts`）完全保留 —— 它是按店精确抓评分/价位/URL，和这里的"评论摘要"是两件事，互补
- Google Places API 5 条原始评论：永远要，零幻觉基线

## 取舍

**收益**
- 误读率 15-20% → 5-8%
- 跨店混淆几乎为 0
- 日本同时有 Tabelog 精确数据 + 多源评论摘要，比现在更丰富
- 引用 URL 用户可点击核实

**损失**
- 失去小红书的中文用户视角（海外+日本）
- Tabelog 域名加入 sonar 抓取后，可能和单独的 `fetchTabelogInfo` 重复消耗一次 Perplexity 配额（可接受）

## 不做的事

- 不动 UI
- 不加模式开关
- 不动国内分支
- 不引入新依赖
