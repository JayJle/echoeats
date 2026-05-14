## 问题

1. **价格硬条件不准**：只有 Google 的 priceLevel（$/$$/$$$/$$$$），无法判断"人均 ¥150 以内"。
2. **硬条件没显示**：用户不知道每条 hardFilter 是否被检查/满足。
3. **新增**：因信息缺失无法确认某条硬条件、但其它大部分满足的候选，目前会被一刀切剔除。改为在结果页**单独一栏**展示并标注哪条无法核实。

## 方案

### A. Perplexity 网评抓"人均价"

`src/lib/echo.functions.ts` → `fetchReviewSummary`：
- `ReviewSummary` 新增 `priceLevel: number | null` / `priceCurrency: string | null` / `priceContext: string | null`。
- prompt 要求：只返回从大众点评"人均"、Tabelog"夜の予算/昼の予算"、小红书帖子里**直接引用到的**人均金额；推测一律 null。
- json_schema 加这三个字段并 required。
- 候选数据用 `priceFromReviews: { amount, currency, context }` 喂给 AI。

### B. AI 价格判断升级

排序 prompt 内价格规则：
1. 优先用 `priceFromReviews.amount`（同币种）判断；超出 → 违反硬条件。
2. 没有则回退 Google `priceLevel`：明显冲突 → 违反；模糊 → 标"无法确认"。
3. 货币不一致 → 保守标"无法确认"。

### C. 硬条件 100% 显示 + 三态结果

`AiPickSchema` 替换原 `hardFilterPass / hardFilterViolations` 为：
```
hardFilterChecks: { filter: string; status: "ok" | "unknown" | "fail"; note?: string }[]
```
- 长度必须等于 `hardFilters.length`，filter 字段原文复述。
- `ok` = 已确认满足；`unknown` = 信息不足无法确认；`fail` = 确认不满足。
- prompt 要求：任何 `fail` → 不入选；全 `ok` → 进"完全匹配"组；含 `unknown` 但 0 个 `fail` → 进"部分确认"组。

### D. 三栏结果分组

`searchRestaurants` 合并阶段，按 hardFilterChecks 把每组 picks 划成两类：
- `restaurants`（现有字段）：全 `ok` 的，正常展示。
- `partialRestaurants`（新增可选字段，加在 `ResultsGroup` 上）：含 `unknown` 的；卡片样式复用，但顶部加一条徽标"⚠ 部分硬条件无法核实"。

`src/lib/store.ts` → `ResultsGroup` 类型加 `partialRestaurants?: Restaurant[]`。

`src/routes/results.tsx` → 每个料理 section 在 `restaurants` 列表后增加一个子 section：
```
信息不足，部分硬条件无法核实
（标题下小字：以下店其它条件大部分满足，但有 X 条硬条件因网评/Google 数据缺失无法确认，请自行到平台核对）
```
列出 `partialRestaurants`，卡片复用 `RestaurantCard`。

### E. 匹配详情展示硬条件

合并阶段构造 `matchDetails`：把 `hardFilterChecks` 全部转成 detail 项放在最前：
- ok → `{ label: "✓ 硬条件：${filter}${note ? ' — ' + note : ''}", status: "ok" }`
- unknown → `{ label: "？ 硬条件待核实：${filter}${note ? ' — ' + note : ''}", status: "warn" }`
- fail 不会出现（已被剔除）

AI 自由产出的其它 detail 跟在后面，整体保留 8 条上限。

### F. 价格展示给用户

`candidateRatings` 加一行 `{ platform: "人均价格", score: priceFromReviews ? "¥120（晚餐人均，来自网评）" : priceLevelLabel(p.priceLevel) }`。零前端改动（results.tsx 的 Ratings 区块自动多一行）。

## 不动

`parseRequirements`、Google Places 调用、`Restaurant` schema、Firecrawl、大众点评评分行逻辑。

## 风险与回退

- **Perplexity 提取人均成功率**：中国/日本店预计 60-80%；找不到时退回 Google priceLevel；逻辑保守不会假阳性。
- **AI 漏写 hardFilterChecks**：schema required + prompt 双重约束；长度不符时合并阶段把缺失项视为 unknown，候选自动落入"部分确认"栏，绝不冒充全匹配。
- **partialRestaurants 数量**：每组上限 3 家，避免污染主结果；硬条件全 fail 时该栏也为空。

确认就改。