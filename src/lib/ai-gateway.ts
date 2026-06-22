import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const createLovableAiGatewayProvider = (lovableApiKey: string) => {
  const base = createOpenAICompatible({
    name: "lovable",
    baseURL: "https://ai.gateway.lovable.dev/v1",
    headers: {
      "Lovable-API-Key": lovableApiKey,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
  });
  // 必须开启 structuredOutputs，否则 AI SDK 不会把 Output.object 的 JSON schema
  // 通过 response_format=json_schema 发给 Gateway，Gateway 会回 warning
  // "responseFormat is not supported" 并丢弃 schema，导致模型返回纯文本、
  // Output.object 解析空 → picks 为空。
  return (modelId: string) => base(modelId, { structuredOutputs: true });
};
