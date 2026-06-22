## 目标
在 `src/lib/echo.functions.ts` 的 `AiPickSchema` 上加 `verificationStatus` 字段，并把 `HardFilterCheckSchema.filter` 改为可选，让 v4 prompt 的输出能被 Zod 正确接收、不再强制占位 filter token。

## 改动

### 1. `HardFilterCheckSchema` (L729–734)
- `filter: z.string().catch("").default("")` → `filter: z.string().optional()`
- preprocess 兜底 `{ filter: "", ... }` 改为 `{ status: "unknown", confidence: 50 }`（不再带 filter 占位）

### 2. `AiPickSchema` (L738–753)
- 新增字段：
  ```ts
  verificationStatus: z.enum(["ok", "unknown", "fail"]).catch("unknown").default("unknown"),
  ```
  放在 `placeId` 之后、`matchScore` 之前。

## 不动
- 下游 `rankOneGroup` 里的 `verificationStatus` 计算（L1915）这次先不动 —— 它目前是基于 hardFilterChecks 推算的。模型输出的 `verificationStatus` 这一版只是先让 schema 收下，不破坏现有兜底逻辑。下一轮再决定是"模型优先 / 兜底为辅"还是"兜底优先 / 模型作为信号"。
- prompt 文案、minify candidates、picks 长度兜底都不在本次范围。

## 风险
零。新增字段是 optional+default，老调用不受影响；filter 改 optional 后下游 `checksByFilter`（L1889）用 `check.filter` 当 key，会变成 `undefined` key —— 需要确认这里是否会塌成单一桶。

## 待确认
要不要顺手修 L1889 的 `checksByFilter`（filter 变 optional 后，按 index 对齐而不是按 filter 字符串对齐）？还是这次严格只动 schema，下游下一轮再处理？
