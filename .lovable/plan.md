## 上次检索失败的根因

从 preview worker 日志可以非常清楚地看到一条完整的失败链：

```
13:46:11 [warn] AI SDK Warning (lovable.chat / google/gemini-3-flash-preview):
        The feature "responseFormat" is not supported.
        JSON response format schema is only supported with structuredOutputs
13:46:11 [warn] [Echo/AI-rank] Output.object failed (No output generated.), retrying with raw text…
13:47:03 [error] [Echo/AI-rank] fallback also failed:
        Expected ',' or ']' after array element in JSON at position 27724 (line 1063 column 14)
```

对应代码在 `src/lib/echo.functions.ts:1267 / 1340-1396`。

发生的事情：

1. **主调用失败**：AI 排序用的是 `google/gemini-3-flash-preview` + `Output.object({ schema })`。AI Gateway 对这个 preview 模型不支持 `responseFormat` JSON Schema（提示必须用 structuredOutputs 才行），结果 SDK 直接返回 "No output generated."。
2. **兜底也失败**：兜底退回 `generateText` 纯文本，但本次候选有 148 家（日志里 `places-done count=148`），prompt 里把候选 JSON.stringify 全塞进去，模型要输出多组 picks + hardFilterChecks，输出在第 27724 个字符（约 1063 行）被 `maxOutputTokens: 10000` 截断 → JSON 不闭合 → 解析失败 → 前端拿到 "AI 排序失败"。

也就是说：本次失败**不是用户输入的问题**，是「模型选错 + 输出 token 上限太低 + 候选没限制」三件事叠加起来必然失败。同一份需求换更合适的配置就能跑通。

## 修复方案（只动 ranking 这一处，不动 parseRequirements / 搜索逻辑 / 前端）

### 改动 1：主模型换回 `gemini-2.5-flash`
- 文件：`src/lib/echo.functions.ts:1267`
- `gemini-2.5-flash` 在我们项目其它地方（`parseRequirements`、`cuisine-expand`）一直在用 `Output.object` 跑结构化输出，从日志看是稳定的。
- `gemini-3-flash-preview` 在当前 AI Gateway 配置下还不支持 schema 化 JSON 输出，留作 fallback 文本调用即可。

### 改动 2：提升 `maxOutputTokens` 并加截断检测
- 主调用与 fallback 的 `maxOutputTokens` 从 `10000` 提到 `20000`（本次失败截断在 ~27KB 文本 ≈ 10K tokens，留双倍冗余）。
- 在 fallback 解析前检查 `finishReason`：若是 `length` / `max-tokens` 直接报"模型输出被截断"，不要硬塞给 `JSON.parse` 报一个让人看不懂的 "Expected ',' or ']'"。

### 改动 3：候选数据进 prompt 前裁一刀
- 当前是把所有候选（这次 148 家）全部 JSON.stringify 进 prompt。AI 排序本身就只会输出 top N，输入侧 100+ 家纯属浪费 token + 拖慢响应 + 加大截断风险。
- 在 `candidatesForPrompt` 那一段（约 `:1227`）按已有的 Google rating / review count 简单排序，每个 cuisine 分组保留前 ~25 家（总上限 ~60），其余直接不进 prompt。这一步保留现有所有字段结构，只是减少条数。

### 改动 4：fallback 错误信息更可读
- 主流程失败兜底已经存在，本次保留；只是把 `error` 文案从「AI 排序失败：${firstErr}」改成「AI 排序失败：模型输出被截断或返回非 JSON，请再试一次或缩小需求」并打印 `finishReason` 到日志，方便下次定位。

## 不动的部分
- `parseRequirements`（之前讨论过的 hardFilter recall 改造仍未做，本次不动）。
- `searchRestaurants` 主流程、Tabelog / Google Places / cuisine-expand。
- 前端 results / requirements UI。
- 心跳、AsyncGenerator stage 推送逻辑。

## 验证
1. 重跑日志里那条用例：「东京 + 高端、性价比高、谷歌评分 4.0 以上、好吃、适合约会、有情调、氛围好」 → 期望主调用直接成功，不再触发 "Output.object failed"。
2. 人为再造一个大输入（让候选 > 100）：观察 prompt 不再爆量、输出不再被截断。
3. 故意把 `maxOutputTokens` 调回 1000 跑一次，确认新的截断分支会输出可读错误而不是 JSON 解析错。

要我按这个方案直接改吗？

