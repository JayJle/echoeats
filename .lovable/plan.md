## 根因

`src/lib/ai-gateway.ts` 用 `createOpenAICompatible` 创建 provider 时**没有开启 structured outputs**。AI SDK 的 openai-compatible provider 在这种情况下不会把 `Output.object` 的 JSON schema 真正发给后端，Gateway 立即回 warning：

> "responseFormat" is not supported. JSON response format schema is only supported with structuredOutputs

后果：模型只收到 prompt（schema 丢失），返回普通文本 → `Output.object` 无法解析 → 抛 "No output generated" → fallback 链路也常常失败 → `picks` 为空。

最近一小时日志里 5 次调用全是这条 warning、**0 次 `Output.object ok`**，与你"什么都没解析出来"完全吻合。

## 修复（仅改 2 处，frontend / 业务逻辑不动）

### 1. `src/lib/ai-gateway.ts`：在 provider 工厂里启用 structured outputs

把 `createOpenAICompatible(...)` 包成一个返回函数，给所有调用默认带上 `structuredOutputs: true`：

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const createLovableAiGatewayProvider = (lovableApiKey: string) => {
  const base = createOpenAICompatible({
    name: "lovable",
    baseURL: "https://ai.gateway.lovable.dev/v1",
    headers: {
      "Lovable-API-Key": lovableApiKey,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    includeUsage: true,
  });
  return (modelId: string) =>
    base.chatModel(modelId, { structuredOutputs: true });
};
```

这样 `Output.object` 才会以 `response_format: { type: "json_schema", ... }` 真正发出去。

### 2. `src/lib/echo.functions.ts`：可以把 AI-rank 切回 `gemini-3-flash-preview`

注释里说 3-flash-preview 之前会 "No output generated"，**实际原因就是 schema 没发出去**。修好 (1) 之后，3-flash-preview 更快更便宜，应当切回。改 `model = gateway("google/gemini-3-flash-preview")`（line ~1672）。如果你想保守一点，这一步可以先不做，只做 (1)。

### 3. 兜底日志增强（可选，小改动）

`rankOneGroup` 主路径捕获到 `Output.object failed` 时，把 `result.text.slice(0,200)` 也打出来；当前日志只在 raw fallback 里打 head，主路径失败时拿不到原始文本，排查不到 schema 是否生效。

## 不动的部分

- 不动 prompt、AiPickSchema、scoring、Yelp/Places 召回、前端
- 不动 `runOnce`（intent 解析）的调用方式 —— 它走同样的 provider，自动受益于 (1)

## 验收

- 重新跑一次搜索，preview server-function-logs 不再出现 `"responseFormat" is not supported` warning
- 出现 `[Echo/AI-rank] "<cuisine>" Output.object ok in Xms, picks=N`（N>0）
- 前端 `results` 页面在 AI rank 阶段拿到非空 picks

需要的话我可以只做 1（最小修复），或 1+2+3 一起。
