## 目标
修复 Match Details 中“已满足却显示黄三角”和“同一信息重复出现”的问题，保持现有产品流程不变，只收紧后端输出和前端展示语义。

## 问题原因
- 当前 UI 只有两种状态：`ok` 显示绿勾，其他全部显示黄三角；所以 `unknown`、`fail`、AI 自由输出的 `warn` 被混在一起。
- 后端把硬条件生成的 `hardDetails` 和 AI 自由生成的 `matchDetails` 拼在一起；AI 会重复写“Google评分达标”“靠近车站信息未知”等已由硬条件覆盖的信息。
- 现有去重只做文本包含判断，无法识别同义表达，例如 `Constraint to verify: near the station` 和 `靠近车站信息未知`。

## 修复方案

### 1. 后端只保留一条硬条件事实
- `hardFilterChecks` 继续作为硬条件唯一事实来源。
- 对每个用户硬条件只生成一条 Match 明细。
- 已通过条件显示 `ok`；待核实显示 `unknown`；不满足显示 `fail`，不再把所有非 ok 都塞成 `warn`。

### 2. 增强语义去重
- 增加条件主题归一化：
  - Google/谷歌评分/Google rating/评分达标 统一为 `rating`。
  - station/车站/駅/地铁/near the station/靠近车站 统一为 `station_proximity`。
  - sweet flavor/grilled pork/炭火/猪丼等按关键词归并为同一偏好主题。
- AI 自由 `matchDetails` 如果和任何硬条件主题、或已展示条目主题相同，直接丢弃。
- 对“待核实 near the station”和“靠近车站信息未知”这类中英同义句做主题级去重，而不是只做字符串去重。

### 3. 改前端状态显示
- 扩展 `matchDetails.status` 类型为 `ok | unknown | fail`。
- `ok` 显示绿勾。
- `unknown` 显示黄三角。
- `fail` 显示明确失败样式，而不是和待核实共用同一个黄色警告。
- 去掉文案里的重复前缀和符号，避免出现“✓ ✓ Constraint”。

### 4. 收紧 AI 输出边界
- 在 ranking prompt 中明确：`matchDetails` 只能写非硬条件补充，不能写硬条件、不能写已未知的同义句、不能写 Google 评分达标。
- 对 AI 返回的 `warn` 不直接采信；只有后端确定的信息不足才标 `unknown`。

### 5. 验证场景
- Google rating 4.4 + `Google rating 4.0+`：只出现一次绿色评分通过。
- `near the station` 未知：只出现一次“靠近车站待核实/unknown”，不再同时出现英文和中文重复项。
- AI 返回“Google评分达标 (4.4)”：被硬条件去重删除。
- AI 返回“靠近车站信息未知”：如果硬条件已有 `near the station`，被去重删除。
- 明确失败条件显示失败状态，不再混成普通黄三角。