import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// Qwen (DashScope) OpenAI-compatible endpoint.
// Docs: https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope
export const createQwenProvider = (qwenApiKey: string) =>
  createOpenAICompatible({
    name: "qwen",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    headers: {
      Authorization: `Bearer ${qwenApiKey}`,
    },
  });

// Kept as an alias for any legacy import sites; delegates to Qwen so the
// whole app runs on 通义千问. Model ids passed here must be Qwen ids
// (e.g. "qwen-plus", "qwen-max", "qwen-turbo").
export const createLovableAiGatewayProvider = createQwenProvider;
