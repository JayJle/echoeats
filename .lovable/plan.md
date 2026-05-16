## 改动：搜索阶段显示「AI 推断了 N 个品类」

**文件**：`src/routes/requirements.tsx`（仅 UI）

**逻辑**：
- 新增 state `inferredCuisines: string[] | null`，初值 null。
- `runSearch` 中 parse 完成后，若 `parsed.cuisinesInferred && parsed.cuisines.length > 0`，把 `parsed.cuisines` 存进 state；否则保持 null。`runSearch` 开头和 `handleCancel` 把它重置为 null。
- 在 loading 卡片里，当 `currentStage === "search"` 或 `"reviews"` 且 `inferredCuisines` 非空时，在「在 X 搜寻候选餐厅」hint 下方多渲染一行小字：
  ```
  ✨ AI 推断了 N 个品类（居酒屋 / 烤肉 / 日式料理），正在并行搜索，可能稍慢
  ```
  样式用 `text-xs text-primary/80`，与现有 hint 区分。

**不动**：parseRequirements、searchRestaurants、prompt、其它 UI。

**验证**：跳过 cuisine + 输入会触发推断的描述 → 搜索阶段出现该提示；自己选了 cuisine → 不出现。
