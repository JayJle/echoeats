## 目标
每个必备结构化字段（cuisine / mealTime / budget / hardFilter 等）最多只问一次。只有当用户回答无法解析、与已有字段矛盾、或明显有问题时，才允许对同一字段重新澄清一次，并且必须在 prompt 里清楚说明重新问的原因。

## 现状问题
- planner 现在依赖模型判断是否再问，会重复问同一个字段。
- 用户即使跳过或答过，某些字段仍反复出现。
- 重新澄清时也没有说明原因。

## 修复计划

### 1. 在 `src/lib/planner-utils.ts` 增加确定性 asked-once 记账
- 扩展 `PlannerInput`，新增：
  - `askedFields: PlannerField[]` — 已经问过的字段列表（由前端累积并回传）。
  - `reaskField?: { field: PlannerField, reason: "unparseable" | "conflict" } | null` — 上一轮 planner 判定需要重问的字段。
- 在 `detectMissingFields` 之后加一层过滤：
  - 若某字段已在 `askedFields` 里，且不在 `reaskField` 中，则从 missing 中剔除。
  - `skippedFields` 保持原有行为（永远不问）。
- 结果：同一字段自然缺失时只会被选一次。

### 2. 判定「回答是否可用」的确定性逻辑
在 `postProcessPlannerOutput` 中，对刚回答的字段（history 最后一条 assistant.question.field）做校验：
- **unparseable**：用户回答经 `splitCuisineAnswer` / 时间正则 / 预算正则等抽取后结果为空，且不是明确的 skip 词。
- **conflict**：
  - cuisine 与 `negativeFilters` 里明确排斥的品类冲突。
  - mealTime 与已解析 `visitTime` 冲突（例如已说“周六中午”又答“周日晚上”且模型没有覆盖旧值）。
  - budget 与既有 hardFilter/softPreference 明显矛盾。
- 命中时：
  - 不把该字段加入 `askedFields`（本轮不算数）。
  - 返回 `question` 仍指向同一字段，`reason` 设为 `"unparseable"` 或 `"conflict"`。
  - prompt 前缀加清楚原因，例如：
    - 中文：「刚才的回答我没读懂『xxx』，能换个说法吗？」/「和之前说的『周六中午』有冲突，想以哪个为准？」
    - 英文同理。
- 未命中：把该字段推入 `askedFields`，之后即使仍缺也不再问。

### 3. planner prompt 收紧
- Rule 明确：「Never re-ask a field already in askedFields unless server marks it as reask.」
- Rule 明确：「When re-asking due to unparseable/conflict, prompt must state the reason in the user's language.」
- 移除模型自行决定重复问的空间。

### 4. `src/components/PlannerClarifyPanel.tsx`
- 新增本地 state `askedFields: PlannerField[]`。
- 每次 planner 返回 question 后：
  - 若 `question.reason === "missing"` → 把 `question.field` 加入 `askedFields`。
  - 若 `reason` 是 `unparseable` / `conflict` → 不加入（等下一轮判断）。
- 调 `plannerTurn` 时把 `askedFields` 和上一轮的 `reaskField` 一起传。
- 「跳过本轮」照旧写入 `skippedFields`，同时也加入 `askedFields`。
- 达到 MAX_TURNS 或 missing 为空时 done，与现在一致。

### 5. 文案（`src/lib/i18n/dict.ts`）
新增两条 key（中/英）：
- `planner.reask.unparseable`：「刚才的回答我没太读懂，可以换种说法再告诉我一次吗？」
- `planner.reask.conflict`：「和之前的『{prev}』有冲突，想以哪个为准？」
prompt 里由 planner-utils 组装，前端不需要额外渲染。

### 6. 验收
- 用户答「随便」后跳过 → 品类不再被问。
- 用户答「乱码 asdf」→ planner 再问一次品类，prompt 明说“没读懂”。
- 用户先说“周六中午”再答“周日晚上” → planner 再问一次时间，prompt 明说“和周六中午冲突”。
- 用户正常回答时间 → 时间字段本会话不再出现。
- 全部字段：一次通过 / 一次重问，最多两次；正常路径每个 slot 只 1 次。

## 主要改动文件
- `src/lib/planner-utils.ts`
- `src/lib/planner.functions.ts`（透传新字段，不改 handler 主流程）
- `src/components/PlannerClarifyPanel.tsx`
- `src/lib/i18n/dict.ts`
