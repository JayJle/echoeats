import { describe, expect, it } from "vitest";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createQwenProvider } from "./ai-gateway";
import { cuisineResolutionPrompt } from "./cuisine-prompts";
import { MODELS } from "./models";
import { expandCuisineQueries } from "./cuisine-expand.server";

// Opt-in real model regression tests: no mock can prove semantic preservation.
const key = process.env.QWEN_API_KEY;
const live = process.env.RUN_CUISINE_LIVE_TESTS === "1" && Boolean(key);
async function resolve(cuisines: string[], freeText: string, uiLanguage: "zh" | "en" = "zh") {
  if (!key) throw new Error("Live cuisine tests require the configured Qwen credential");
  const { output } = await generateText({
    model: createQwenProvider(key)(MODELS.cuisineResolve),
    prompt: cuisineResolutionPrompt({ cuisines, freeText, uiLanguage }),
    maxOutputTokens: 400,
    output: Output.object({ schema: z.object({ cuisines: z.array(z.string()), corrections: z.array(z.unknown()).optional() }), name: "cuisine_resolution" }),
  });
  console.log("Resolved cuisines:", output.cuisines);
  return output.cuisines;
}

describe.skipIf(!live)("cuisine identity — real model regression", () => {
  it("keeps Mexican identity in every creative/fusion alternative", async () => {
    const result = await resolve(["墨西哥菜"], "帮我找一家有点创意的高端的墨西哥菜，或者融合墨西哥菜。要求一定要高端一点，要环境优美，适合约会");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(c => c.includes("墨西哥"))).toBe(true);
  }, 60000);
  it("generalizes to French cuisine rather than generic creative cuisine", async () => {
    const result = await resolve(["法国菜"], "法国菜或者创意法国菜，不能是别的菜系");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(c => /法国|法式|法餐/.test(c))).toBe(true);
  }, 60000);
  it("preserves cuisine identity when inferring without a filled category", async () => {
    const result = await resolve([], "想吃现代韩国菜或者融合韩国菜");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(c => /韩国|韩式|韩餐/.test(c))).toBe(true);
  }, 60000);
  it("preserves English modifier scope", async () => {
    const result = await resolve(["Japanese"], "Japanese food or Japanese fusion, not unrelated cuisines", "en");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(c => /japanese/i.test(c))).toBe(true);
  }, 60000);
  it("does not attach Mexican identity to a genuinely separate Japanese alternative", async () => {
    const result = await resolve(["墨西哥菜"], "墨西哥菜或者日本料理，两种都可以");
    expect(result.some(c => c.includes("墨西哥"))).toBe(true);
    expect(result.some(c => /日本|日式|日料/.test(c) && !c.includes("墨西哥"))).toBe(true);
  }, 60000);
  it("keeps ramen when the narrower phrase is a dish flavor", async () => {
    expect(await resolve(["拉面"], "想吃鱼介拉面")).toEqual(["拉面"]);
  }, 60000);
  it("preserves Mexican identity in localized primary and every synonym", async () => {
    if (!key) throw new Error("Missing configured test credential");
    const result = await expandCuisineQueries({ cuisine: "融合墨西哥菜", city: "St. Louis", language: "en", apiKey: key });
    console.log("Localized cuisines:", result);
    expect([result.primary, ...result.synonyms].every(c => /mexican/i.test(c))).toBe(true);
  }, 60000);
});