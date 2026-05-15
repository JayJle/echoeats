# 三步流程改造 + 编辑需求统一 + 结果页重新开始

## 1. 改为三步输入流程

当前是两步（city → cuisines+freeText 合并），要拆成三步。

**Step 1 — `src/routes/index.tsx`（地点）**
- 进度条 `total={3}`，"下一步 →" 跳转 `/cuisines`，逻辑不变。

**Step 2 — `src/routes/cuisines.tsx`（料理类型）**
- 进度条改为 `step=2 total=3`，标题"想吃什么料理？"。
- 删除"补充需求"Textarea 与所有 `desc` / `freeText` / `parseFn` / `searchFn` 相关代码。
- 删除提交时的 AI 调用，仅保存 cuisines 后跳转 `/requirements`。
- 按钮文案：`下一步 →`。

**Step 3 — 复用并改写 `src/routes/requirements.tsx`（补充需求，可跳过）**
- 进度条 `step=3 total=3`，标题"还有什么要求？随便写"，提示"可跳过，先看结果再补充"。
- guard 改成 `if (!city || cuisines.length === 0) navigate("/")`（当前是 `!date`，已无意义）。
- 输入框初始值 = store 里的 `freeText`（实现编辑回填）。
- 提交按钮：`AI 帮我找餐厅 →`；额外加一个 `跳过 →` 链接/次按钮，行为 = 把 freeText 设为空字符串后同样触发 parse + search。
- 提交逻辑：`parseRequirements({ city, cuisines, date: "", freeText })` → `searchRestaurants(parsed)` → `setResults` → 跳转 `/results`（参考 `cuisines.tsx` 现有 onSubmit 的两阶段 stage 文案）。
- 返回链接指向 `/cuisines`。

**清理**
- 删除 `src/routes/when.tsx`、`src/routes/confirm.tsx`（流程中已不再使用）。routeTree 自动重生成。

## 2. 编辑需求统一入口

**`src/routes/results.tsx`**
- header 中的"编辑需求"按钮：`<Link to="/confirm">` → `<Link to="/requirements">`。点进去 Textarea 自动显示当前 `freeText`（由 step 3 的初始值逻辑保证）。
- 删除整段"➕ 继续补充条件，重新筛选"折叠面板（lines 196–233）以及对应 state：`refineOpen`、`extra`、`applyExtraConditions`。
- 保留 `runSearchAgain`（"↻ 再次搜索"按钮）和 loading overlay。
- "没有可展示的餐厅"空态里的 `<Link to="/confirm">` 改为 `/requirements`。

## 3. 结果页"重新开始"按钮

**`src/routes/results.tsx`**
- header 右侧再加一个按钮 `重新开始`（variant outline，size sm），onClick：`useQueryStore.getState().reset(); navigate({ to: "/" })`。
- 底部已有"重新搜索"按钮逻辑相同，可保留或删除——计划：保留底部那个，header 新增的与它行为一致便于用户随时清空回到 step 1。

## 验证
- 走通 `/ → /cuisines → /requirements →（提交或跳过）→ /results`。
- 在 results 点"编辑需求"返回 `/requirements`，文本框预填上次的 freeText，可修改后重搜。
- 在 results 点"重新开始"，回到 `/`，输入框为空，store 清空。

## 风险
- 删除 `confirm.tsx`/`when.tsx` 后若有外部书签会 404，可接受（内部流程未引用）。
- 第 3 步跳过时 freeText 为空字符串，AI 解析仍会基于 city + cuisines 出基础结果，已是当前行为。
