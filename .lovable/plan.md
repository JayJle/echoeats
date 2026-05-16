# 修复 parseRequirements「No object generated」

## 目标

让 `parseRequirements` 不再因 AI SDK 结构化输出校验失败而直接走最小兜底，UI 能稳定显示识别到的需求（hard / soft / neg / dishes / visitTime）。

## 改动范围

只动 `src/lib/echo.functions.ts` 里的 `parseRequirements`（约 75–258 行）。其余文件、UI、上游搜索逻辑、`ParsedSchema` 字段含义、prompt 文本均不变。

## 具体步骤

### 1. 换稳定模型 + 给足 token（A）

- 主模型：`google/gemini-3-flash-preview` → `google/gemini-2.5-flash`
- 重试模型：`openai/gpt-5-mini`（跨供应商兜底）
- `maxOutputTokens` 从 `4000` 提到 `8000`，避免长 prompt + reasoning 把 JSON 截断

### 2. 解耦 schema，让 coerce 真正生效（B）

当前 `ParsedSchema` 大量字段用 `z.preprocess` / `.catch` / `.default`，AI SDK 转 JSON Schema 时这些「修复层」会丢失。模型偶尔返回 `weight:"0.8"`、`hhmm:"7:00"`、`weekday:7` 就被 SDK 内部 zod 直接判失败，根本进不到我们的 coerce 逻辑。

做法：

- 在 `parseRequirements` 内新增一个 `LooseParsedSchema`（仅本函数用）：所有字段最宽松（`z.unknown()` / 可选 string / 可选 array of unknown），让 AI SDK 转出的 JSON Schema 极宽松。
- `runOnce(model)` 改造：
  1. `Output.object({ schema: LooseParsedSchema })` 拿到松散对象
  2. 立刻用现有严格 `ParsedSchema.safeParse(loose)` —— 因为 `WeightCoerced` / `HhmmCoerced` / `WeekdayCoerced` / `.catch` 都会在这一步把脏数据救回来
  3. 还是失败再抛出，由上层走重试

### 3. 重试时降级到另一供应商

- 第一次：`runOnce("google/gemini-2.5-flash")`
- catch 后：`runOnce("openai/gpt-5-mini")`
- 再失败才走最外层最小兜底（保持现状作为最后防线）

## 不动的部分

- `ParsedSchema` 本体、字段含义、权重规则
- `sanitizeVisitTime` 子串校验逻辑
- prompt 文本（保持现有规则与示例）
- 最外层最小兜底返回结构
- `searchRestaurants` / 流式 / UI / Supabase / 其它服务端函数

## 验证

- `bunx tsc --noEmit` 类型通过
- 用之前失败的输入再触发一次搜索，确认 `server-function-logs` 不再连续出现 `第一次解析失败` + `AI 解析失败，使用兜底结构`，UI 的「识别到的需求」能正常展示
