
# 把"编辑需求"挪进条件框,支持原地改写

## 改动文件
仅 `src/routes/results.tsx`(以及可能用到 `Textarea`,已存在)。后端 `parseRequirements` / `searchRestaurants` 复用,不动。

## 具体改动

### 1. 顶部 header
- 移除右上角的 `编辑需求` 按钮(那个 `<Link to="/requirements">`)
- 保留 `↻ 再次搜索` 和 `重新开始`

### 2. 条件展示框(`<div className="mb-6 bg-card ...">`)右上角加一个小按钮 `✎ 编辑`
- 默认收起。点击后在该框最底部展开一块编辑区:
  - 一个 `Textarea`(`min-h-[120px]`),`defaultValue` = 当前 store 里的 `freeText`(也就是上次输入的原话)
  - 下方两个按钮:`取消`(收起,丢弃改动) / `应用并重新搜索`(主按钮)
  - 一行小字提示:"改完点应用,会用新条件重新排一次,店铺会刷新"
- 编辑区出现时,原来 `freeText` 的 `<details>原始描述</details>` 隐藏(避免重复)

### 3. 应用逻辑
- 点"应用并重新搜索":
  1. `setRefining(true)`(复用现有全屏 loading 蒙层"AI 正在重新搜索餐厅…")
  2. 调 `parseFn({ data: { city: parsed.city, cuisines: parsed.cuisines, date: "", freeText: 新文本 } })`
  3. `setFreeText(新文本)` + `setParsed({ ...newParsed, mode: parsed.mode })` (沿用之前的 quick/deep 模式)
  4. 调 `searchFn({ data: 新 parsed })`
  5. `setResults(...)`,收起编辑区
- 错误处理走现有 `refineError` 通道
- 编辑期间不离开本页,用户能边看现有店铺边改

### 4. 行为细节
- `Textarea` `maxLength={1000}`,与 requirements 页一致
- 应用按钮在文本与原 `freeText` 完全相同时禁用(避免无意义重搜)
- `refining` 期间编辑区按钮全部 disabled
- 编辑区展开时滚动到条件框,确保用户看见(`scrollIntoView({ behavior: "smooth", block: "nearest" })`)

## 不做的事
- 不改变条件 chips(硬条件/偏好/排除/菜品)的展示位置或样式
- 不加在线 AI 流式预览
- 不动 RestaurantCard、FeedbackPanel、底部"重新搜索"按钮
- 不新增路由、不动 store schema

## 视觉
全部用现有 design tokens(`bg-muted/30`、`border-border`、`text-muted-foreground` 等),不引入新色。编辑区与条件框同卡片内,用 `border-t border-border pt-4 mt-4` 分隔。
