# 料理类型可跳过

## 目标

`/cuisines` 步骤增加「跳过」入口；后端在 cuisines 为空时不报错，按"通用餐厅"流程搜索一次，结果合并为单组展示。

## UI 改动（`src/routes/cuisines.tsx`）

- 在「下一步」旁边新增次级按钮 **"跳过 →"**（variant=ghost / 小字）
- 点击「跳过」：清空 store 里的 cuisines（设为 `[]`），直接跳 `/requirements`
- 不改 placeholder / suggestions / 现有提交逻辑
- StepShell 副标题加一行小提示："不确定也可以跳过，由 AI 根据其它需求推荐"

## Backend 改动（`src/lib/echo.functions.ts`）

### 1. 放宽 schema
- `ParseInput.cuisines`: `z.array(z.string()).min(1)` → `z.array(z.string()).default([])`
- `ParsedSchema.cuisines` 保持 default `[]`

### 2. parseRequirements prompt 调整
- 当 cuisines 为空时，提示 AI 从 freeText 推断 1-3 个料理候选填入 `cuisines`；推断不出来就填一个通用占位 `"餐厅"`
- 不强制要求用户原话出现

### 3. searchRestaurants 兜底
- 调用前：若 `data.cuisines.length === 0`，注入 `["餐厅"]`（海外语种相应翻译："restaurants" / "レストラン" / "음식점"）
- `cuisineExpansions` / `searchPlaces` / 分组逻辑全部不动 —— 用单组「推荐」展示

### 4. 分组标签
- 当 cuisines 是注入的占位时，结果页 group 标题展示为「**为你推荐**」而非「餐厅」
- 通过在 ParsedSchema 上加一个内部标记 `cuisinesAutoFilled: boolean`（不持久化、只在本次返回里用）

## 不动的部分

- store / requirements / results 页面对 cuisines 的现有处理
- 国内大众点评 pipeline、日本 Tabelog pipeline、Perplexity 锁域逻辑

## 取舍

- 跳过时召回基数会变大（"东京 餐厅" 比 "东京 寿司" 候选海得多）→ 依赖 AI 排序兜底，可能 P95 延迟 +2-4s
- 没有 cuisine 反例关键词，`filterByCuisineRelevance` 自动跳过（已有 short-circuit），影响可控
