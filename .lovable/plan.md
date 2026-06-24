# 问题定位

用户原话："**西式**的早餐啊，早午餐的这种形式。**不要中式的**"。当前结果出错的链路：

1. **Stage C（scoreAndAssemble）**把 `cuisines` 拆成 `["Western","Brunch"]` 两个独立品类。
2. **searchRestaurants**对每个 cuisine 分别走 `expandCuisineQueries` + Google Places 召回。
3. `"Brunch"` 单品类被扩展成 `早午餐/brunch`，**完全不知道用户要"西式"风格**，于是召回里混入中式早茶、港式茶餐厅、内地早午餐等。
4. `"不要中式"` 这句即便被识别成 `negativeFilters`，目前**也只参与最终打分提示**，不会反向收紧 Google Places 召回或菜系扩展，所以中式店仍然进入候选池并出现在结果里。

# 修复目标

- 用户给出"风格 + 餐段"（西式 + brunch / 日式 + 拉面专门店 / 韩式 + 烤肉 / 港式 + 早茶 等）时：
  - cuisines **不再拆成两条**，合并为一个带风格的品类（如 `"Western brunch"` / `"西式早午餐"`）。
  - 风格排除（"不要中式"等显式或隐式）作为一个**结构化字段**贯穿到召回层。
- 用户**显式说**"不要中式 / 不要日式 / 不要 X 风格"时，必须落到 `negativeFilters`，并被召回层使用。

# 改动范围（只动 3 个文件）

## 1. `src/lib/echo.functions.ts` — Stage C prompt + 输出 schema

**prompt 新增规则（# 严格规则 段）**
- "**风格 + 餐段 / 餐段类品类不得独立**"：当 freeText 含明确风格词（西式/Western、日式/Japanese、韩式/Korean、港式、台式、中式/Chinese、东南亚/SEA、法式、意式…）且同时含餐段/通用品类词（brunch/早午餐、咖啡、甜品、烧烤、火锅…），**必须合并为一个带风格的 cuisine**（例：`"Western brunch"` 而不是 `["Western","Brunch"]`；`"日式拉面"` 而不是 `["Japanese","Ramen"]`）。
- 反例新增："❌ `["Western","Brunch"]`（拆开后 Brunch 会召回中式茶餐厅）。✅ `["Western brunch"]`。"
- 新增字段 **`cuisineStyleExclude: string[]`**（输出 schema 同步加，复用现有 `LooseParsedSchema`）：
  - 用户**显式说**"不要中式"→ `["Chinese","中式"]`；"不要日式"→ `["Japanese","日式"]` 等。
  - 用户**显式说**"要西式"且没给反向例外 → 隐式补 `["Chinese","Japanese","Korean","Thai","Vietnamese"]` 等同区域常见竞争风格的对照（用于 Google Places 召回噪音过滤，不进 negativeFilters 文本）。
  - 同时该"不要 X"原句仍按现有规则进 `negativeFilters`（人类可读条件，参与最终打分）。

**schema**
- `ParsedSchema` 加 `cuisineStyleExclude: z.array(z.string()).catch([]).default([])`。
- `store.ts` 的 `ParsedRequirements` 类型同步加该字段（可选）。

## 2. `src/lib/cuisine-expand.server.ts` — 接收风格排除

`expandCuisineQueries` 参数加 `styleExclude?: string[]`：

- cache key 加进 `styleExclude.sort().join(",")` 维度。
- prompt 注入一段"**排除风格**"提示：让模型把这些风格在目标语言下的常见关键词（中文/中餐 → "中式 / 港式 / 茶餐厅 / 早茶 / dim sum / cantonese"）合入 `negativeKeywords` 输出。
- 已有的 `filterByCuisineRelevance` 不动 — 它已经按 negativeKeywords 过滤候选。

## 3. `src/lib/echo.functions.ts` — `searchRestaurants` 召回层

在 `data.cuisines.map(async (cuisine) => { const expansion = await expandCuisineQueries(...) })` 处，把 `data.cuisineStyleExclude` 传进去：

```text
expandCuisineQueries({ cuisine, city, language, apiKey, styleExclude: data.cuisineStyleExclude })
```

不改 Google Places API 调用本身（不在请求里加 `excludedTypes`，保守起见），只让 `filterByCuisineRelevance` 拿到更全的 negativeKeywords 后剔除。

# 不在本次范围

- 不改 Stage A/B（已经能抽出"不要中式"）。
- 不改 UI 展示（`cuisineStyleExclude` 暂不在前端展示，仅作为后端管线字段）。
- 不改 `verifyGoogleRatingFilter`、不动评分相关代码。
- 不删除/改动其他 negativeFilters 现有行为。

# 验证

用原话重跑：`不要中式的 + 西式 brunch + 班尼迪克蛋 + French toast`，期望：

- `parsed.cuisines = ["Western brunch"]`（单条，不再 ["Western","Brunch"]）。
- `parsed.cuisineStyleExclude` 含 `Chinese / 中式`。
- `parsed.negativeFilters` 含一条"不要中式 → 避免中式餐厅"。
- 召回阶段日志：`expansion.negativeKeywords` 含 `中式 / 茶餐厅 / 早茶 / dim sum / cantonese` 之类。
- 最终结果里不再出现港式茶餐厅 / 中式早茶店。

# 风险

- 合并 cuisines 会减少召回路数（原 2 路 → 1 路），但每路本身有 8 条 query 扩展，覆盖足够；且原"Brunch"路本来就在污染结果。
- 隐式补 `cuisineStyleExclude` 要保守：仅在用户明确点名一种风格、且没说"也可以接受 X"时才补，避免把混合餐厅误杀。
