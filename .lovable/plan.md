## 问题
用户输入「12:00去吃」只有具体钟点、没有星期信号，AI 按当前 prompt 规则把 `weekday` 设为 `null`，`sanitizeVisitTime` 因 weekday 缺失把整条 `visitTime` 清空，因此结果页既没有时间徽标、也没有触发营业时间筛选。

## 方案（只改 AI prompt 一处，不改业务逻辑）

在 `src/lib/echo.functions.ts` 的 visitTime 抽取规则里，把 weekday 兜底改成：

- **有具体钟点（用户原文里出现明确的「H 点 / HH:MM / Npm / Nam」等钟表数字）但没有星期/日期信号 → weekday 默认 = 今天的 weekday（${new Date().getDay()}）**，evidence 仍为该钟点原文片段。
- **只有模糊时段（如「晚上」「中午」「tonight」单独出现，没有具体钟点）→ weekday 仍为 null**（保持现状，不触发过滤，避免误判）。
- 已有日期信号的（今天/明天/周六/Saturday…）→ 保持原规则不变。

同时更新示例：
- 新增：「12:00 去吃」→ `{mentioned:true, evidence:"12:00", weekday:<today>, hhmm:"12:00", raw:"12:00"}`
- 新增：「7pm sushi」→ `{mentioned:true, evidence:"7pm", weekday:<today>, hhmm:"19:00", raw:"7pm"}`
- 保留：「晚上去」→ weekday:null（不过滤）。

## 不动的部分
- `sanitizeVisitTime` 的子串校验与「weekday+hhmm 都必须有才过滤」逻辑维持不变 —— AI 现在会自己把 weekday 填成今天，自然通过校验。
- 结果页徽标、餐厅卡片营业徽标、Google periods 过滤逻辑均不动。

## 验收
- 「12:00 去吃」→ 顶部出现「营业时间 · 周X 12:00 营业」徽标，结果按今天 12:00 过滤。
- 「7pm sushi」→ 同上，按今天 19:00 过滤。
- 「晚上去」→ 不出徽标、不过滤（避免「晚上」太模糊误杀）。
- 「周六晚上 7 点」→ 行为不变。
- 「两个人预算 15000」→ 不出徽标、不过滤。
