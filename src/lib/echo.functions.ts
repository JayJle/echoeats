import { createServerFn } from "@tanstack/react-start";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway";

const PLATFORMS = ["Google Maps", "Tabelog", "Yelp", "大众点评", "美团"];

const ParseInput = z.object({
  city: z.string().min(1),
  cuisines: z.array(z.string()).min(1),
  date: z.string().min(1),
  time: z.string().min(1),
  freeText: z.string().default(""),
});

const ParsedSchema = z.object({
  city: z.string(),
  cuisines: z.array(z.string()),
  dateTime: z.string(),
  hardFilters: z.array(z.string()),
  softPreferences: z.array(z.string()),
  negativeFilters: z.array(z.string()),
  dishPreferences: z.array(z.string()),
  searchStrategy: z.array(z.string()),
});

export const parseRequirements = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ParseInput.parse(input))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("google/gemini-3-flash-preview");

    const prompt = `你是 Echo Eats 的需求结构化引擎。用户填写了餐厅搜索表单：

- 城市：${data.city}
- 料理类型：${data.cuisines.join("、")}
- 日期：${data.date}
- 时间：${data.time}
- 其它需求（自然语言）：${data.freeText || "（无）"}

请把需求结构化为 JSON。规则：
- hardFilters：必须满足的硬条件（包含城市、料理、营业时间、明确预算、可预约等）。每条简短中文。
- softPreferences：偏好（氛围、评分、适合场景等）。
- negativeFilters：避雷条件（不要游客店、避免吵闹等）。
- dishPreferences：希望吃到的具体菜品。
- searchStrategy：3-5 条搜索策略说明，比如"优先本地高分""排除连锁游客店"等。
- dateTime：合并为可读字符串，如 "2026/05/20 19:30"。
- city/cuisines：原样回传。

如果用户没提到某类，返回空数组。所有内容用简体中文。`;

    try {
      const { output } = await generateText({
        model,
        prompt,
        maxOutputTokens: 2000,
        output: Output.object({
          schema: ParsedSchema,
          name: "parsed_restaurant_requirements",
          description: "Echo Eats structured restaurant search requirements",
        }),
      });
      return output;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`AI 解析失败：${msg}`);
    }
  });

import {
  guessLanguageCode,
  guessRegionCode,
  searchPlaces,
  type PlaceCandidate,
} from "./google-places.server";

const RestaurantSchema = z.object({
  id: z.string(),
  name: z.string(),
  localName: z.string(),
  cuisine: z.string(),
  address: z.string(),
  googleMapsUri: z.string(),
  websiteUri: z.string().nullable(),
  primaryType: z.string().nullable(),
  matchScore: z.number().min(0).max(100),
  matchTier: z.enum(["perfect", "high", "partial"]),
  openNow: z.boolean(),
  reservable: z.boolean(),
  needsReview: z.boolean(),
  ratings: z.array(z.object({ platform: z.string(), score: z.string().nullable() })),
  aiSummary: z.string(),
  matchDetails: z.array(z.object({ label: z.string(), status: z.enum(["ok", "warn"]) })),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
});

const ResultsSchema = z.object({
  groups: z.array(
    z.object({
      cuisine: z.string(),
      restaurants: z.array(RestaurantSchema),
    }),
  ),
});

// AI 排序输出：每组 picks 用 placeId 引用真实候选
const AiPickSchema = z.object({
  placeId: z.string(),
  matchScore: z.number().min(0).max(100),
  matchTier: z.enum(["perfect", "high", "partial"]),
  aiSummary: z.string(),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
  matchDetails: z
    .array(z.object({ label: z.string(), status: z.enum(["ok", "warn"]) }))
    .default([]),
});

const AiRankingSchema = z.object({
  groups: z.array(
    z.object({
      cuisine: z.string(),
      picks: z.array(AiPickSchema),
    }),
  ),
});

function tierFromScore(score: number): "perfect" | "high" | "partial" {
  if (score >= 92) return "perfect";
  if (score >= 80) return "high";
  return "partial";
}

function priceLevelLabel(level: string | null): string | null {
  switch (level) {
    case "PRICE_LEVEL_FREE":
      return "免费";
    case "PRICE_LEVEL_INEXPENSIVE":
      return "$";
    case "PRICE_LEVEL_MODERATE":
      return "$$";
    case "PRICE_LEVEL_EXPENSIVE":
      return "$$$";
    case "PRICE_LEVEL_VERY_EXPENSIVE":
      return "$$$$";
    default:
      return null;
  }
}

function buildLinks(p: PlaceCandidate, city: string) {
  const links: { label: string; url: string }[] = [
    { label: "Google Maps", url: p.googleMapsUri },
  ];
  if (p.websiteUri) links.push({ label: "官网", url: p.websiteUri });

  const q = encodeURIComponent(`${p.name} ${city}`);
  if (/[\u3040-\u30ff]/.test(p.name) || /japan|日本|tokyo|kyoto|osaka/i.test(city)) {
    links.push({
      label: "Tabelog 搜索",
      url: `https://www.google.com/search?q=${encodeURIComponent(`site:tabelog.com ${p.name}`)}`,
    });
  }
  if (/[\u4e00-\u9fff]/.test(p.name) && /china|中国|北京|上海|广州|深圳|成都|杭州/i.test(city)) {
    links.push({
      label: "大众点评搜索",
      url: `https://www.google.com/search?q=${encodeURIComponent(`site:dianping.com ${p.name}`)}`,
    });
  }
  links.push({ label: "Google 搜索", url: `https://www.google.com/search?q=${q}` });
  return links.slice(0, 6);
}

function candidateRatings(p: PlaceCandidate) {
  const score = p.rating != null
    ? `${p.rating.toFixed(1)} / 5${p.userRatingCount ? ` (${p.userRatingCount})` : ""}`
    : null;
  return [
    { platform: "Google Maps", score },
    { platform: "Tabelog", score: null },
    { platform: "Yelp", score: null },
    { platform: "大众点评", score: null },
    { platform: "美团", score: null },
  ];
}

const SearchResponseSchema = z.object({
  groups: ResultsSchema.shape.groups,
  error: z.string().nullable(),
  suggestions: z.array(z.string()),
});

export type SearchResponse = z.infer<typeof SearchResponseSchema>;

const FALLBACK_SUGGESTIONS = [
  "尝试更具体的料理类型（如把「日料」换成「寿司」或「居酒屋」）",
  "扩大或更换城市（用城市核心区域名）",
  "在「其它需求」里加上具体菜品或预算，让 AI 更聚焦",
  "减少同时搜索的料理类型数量",
];

export const searchRestaurants = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ParsedSchema.parse(input))
  .handler(async ({ data }): Promise<SearchResponse> => {
    const aiKey = process.env.LOVABLE_API_KEY;
    if (!aiKey) {
      return { groups: [], error: "服务未配置 AI 凭据", suggestions: [] };
    }
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return {
        groups: [],
        error: "服务未配置 Google Places API Key（GOOGLE_PLACES_API_KEY）",
        suggestions: [],
      };
    }

    const language = guessLanguageCode(data.city);
    const region = guessRegionCode(data.city);

    // 1. 并行调用 Google Places：每个料理一次 Text Search
    const placeResults = await Promise.all(
      data.cuisines.map(async (cuisine) => {
        try {
          const places = await searchPlaces({
            query: `${cuisine} ${data.city}`,
            language,
            region,
            maxResults: 10,
          });
          return { cuisine, places, error: null as string | null };
        } catch (e) {
          return {
            cuisine,
            places: [] as PlaceCandidate[],
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );

    const placesError = placeResults.find((r) => r.error)?.error;
    if (placesError && placeResults.every((r) => !r.places.length)) {
      return {
        groups: [],
        error: `Google Places 调用失败：${placesError}`,
        suggestions: FALLBACK_SUGGESTIONS,
      };
    }

    const allHaveZero = placeResults.every((r) => r.places.length === 0);
    if (allHaveZero) {
      return {
        groups: [],
        error: `Google Places 在「${data.city}」没有找到任何符合的餐厅候选`,
        suggestions: FALLBACK_SUGGESTIONS,
      };
    }

    // 2. AI 排序：用 placeId 引用真实候选
    const candidatesForPrompt = placeResults
      .filter((r) => r.places.length)
      .map((r) => ({
        cuisine: r.cuisine,
        candidates: r.places.map((p) => ({
          placeId: p.placeId,
          name: p.name,
          address: p.address,
          rating: p.rating,
          userRatingCount: p.userRatingCount,
          priceLevel: priceLevelLabel(p.priceLevel),
          openNow: p.openNow,
          primaryType: p.primaryType,
          editorialSummary: p.editorialSummary,
        })),
      }));

    const gateway = createLovableAiGatewayProvider(aiKey);
    const model = gateway("google/gemini-3-flash-preview");

    const prompt = `你是 Echo Eats 的餐厅匹配分析师。下面是 Google Places 返回的真实候选餐厅，按料理分组。请根据用户需求，为每组挑出最匹配的 1-3 家，并给出打分和理由。

用户需求：
- 城市：${data.city}
- 日期/时间：${data.dateTime}
- 硬条件：${data.hardFilters.join("；") || "无"}
- 偏好：${data.softPreferences.join("；") || "无"}
- 避雷：${data.negativeFilters.join("；") || "无"}
- 菜品偏好：${data.dishPreferences.join("；") || "无"}

候选数据（JSON）：
${JSON.stringify(candidatesForPrompt, null, 2)}

铁律：
- **只能使用候选列表里的 placeId**，禁止虚构 placeId、禁止编造店名。
- 每组按匹配度从高到低输出 1-3 家。如果某组所有候选都明显不匹配硬条件，可以返回空 picks 数组。
- matchScore: 0-100；matchTier: perfect (92+) / high (80-91) / partial (<80)。
- aiSummary: 2-3 句中文，结合用户偏好与候选的评分/位置/类型说明匹配理由。
- pros/cons: 各 2-4 条简短中文。
- matchDetails: 3-6 条短描述，每条带 status (ok/warn)。

输出 JSON：{ "groups": [{ "cuisine": "...", "picks": [{ "placeId": "...", "matchScore": 88, "matchTier": "high", "aiSummary": "...", "pros": [...], "cons": [...], "matchDetails": [{ "label": "...", "status": "ok" }] }] }] }`;

    let ranking: z.infer<typeof AiRankingSchema>;
    try {
      const result = await generateText({
        model,
        prompt,
        maxOutputTokens: 6000,
        output: Output.object({
          schema: AiRankingSchema,
          name: "echo_eats_ranking",
          description: "AI ranking of real Google Places restaurant candidates",
        }),
      });
      ranking = result.output;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        groups: [],
        error: `AI 排序失败：${msg}`,
        suggestions: FALLBACK_SUGGESTIONS,
      };
    }

    // 3. 合并 AI picks 与真实 Place 数据
    const placeById = new Map<string, { cuisine: string; place: PlaceCandidate }>();
    for (const r of placeResults) {
      for (const p of r.places) placeById.set(p.placeId, { cuisine: r.cuisine, place: p });
    }

    const groups = data.cuisines
      .map((cuisine) => {
        const aiGroup =
          ranking.groups.find((g) => g.cuisine.toLowerCase() === cuisine.toLowerCase()) ??
          ranking.groups.find((g) => g.cuisine === cuisine);
        const picks = (aiGroup?.picks ?? []).slice(0, 3);

        const restaurants = picks
          .map((pick, idx) => {
            const entry = placeById.get(pick.placeId);
            if (!entry) return null; // AI 编了 placeId，过滤掉
            const p = entry.place;
            const score = Math.round(pick.matchScore);
            const tier =
              pick.matchTier === "perfect" || pick.matchTier === "high" || pick.matchTier === "partial"
                ? pick.matchTier
                : tierFromScore(score);

            const matchDetails = pick.matchDetails.length
              ? pick.matchDetails.slice(0, 7)
              : [
                  { label: `位于 ${data.city}`, status: "ok" as const },
                  ...(p.rating != null
                    ? [{ label: `Google 评分 ${p.rating.toFixed(1)} (${p.userRatingCount ?? 0} 评价)`, status: "ok" as const }]
                    : []),
                  ...(p.openNow === false
                    ? [{ label: "当前未营业", status: "warn" as const }]
                    : []),
                ];

            return {
              id: `${cuisine}-${idx}-${p.placeId}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80),
              name: p.name,
              localName: p.name,
              cuisine,
              address: p.address,
              googleMapsUri: p.googleMapsUri,
              websiteUri: p.websiteUri,
              primaryType: p.primaryType,
              matchScore: score,
              matchTier: tier,
              openNow: p.openNow ?? true,
              reservable: false,
              needsReview: p.rating == null,
              ratings: candidateRatings(p),
              aiSummary: pick.aiSummary?.trim() ||
                `${p.name} 位于 ${p.address || data.city}，${p.rating != null ? `Google 评分 ${p.rating.toFixed(1)}` : "暂无评分"}。`,
              matchDetails,
              pros: pick.pros.length ? pick.pros : ["匹配当前搜索方向"],
              cons: pick.cons.length ? pick.cons : ["请到 Google Maps 确认最新营业时间"],
              links: buildLinks(p, data.city),
            };
          })
          .filter((r): r is NonNullable<typeof r> => Boolean(r));

        if (!restaurants.length) return null;
        return { cuisine, restaurants };
      })
      .filter((g): g is NonNullable<typeof g> => Boolean(g));

    if (!groups.length) {
      return {
        groups: [],
        error: "AI 在真实候选中没有挑出匹配的餐厅，请放宽条件或换一个料理类型重试。",
        suggestions: FALLBACK_SUGGESTIONS,
      };
    }

    const missing = data.cuisines.filter(
      (c) => !groups.some((g) => g.cuisine.toLowerCase() === c.toLowerCase()),
    );
    return {
      groups: ResultsSchema.parse({ groups }).groups,
      error: missing.length ? `没有找到「${missing.join("、")}」的可靠候选` : null,
      suggestions: missing.length ? FALLBACK_SUGGESTIONS : [],
    };
  });

