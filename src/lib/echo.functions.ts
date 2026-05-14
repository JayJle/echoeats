import { createServerFn } from "@tanstack/react-start";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway";

const PLATFORMS = ["Google Maps", "Tabelog", "Yelp", "大众点评", "美团"];

const ParseInput = z.object({
  city: z.string().min(1),
  cuisines: z.array(z.string()).min(1),
  date: z.string().min(1),
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
- 其它需求（自然语言）：${data.freeText || "（无）"}

请把需求结构化为 JSON。所有内容用简体中文。如果用户没提到某类，返回空数组。

## 字段说明

- city / cuisines：原样回传。
- dateTime：直接用日期字符串，如 "2026/05/20"。
- hardFilters：用户**强制要求**、必须满足才能入选的条件（详见下方判定规则）。
- softPreferences：偏好/加分项（详见下方判定规则）。
- negativeFilters：避雷/排除条件（"不要 X" / "避免 X" / "拒绝 X" / "禁止 X"）。
- dishPreferences：用户希望吃到的具体菜品名。
- searchStrategy：3-5 条搜索策略说明。

## hardFilters 判定规则（关键，务必严格执行）

只要用户原话出现以下任一信号，必须归入 hardFilters：

1. **强制词**：必须 / 一定 / 务必 / 只 / 仅 / 不能 / 不要 / 禁止 / 拒绝 / 不接受 / 得 / 需要
2. **数值上下限**："X 以内"、"不超过 X"、"至多 X"、"至少 X"、"X 以上"、"≤ / ≥ / < / >" —— 适用于预算、人数、距离、步行分钟、评分、营业时间等。
3. **明确可验证属性**：可预约 / 接受信用卡 / 有包间 / 有吧台 / 无烟 / 可带宠物 / 适合婴儿车 / 营业到 X 点 / 步行 X 分钟内 / 距离地铁 X 站 等。
4. 用户用陈述句给出的具体可核实条件（即使没用强制词），例如"两个人"→ 人数=2 是 hardFilter。

## softPreferences 判定规则

仅当满足以下之一才归 soft，否则倾向 hard：

- 模糊形容词："氛围好"、"舒服"、"地道"、"环境不错"、"高级感"
- 弱化词："最好"、"希望"、"偏好"、"优先"、"如果可以"、"尽量"

## 边界与去重

- 否定句一律进 negativeFilters，不要再复制到 hardFilters。
- 同一条只放一个数组里，不要重复。
- 具体菜品名同时进 dishPreferences；如果用户说"必须有蟹刺身"，则 dishPreferences + hardFilters 都放。

## hardFilters 输出格式

每条 hardFilter 用「用户原话片段 → 标准化条件」格式，便于后续匹配。例：
- "预算 15000 日元以内 → 人均预算 ≤ 15000 JPY"
- "必须能预约 → 支持预约"
- "两个人 → 人数 = 2"

## 示例

输入："两个人预算 15000 日元以内，不要游客店，适合聊天，最好有蟹刺身，评分高一点，可以预约。"
- hardFilters: ["两个人 → 人数 = 2", "预算 15000 日元以内 → 人均预算 ≤ 15000 JPY", "可以预约 → 支持预约"]
- softPreferences: ["适合聊天（安静、便于交谈）", "评分高一点（优先 4.0+）", "最好有蟹刺身"]
- negativeFilters: ["不要游客店（排除以游客为主、本地评价低的店）"]
- dishPreferences: ["蟹刺身"]

注意"可以预约"虽然用了"可以"，但属于明确可验证属性，归 hard；"评分高一点"用了弱化语气"一点"，归 soft。`;

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

// Perplexity 真实网评摘要
type ReviewSummary = {
  reviewHighlights: string[];
  commonComplaints: string[];
  sentiment: "positive" | "mixed" | "negative" | "unknown";
  sourceCount: number;
  sources: string[];
  dianpingRating: number | null;
  dianpingRatingSource: "dianping" | "xiaohongshu_mention" | "other" | "unknown";
};

const SOURCE_ENUM = ["大众点评", "小红书", "Tabelog", "Google Reviews", "Yelp", "其它"] as const;

async function fetchReviewSummary(
  name: string,
  city: string,
  apiKey: string,
): Promise<ReviewSummary | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content:
              "你是餐厅口碑分析助手。基于真实网友评价（大众点评/小红书/Tabelog/Google/Yelp 等）总结。只输出 JSON。",
          },
          {
            role: "user",
            content: `查询「${name}」（位于 ${city}）的真实顾客评价。从大众点评、小红书、Tabelog、Google Reviews、Yelp 等平台找资料，总结：
- reviewHighlights: 3-5 条真实网友提到的优点（具体菜品/服务/氛围/性价比，简体中文，每条 ≤ 25 字）
- commonComplaints: 0-3 条网友普遍提到的缺点/吐槽（如有）
- sentiment: 整体口碑 positive/mixed/negative
- sourceCount: 找到的有效来源数量（整数）
- dianpingRating: 仅当你在大众点评店铺页或小红书帖子中**直接看到**该店的点评评分（0-5 分，例如 4.5）时返回该数字，最多保留一位小数。**找不到必须返回 null**，禁止根据"好评多/口碑好"等模糊信号自己估算或编造。
- dianpingRatingSource: 评分来源——"dianping"（来自大众点评）/"xiaohongshu_mention"（小红书帖子提到的点评分）/"other"（其它来源）/"unknown"（找不到，此时 dianpingRating 必须为 null）。

如果找不到该店，sourceCount 设为 0、其它数组为空、dianpingRating=null、dianpingRatingSource="unknown"。只输出 JSON 对象。`,
          },
        ],
        max_tokens: 700,
        temperature: 0.2,
        search_recency_filter: "year",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "review_summary",
            schema: {
              type: "object",
              properties: {
                reviewHighlights: { type: "array", items: { type: "string" } },
                commonComplaints: { type: "array", items: { type: "string" } },
                sentiment: { type: "string", enum: ["positive", "mixed", "negative", "unknown"] },
                sourceCount: { type: "number" },
                dianpingRating: { type: ["number", "null"] },
                dianpingRatingSource: {
                  type: "string",
                  enum: ["dianping", "xiaohongshu_mention", "other", "unknown"],
                },
              },
              required: [
                "reviewHighlights",
                "commonComplaints",
                "sentiment",
                "sourceCount",
                "dianpingRating",
                "dianpingRatingSource",
              ],
            },
          },
        },
      }),
    });
    if (!res.ok) {
      console.warn(`[Perplexity] ${name}: HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    const rawRating = parsed.dianpingRating;
    const rating =
      typeof rawRating === "number" && rawRating >= 0 && rawRating <= 5
        ? Math.round(rawRating * 10) / 10
        : null;
    const ratingSource = ["dianping", "xiaohongshu_mention", "other", "unknown"].includes(
      parsed.dianpingRatingSource,
    )
      ? parsed.dianpingRatingSource
      : "unknown";
    return {
      reviewHighlights: Array.isArray(parsed.reviewHighlights) ? parsed.reviewHighlights.slice(0, 5) : [],
      commonComplaints: Array.isArray(parsed.commonComplaints) ? parsed.commonComplaints.slice(0, 3) : [],
      sentiment: ["positive", "mixed", "negative"].includes(parsed.sentiment) ? parsed.sentiment : "unknown",
      sourceCount: Number(parsed.sourceCount) || 0,
      dianpingRating: rating,
      dianpingRatingSource: rating == null ? "unknown" : ratingSource,
    };
  } catch (e) {
    console.warn(`[Perplexity] ${name}:`, e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

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
  hardFilterPass: z.boolean(),
  hardFilterViolations: z.array(z.string()).default([]),
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

function isChineseCity(city: string, name: string): boolean {
  return /[\u4e00-\u9fff]/.test(name) || /china|中国|北京|上海|广州|深圳|成都|杭州|重庆|武汉|南京|苏州|天津|西安|青岛|厦门|长沙|郑州|香港|hong\s*kong|hk|澳门|macau|台北|taipei/i.test(city);
}

function isJapaneseCity(city: string, name: string): boolean {
  return /[\u3040-\u30ff]/.test(name) || /japan|日本|tokyo|kyoto|osaka|东京|京都|大阪|nagoya|fukuoka|sapporo|yokohama|札幌|横滨|名古屋|福冈/i.test(city);
}

function buildLinks(p: PlaceCandidate, city: string) {
  const links: { label: string; url: string }[] = [];
  const q = encodeURIComponent(`${p.name} ${city}`);
  const qName = encodeURIComponent(p.name);
  const qCity = encodeURIComponent(city);

  const isCN = isChineseCity(city, p.name);
  const isJP = isJapaneseCity(city, p.name);

  if (isCN) {
    // 大众点评 H5 搜索深链（手机会拉起 App）
    links.push({
      label: "大众点评",
      url: `https://m.dianping.com/searchshop?keyword=${qName}&regionname=${qCity}`,
    });
    // 小红书搜索（用户口碑）
    links.push({
      label: "小红书",
      url: `https://www.xiaohongshu.com/search_result?keyword=${q}&type=51`,
    });
  }

  if (isJP) {
    links.push({
      label: "Tabelog",
      url: `https://www.google.com/search?q=${encodeURIComponent(`site:tabelog.com ${p.name}`)}`,
    });
  }

  links.push({ label: "Google Maps", url: p.googleMapsUri });
  if (p.websiteUri) links.push({ label: "官网", url: p.websiteUri });

  if (!isCN) {
    // 非中文城市也加小红书（很多海外城市国人口碑在小红书）
    links.push({
      label: "小红书",
      url: `https://www.xiaohongshu.com/search_result?keyword=${q}&type=51`,
    });
  }

  links.push({ label: "Google 搜索", url: `https://www.google.com/search?q=${q}` });
  return links.slice(0, 6);
}

function candidateRatings(p: PlaceCandidate, review: ReviewSummary | null) {
  const score =
    p.rating != null
      ? `${p.rating.toFixed(1)} / 5${p.userRatingCount ? ` (${p.userRatingCount})` : ""}`
      : null;
  const dpScore =
    review?.dianpingRating != null
      ? `${review.dianpingRating.toFixed(1)} / 5（网评）`
      : null;
  return [
    { platform: "Google Maps", score },
    { platform: "大众点评", score: dpScore },
    { platform: "Tabelog", score: null },
    { platform: "Yelp", score: null },
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
    // 1.5 Perplexity 真实网评摘要：每组取 Google 评分前 5 家并行获取
    const pplxKey = process.env.PERPLEXITY_API_KEY;
    const reviewById = new Map<string, ReviewSummary>();
    if (pplxKey) {
      const tasks: Array<Promise<void>> = [];
      for (const r of placeResults) {
        const top = [...r.places]
          .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
          .slice(0, 5);
        for (const p of top) {
          tasks.push(
            fetchReviewSummary(p.name, data.city, pplxKey).then((s) => {
              if (s && s.sourceCount > 0) reviewById.set(p.placeId, s);
            }),
          );
        }
      }
      await Promise.all(tasks);
    }

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
          realWorldReviews: reviewById.get(p.placeId) ?? null,
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
- 菜品偏好：${data.dishPreferences.join("、") || "无"}

候选数据（JSON）：
${JSON.stringify(candidatesForPrompt, null, 2)}

铁律：
- **只能使用候选列表里的 placeId**，禁止虚构 placeId、禁止编造店名。
- **硬条件是入选门槛**：对每个候选，先逐条核对 hardFilters。任何一条不满足或无法从候选数据确认满足，必须设置 hardFilterPass=false，并在 hardFilterViolations 列出违反/无法确认的硬条件原文。**hardFilterPass=false 的候选不要放进 picks**。
- 如果某组所有候选都无法通过硬条件，请返回空 picks 数组，绝不"将就"输出。
- 仅当 hardFilterPass=true 时才输出该候选；每组按匹配度从高到低输出 1-3 家。
- 价格判断：候选的 priceLevel（$/$$/$$$/$$$$）若明显高于用户预算上限，视为违反硬条件。无 priceLevel 信息时，若用户给了明确预算上限，视为无法确认 → hardFilterPass=false。
- **realWorldReviews 优先**：当候选有 realWorldReviews（来自大众点评/小红书/Tabelog 等真实网评）时，**优先依据它判断匹配度**，而不是只看 Google 评分；commonComplaints 命中用户硬条件或避雷项 → hardFilterPass=false 或大幅扣分；reviewHighlights 与用户偏好/菜品偏好吻合 → 加分。
- **pros/cons 必须取真实素材**：有 realWorldReviews 时，pros 至少 2 条来自 reviewHighlights；cons 至少 1 条来自 commonComplaints（如 commonComplaints 为空则 cons 用候选其它弱点）。禁止"环境不错""值得一试"等空话。
- aiSummary: 2-3 句中文，结合用户偏好+真实网评说明为什么选它。有 realWorldReviews 时必须明示"网友提到…"。
- matchScore: 0-100；matchTier: perfect (92+) / high (80-91) / partial (<80)。
- matchDetails: 3-6 条短描述，每条带 status (ok/warn)。

输出 JSON：{ "groups": [{ "cuisine": "...", "picks": [{ "placeId": "...", "matchScore": 88, "matchTier": "high", "hardFilterPass": true, "hardFilterViolations": [], "aiSummary": "...", "pros": [...], "cons": [...], "matchDetails": [{ "label": "...", "status": "ok" }] }] }] }`;

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
            // 严格执行硬条件门槛：AI 标记不通过的直接剔除
            if (data.hardFilters.length > 0 && pick.hardFilterPass === false) return null;
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
              ratings: candidateRatings(p, reviewById.get(p.placeId) ?? null),
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

