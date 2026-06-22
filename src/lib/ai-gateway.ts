import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const createLovableAiGatewayProvider = (lovableApiKey: string) => {
  const base = createOpenAICompatible({
    name: "lovable",
    baseURL: "https://ai.gateway.lovable.dev/v1",
    headers: {
      "Lovable-API-Key": lovableApiKey,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    // 必须开启，否则 AI SDK 不会把 Output.object 的 JSON schema 通过
    // response_format=json_schema 发出去，Gateway 会 warn "responseFormat is not supported"
    // 并丢弃 schema，模型返回纯文本 → Output.object 解析为空 → picks 为空。
    supportsStructuredOutputs: true,
  });
  return (modelId: string) => base.languageModel(modelId);
};
