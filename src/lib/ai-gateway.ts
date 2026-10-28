import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// Qwen 3.x models think by default (slow, and breaks JSON-only output).
// Inject enable_thinking:false for them on every request.
const noThinkingFetch: typeof fetch = async (input, init) => {
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body);
      if (typeof body.model === "string" && /^qwen3\./.test(body.model)) {
        body.enable_thinking = false;
        init = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      // not JSON — pass through
    }
  }
  return fetch(input, init);
};

// Qwen (DashScope) OpenAI-compatible endpoint.
export const createQwenProvider = (qwenApiKey: string) =>
  createOpenAICompatible({
    name: "qwen",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    headers: {
      Authorization: `Bearer ${qwenApiKey}`,
    },
    fetch: noThinkingFetch,
  });

// Legacy alias; model ids live in ./models.ts.
export const createLovableAiGatewayProvider = createQwenProvider;
