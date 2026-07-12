## 目标
将 /chat 的澄清流程从"固定 3 个硬字段（品类/时间/预算）逐个问"改成"AI 实时分析、动态决定下一问"，最多 5 轮澄清；每轮用户输入后由 LLM 判断是否还需要继续追问，判断的重点放在偏好/环境/菜品/忌口这类软信号上（沿用上一轮已改的 hint 方向）。

## 交互流程
1. 首屏：用户语音+文字输入初始描述（不变）。
2. 提交后调用新的 `analyzeAndAskNext`（替代当前"抽取三字段 + missingFields 顺序问"逻辑）。LLM 返回：
   - `done: true` → 直接进入搜索
   - `done: false, question, suggestions[], summary` → 展示这一问 + 芯片 + 语音/文本兜底
3. 用户每次回答后再次调用 `analyzeAndAskNext`，传入整段对话历史 + 已用轮数。
4. 已用澄清轮数达到 5 → 强制 `done`，直接搜索（即使 LLM 认为还能问）。
5. 用户点"跳过"→ 本轮不算作有效信息，但计入轮数。

## 服务端改动 (`src/lib/echo.functions.ts`)
新增 `analyzeAndAskNext` server fn：
- 输入：`{ city, uiLanguage, history: {role, text}[], roundsUsed: number, maxRounds: 5 }`
- 内部 prompt：给 LLM 完整对话，让它判断是否已经足够搜出好餐厅；重点关注偏好、氛围环境、想吃/忌口的菜、场合、同行人。若不够，产出下一问（≤20 字）和 3–5 个短芯片（≤6 字，本地化）。剩余轮数越少越保守（`roundsRemaining` 传给 prompt）。
- Output schema（保持宽松，避免 Gemini/OpenAI 报错）：
  ```
  { done: boolean, question: string|null, suggestions: string[], summary: string }
  ```
- 兜底：LLM 出错或返回不合规 → `{ done: true }`，让用户少等一步就进入搜索。
- 保留旧 `extractKeyFields`（`parseRequirements` 后段仍用得到品类/时间/预算做展示或搜索参数；也可后续清理）。

## 前端改动 (`src/routes/chat.tsx`)
- 移除 `KEY_FIELDS / FIXED_CHIPS / missingFields / questionFor / chipsFor` 那套硬编码，改成状态：
  - `currentQuestion: string | null`
  - `currentSuggestions: string[]`
  - `roundsUsed: number`（每次 AI 追问 +1）
  - `summary: string`（LLM 给的"已理解"一句话）
- `advance()` 改名 `askNext()`：调用 `analyzeAndAskNextFn`，根据返回决定推入 AI 消息 or 调 `runSearch`。
- `submitAnswer()`：不再依赖 `lastAi.field`；直接把用户回答 append 到 chat history 然后 `askNext()`。跳过的消息标 `(跳过)` 一样计入 roundsUsed。
- 到达 5 轮强制搜索时，AI 消息里加一句"信息够啦，帮你搜~"再跳转。
- Identified 顶栏改为显示 LLM 的 `summary`（长文本），若无则回退到旧的三字段行。
- 芯片区、语音+文本兜底 UI 结构不变（用户强调过的"语音大头 + 文字兜底"完全保留）。

## 文案 (`src/lib/i18n/dict.ts`)
- 新增：`chat.roundsHint`（如"最多再聊 {n} 轮"）、`chat.summary.label`（"已理解"）、`chat.autoSearchNotice`（"信息够啦，开始搜索"）中英两版。
- `chat.q.cuisine/visitTime/budget` 保留但不再使用（可暂留避免连锁改动）。

## Store (`src/lib/store.ts`)
- 新增持久字段：`currentQuestion`, `currentSuggestions`, `roundsUsed`, `analysisSummary`；对应 setters。
- 保留 `extracted`（仍用于后端 parseRequirements 拼装）。
- 每次开始新会话时重置这些字段（`resetChat` 里加）。

## 关键取舍
- 上限硬编码为 5：常量 `MAX_CLARIFY_ROUNDS = 5`，放在 chat.tsx 顶部方便未来调整。
- LLM 判断错误的成本控制：任何异常都回退到"直接搜索"，避免卡住用户。
- 不删旧的 `extractKeyFields`，避免影响 identified 展示与 parseRequirements 的兼容路径。
