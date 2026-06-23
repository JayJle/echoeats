## 目标

彻底消除 Pass1 verify 节点的 `No output generated.` 错误和 ~20s 的 raw fallback 延迟。
做法：去掉 `Output.object` 结构化输出，首发就走 raw JSON + 应用层 zod 校验（即当前的 fallback 路径），不再依赖 Gemini 的 constrained decoding。

## 改动范围

只改一个函数：`src/lib/echo.functions.ts` 中的 `rankVerifyGroup`（约 2032–2086 行）。
其他逻辑（prompt 构造、Pass2 打分、Pass2 仍用 Output.object）**全部不动**。

## 改动细节

### 1. 删掉首发 Output.object 调用，直接走 raw

将 `rankVerifyGroup` 内部的 try/catch 双层结构简化为单次调用：

- 模型调用：`generateText({ model, prompt: prompt + JSON 强约束尾巴, maxOutputTokens: 10000 })`
- 解析：`AiVerifyGroupSchema.parse(JSON.parse(extractJson(text)))`
- 校验 `finishReason`：如果是 `length`/`max-tokens`，抛 truncated 错误
- 成功日志：`[Echo/AI-verify] batch=${tag} ok in Xms picks=N`
- 失败日志：`[Echo/AI-verify] batch=${tag} FAILED in Xms reason=...`

### 2. 增加一层"解析失败时"的兜底重试（可选保险）

如果首次 raw 调用解析失败（JSON 不合法或 zod parse 抛错），自动重试 1 次，prompt 末尾再加一条更强的"只输出 JSON"指令。
两次都失败才 return `{ ok: false }`，行为和当前一致（该 cuisine 整批 verifyFail）。

### 3. 日志埋点保持兼容

- 保留 `[Echo/AI-verify] batch=... start` / `... ok` / `... FAILED` 的现有格式
- 去掉 `raw-fallback ok` 这条日志（不再有 fallback 概念）
- `echoLog.start("AI-verify", ...)` 保留

## 不动的部分

- `AiVerifyGroupSchema` / `AiVerifyPickSchema` / 各 sub-schema（`.catch()` 兜底继续生效）
- `buildVerifyPromptForGroup` 整段 prompt
- Pass2 (`scoreGroup`) 的 Output.object 调用（picks 数量更少、schema 更窄、目前没出过空响应问题）
- `expandToFullPick` 等下游处理

## 验证

1. 跑一次完整搜索（5–10 家 × 多 cuisine 并发），观察日志：
   - 每个 batch 都应该只有一行 `ok in Xms`，无 `Output.object failed` / `raw-fallback`
   - 单 batch 耗时应稳定在 15–25s（原首发成功的水平），不再有 40s+ 的尖刺
2. 检查结果页面：`hardFilterChecks` / `matchDetails` 数组长度、字段完整性与之前一致
3. 触发一次故意失败（临时改坏 prompt）确认 `FAILED` 分支仍返回 `{ ok: false }`，Pass2 正确跳过

## 后续可选

如果观察到 raw 解析失败率 > 1%（zod parse 抛错 / JSON 不合法），再考虑：
- 切换到 `google/gemini-2.5-flash`（生产稳定版）
- 或对该 cuisine 自动按"每家店 1 次调用"拆分重试
