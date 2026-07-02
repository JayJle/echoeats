// 料理本地化 + 同义词扩展 + 反例关键词
// 用一次 LLM 调用把用户输入的中文 cuisine（可能很冷门，例如「猪肉饭」）
// 扩展为目标城市语言下的主词、同义词、以及"明显不是该料理"的反例关键词。
// 结果按 (cuisine, lang) 缓存在内存里（per-Worker 实例）。

import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway";

export type CuisineExpansion = {
  primary: string;
  synonyms: string[];
  negativeKeywords: string[];
};

const Schema = z.object({
  primary: z.string(),
  synonyms: z.array(z.string()).default([]),
  negativeKeywords: z.array(z.string()).default([]),
});

const cache = new Map<string, CuisineExpansion>();

export async function expandCuisineQueries(opts: {
  cuisine: string;
  city: string;
  language: string; // ja / zh-CN / ko / en …
  apiKey: string;
}): Promise<CuisineExpansion> {
  const key = `${opts.cuisine.trim()}|${opts.language}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const fallback: CuisineExpansion = {
    primary: opts.cuisine,
    synonyms: [],
    negativeKeywords: [],
  };

  try {
    const gateway = createLovableAiGatewayProvider(opts.apiKey);
    const model = gateway("google/gemini-3-flash-preview");
    const { output } = await generateText({
      model,
      maxOutputTokens: 400,
      output: Output.object({
        schema: Schema,
        name: "cuisine_expansion",
        description: "Localized cuisine query expansion",
      }),
      prompt: `用户在「${opts.city}」搜索一个中文料理类型：「${opts.cuisine}」。
目标搜索语言代码是 "${opts.language}"。

请把这个料理类型本地化，输出 3 个字段：

1. primary：在 ${opts.language} 语言/当地最常见、最准确的写法（用于 Google Maps 搜索）。
   - 例：「猪肉饭」+ ja → "豚丼"；「猪肉饭」+ en → "pork rice bowl"；「寿司」+ ja → "寿司"。
   - 如果用户输入本身就是该地区通用词（如「拉面」+ ja → "ラーメン"，但中文圈也用「拉面」），用最地道的当地写法。
2. synonyms：2-5 个该料理在当地常见的同义词/近义词（不同写法、不同菜名变体），用于扩展搜索召回。
   - 例：「猪肉饭」+ ja → ["豚バラ丼","焼豚丼","チャーシュー丼","pork donburi"]
   - 例：「猪肉饭」+ zh-CN → ["叉烧饭","烧肉饭","卤肉饭"]
   - 通用大类（如「寿司」「拉面」「牛排」）可以只给 1-2 个或留空数组。
3. negativeKeywords：0-8 个反例关键词，用来识别"明显不是该料理"的店。
   - **严格规则**：只列出"和 primary 容易在当地搜索结果里混淆，但确定不是该料理"的关键词。
   - 例：「猪肉饭」+ ja → ["鰻","うなぎ","牛丼","親子丼","海鮮丼","天丼"]（同为丼类但内容不同）
   - 例：「猪肉饭」+ en → ["eel","beef bowl","chicken rice"]
   - 例：「寿司」+ ja → []（通用大类不需要反例，宁可放空）
   - **绝对不要**列出本身就是该料理一种的词。宁缺毋滥。

只输出 JSON。primary 不能为空字符串。`,
    });
    const result: CuisineExpansion = {
      primary: output.primary?.trim() || opts.cuisine,
      synonyms: (output.synonyms ?? [])
        .map((s) => s.trim())
        .filter((s) => s && s !== output.primary)
        .slice(0, 5),
      negativeKeywords: (output.negativeKeywords ?? [])
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8),
    };
    cache.set(key, result);
    return result;
  } catch (e) {
    console.warn(
      `[cuisine-expand] failed for "${opts.cuisine}" (${opts.language}):`,
      e instanceof Error ? e.message : e,
    );
    cache.set(key, fallback);
    return fallback;
  }
}

// 关键词过滤：保守剔除"明显属于其它料理"的候选。
// 仅当 haystack 命中 negativeKeyword 且**没有**命中 primary/synonyms 时才剔除。
export function filterByCuisineRelevance<
  T extends { name: string; primaryType: string | null; editorialSummary: string | null },
>(places: T[], expansion: CuisineExpansion): T[] {
  const { primary, synonyms, negativeKeywords } = expansion;
  if (!negativeKeywords.length) return places;
  const positives = [primary, ...synonyms].map((s) => s.toLowerCase()).filter(Boolean);
  const negatives = negativeKeywords.map((s) => s.toLowerCase()).filter(Boolean);
  const filtered = places.filter((p) => {
    const haystack = `${p.name} ${p.primaryType ?? ""} ${p.editorialSummary ?? ""}`.toLowerCase();
    const negHit = negatives.some((n) => haystack.includes(n));
    if (!negHit) return true;
    const posHit = positives.some((k) => k && haystack.includes(k));
    return posHit; // 命中 negative 但同时命中 positive → 保留（混合店）
  });
  return filtered;
}
