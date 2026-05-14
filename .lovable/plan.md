## 问题

用户在 Step 4 自然语言输入里写明的「必须 / 一定 / 不能超过 / 限定 X 以内」等强制要求，目前 `parseRequirements` 经常把它们放进 `softPreferences`，导致后续搜索/排序没有把它当硬条件处理。

例：
- "预算 15000 日元以内" → 应进 hardFilters，实际常进 softPreferences
- "必须能预约" / "一定要有包间" → 同上
- "不要游客店" → 应进 negativeFilters（已 OK，但边界模糊）

## 方案

只改 `src/lib/echo.functions.ts` 里 `parseRequirements` 的 prompt，不动表单/UI/搜索逻辑。

### 1. 在 prompt 里加入明确的「硬条件识别规则」

给 AI 一份判定清单，让它把以下信号一律归为 hardFilters：

- 含强制词：**必须 / 一定 / 务必 / 只要 / 仅 / 不能 / 不要 / 禁止 / 拒绝 / 不接受**
- 含数值上下限：**X 以内 / 不超过 X / 至少 X / 最多 X / X 以上**（预算、人数、距离、评分、步行分钟数等）
- 含明确可验证属性：**可预约 / 接受信用卡 / 有包间 / 无烟 / 适合婴儿车 / 营业到 X 点 / 步行 X 分钟内**
- 用户用「要」「需要」「得」陈述的具体可验证条件

反过来，归 softPreferences 的只有：
- 模糊形容（"氛围好"、"舒服"、"地道"、"环境不错"）
- 用户用"最好/希望/偏好/优先"等弱化词表达的条件

否定句（"不要 X" / "避免 X" / "拒绝 X"）→ negativeFilters。

### 2. 拆分歧义：硬条件 vs 否定

明确告诉 AI：
- "不要游客店" / "避免连锁" → negativeFilters
- "必须能预约" / "预算 ≤ 15000 日元" → hardFilters
- 不要把同一条同时塞进两边

### 3. 加 few-shot 示例

在 prompt 里给 2-3 个对照例子，覆盖：
- 预算上限 → hardFilter
- "可以预约" vs "必须能预约" → soft vs hard
- "最好有蟹刺身" → dishPreferences + soft，而不是 hard

### 4. 可选：让 AI 输出每条 hardFilter 的原文出处

让它在输出里用"用户原话片段 → 标准化条件"的格式（例："预算 15000 日元以内 → 人均预算 ≤ 15000 JPY"），便于后续排序阶段在 prompt 里更准确地引用。

## 改动范围

- 文件：`src/lib/echo.functions.ts`
- 函数：`parseRequirements` 的 prompt 字符串
- 不改 schema、不改 UI、不改 `searchRestaurants`

## 不在范围

- 不改前端表单（Step 4 已经能输入自由文本）
- 不动 Google Places 调用
- 不调整排序逻辑（排序阶段已经把 hardFilters 写进 prompt 给 Gemini，只要识别准确这里就生效）
