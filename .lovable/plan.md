## 目标
保留原本好用的结构化解析能力，但修复两个严重问题：

1. **结构化字段只能写入用户明说/选择的内容**
   - 用户没有输入品类时，`parsed.cuisines` 必须是 `[]`。
   - AI 可以根据输入推断 2–3 个品类作为澄清选项，但这些只是选项，不能写入结构。

2. **用户澄清后的回答必须被纳入结构**
   - 用户回答/点击选项后，要立即合并到 `parsed`。
   - 如果已经补齐，不允许反复问同一个问题。

## 修复计划

### 1. 修复结构化解析里的品类规则
- 在 `parseRequirements` 中保留品类提取，但改成严格规则：
  - 只提取用户文本里明确出现的品类，例如“寿司 / 居酒屋 / 川菜 / pizza / ramen”。
  - 不允许根据城市、氛围、预算、约会、安静、本地人爱去等上下文猜品类。
  - 没提到品类就返回 `cuisines: []`。
- 删除任何会把推断品类写入 `parsed.cuisines` 的逻辑。

### 2. 缺品类时只生成澄清选项
- 如果 `parsed.cuisines` 为空，planner 仍然触发 cuisine 澄清。
- planner 可以根据用户原始输入生成 2–3 个推荐品类选项。
- 这些选项只显示在澄清 UI 中。
- 只有用户点击选项、语音输入、或手动输入后，才写入 `parsed.cuisines`。

### 3. 删除搜索前的自动补品类 fallback
- 删除 `requirements.tsx` 中“如果 cuisines 为空就重新 autoInfer”的逻辑。
- 用户跳过品类澄清后，搜索流程必须保持 `cuisines: []`，不能自动补“居酒屋/拉面/寿司”。

### 4. 强制修复澄清答案未并入结构的问题
- 在 planner server fn 里调整顺序：
  1. 先读取最后一个 assistant 问题对应的 field。
  2. 再读取紧跟着的用户回答。
  3. 先用确定性代码把这个回答写入对应字段。
  4. 然后再重新计算 missing fields。
- 不能依赖模型自己 merge；模型输出后也要被 deterministic post-process 覆盖。

### 5. 修复重复澄清
- 如果当前 field 已经通过用户回答补齐，就从 missing list 移除。
- 如果用户点击“跳过本轮”，该 field 加入 skipped fields，本轮和后续都不再问。
- 如果用户点击“全部跳过”，所有关键缺失字段都加入 skipped fields，不再继续澄清。
- 历史 assistant 消息里的旧选项保持不可点击，避免旧选项误写入当前问题。

### 6. 修复 cuisine 答案写入判定
- 对 cuisine 的写入只接受：
  - 用户直接输入的内容；
  - 当前最新 cuisine 问题下用户点击的选项；
  - 当前最新 cuisine 问题下语音识别出的文本。
- planner 自己生成的 suggestions 不得进入 `parsed.cuisines`。

### 7. 验收用例
- 输入：“想找个安静适合约会的地方”
  - `parsed.cuisines` 必须是 `[]`。
  - UI 可以展示推荐品类选项。
  - 不点击选项时，不能出现“居酒屋”。
- 输入：“周六中午吃寿司”
  - `parsed.cuisines` 必须只包含“寿司”。
  - 不能追加其他推断品类。
- 澄清问：“想吃什么品类？” 用户点“寿司”
  - `parsed.cuisines` 写入“寿司”。
  - 不再重复问品类。
- 澄清问：“什么时候去吃？” 用户答“周六12点”
  - `visitTime` 写入。
  - 不再重复问时间。
- 用户跳过品类
  - 后续不再问品类。
  - 搜索不自动补品类。

## 主要改动文件
- `src/lib/echo.functions.ts`
- `src/routes/requirements.tsx`
- `src/lib/planner-utils.ts`
- `src/lib/planner.functions.ts`
- 必要时小改 `src/components/PlannerClarifyPanel.tsx`，确保只有最新问题可提交答案。