// DeepSeek 客户端：用于 evidence → 字段提取 + 排序的二合一调用。
// 通过 AI SDK 的 openai-compatible provider 接 DeepSeek（OpenAI 兼容）。
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const createDeepSeekProvider = (apiKey: string) =>
  createOpenAICompatible({
    name: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

export const DEEPSEEK_CHAT_MODEL = "deepseek-chat";
