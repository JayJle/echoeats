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
  resolvePhotoUrl,
  searchPlaces,
  type PlaceCandidate,
} from "./google-places.server";
import {
  isMainlandChinaCity,
  searchDianpingCuisine,
  type DianpingReview,
} from "./dianping.server";
import {
  expandCuisineQueries,
  filterByCuisineRelevance,
  type CuisineExpansion,
} from "./cuisine-expand.server";

// Perplexity 真实网评摘要
type ReviewSummary = {
  reviewHighlights: string[];
  commonComplaints: string[];
  sentiment: "positive" | "mixed" | "negative" | "unknown";
  sourceCount: number;
  sources: string[];
  dianpingRating: number | null;
  dianpingRatingSource: "dianping" | "xiaohongshu_mention" | "other" | "unknown";
  priceLevel: number | null;
  priceCurrency: string | null;
  priceContext: string | null;
};

const CURRENCY_ENUM = ["CNY", "JPY", "USD", "EUR", "HKD", "TWD", "KRW", "SGD", "GBP", "其它"] as const;

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: "¥",
  JPY: "¥",
  USD: "$",
  EUR: "€",
  HKD: "HK$",
  TWD: "NT$",
  KRW: "₩",
  SGD: "S$",
  GBP: "£",
};

const SOURCE_ENUM = ["大众点评", "小红书", "Tabelog", "Google Reviews", "Yelp", "其它"] as const;

// 把 Google Places 一手 reviews 转成 ReviewSummary（零幻觉，第一手数据）
function googleReviewsToSummary(p: PlaceCandidate): ReviewSummary | null {
  if (!p.reviews || p.reviews.length === 0) return null;
  const trim = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80);
  const highlights: string[] = [];
  const complaints: string[] = [];
  for (const r of p.reviews) {
    const t = trim(r.text);
    if (!t) continue;
    if (r.rating != null && r.rating <= 2) {
      if (complaints.length < 3) complaints.push(t);
    } else {
      if (highlights.length < 5) highlights.push(t);
    }
  }
  if (highlights.length === 0 && complaints.length === 0) return null;
  const sentiment: ReviewSummary["sentiment"] =
    complaints.length === 0
      ? "positive"
      : highlights.length === 0
        ? "negative"
        : complaints.length >= highlights.length
          ? "mixed"
          : "positive";
  return {
    reviewHighlights: highlights,
    commonComplaints: complaints,
    sentiment,
    sourceCount: p.reviews.length,
    sources: ["Google Reviews"],
    dianpingRating: null,
    dianpingRatingSource: "unknown",
    priceLevel: null,
    priceCurrency: null,
    priceContext: null,
  };
}

function mergeReviewSummaries(base: ReviewSummary, extra: ReviewSummary): ReviewSummary {
  const dedup = (arr: string[]) =>
    Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
  return {
    reviewHighlights: dedup([...base.reviewHighlights, ...extra.reviewHighlights]).slice(0, 8),
    commonComplaints: dedup([...base.commonComplaints, ...extra.commonComplaints]).slice(0, 5),
    sentiment: extra.sentiment !== "unknown" ? extra.sentiment : base.sentiment,
    sourceCount: base.sourceCount + extra.sourceCount,
    sources: Array.from(new Set([...base.sources, ...extra.sources])),
    dianpingRating: extra.dianpingRating ?? base.dianpingRating,
    dianpingRatingSource:
      extra.dianpingRating != null ? extra.dianpingRatingSource : base.dianpingRatingSource,
    priceLevel: extra.priceLevel ?? base.priceLevel,
    priceCurrency: extra.priceCurrency ?? base.priceCurrency,
    priceContext: extra.priceContext ?? base.priceContext,
  };
}

async function fetchReviewSummary(
  name: string,
  city: string,
  apiKey: string,
): Promise<ReviewSummary | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
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
- sources: **真正被你引用查到信息的平台**数组，从 ["大众点评","小红书","Tabelog","Google Reviews","Yelp","其它"] 里选。**没有真的去过该平台或没找到该店信息的，绝不要列**；找不到任何来源返回空数组 []。
- dianpingRating: 仅当你在大众点评店铺页或小红书帖子中**直接看到**该店的点评评分（0-5 分，例如 4.5）时返回该数字，最多保留一位小数。**找不到必须返回 null**，禁止根据"好评多/口碑好"等模糊信号自己估算或编造。
- dianpingRatingSource: 评分来源——"dianping"（来自大众点评）/"xiaohongshu_mention"（小红书帖子提到的点评分）/"other"（其它来源）/"unknown"（找不到，此时 dianpingRating 必须为 null）。
- priceLevel: 仅当你在大众点评"人均"、Tabelog"夜の予算/昼の予算/ランチ予算"、小红书帖子等里**直接看到**该店人均消费金额（数字）时返回该数字。例如大众点评"人均 ¥328"→ 返回 328。**找不到必须返回 null**，禁止根据"贵/便宜/性价比高"等模糊信号自己估算或编造。
- priceCurrency: 人均价对应的币种代码，从 ["CNY","JPY","USD","EUR","HKD","TWD","KRW","SGD","GBP","其它"] 里选；priceLevel=null 时返回 null。
- priceContext: 价格的上下文短语（≤20 字），如"晚餐人均""午市套餐""含酒水""夜の予算"。priceLevel=null 时返回 null。

如果找不到该店，sourceCount 设为 0、其它数组为空、sources=[]、dianpingRating=null、dianpingRatingSource="unknown"、priceLevel=null、priceCurrency=null、priceContext=null。只输出 JSON 对象。`,
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
                sources: {
                  type: "array",
                  items: { type: "string", enum: [...SOURCE_ENUM] },
                },
                dianpingRating: { type: ["number", "null"] },
                dianpingRatingSource: {
                  type: "string",
                  enum: ["dianping", "xiaohongshu_mention", "other", "unknown"],
                },
                priceLevel: { type: ["number", "null"] },
                priceCurrency: {
                  type: ["string", "null"],
                  enum: [...CURRENCY_ENUM, null],
                },
                priceContext: { type: ["string", "null"] },
              },
              required: [
                "reviewHighlights",
                "commonComplaints",
                "sentiment",
                "sourceCount",
                "sources",
                "dianpingRating",
                "dianpingRatingSource",
                "priceLevel",
                "priceCurrency",
                "priceContext",
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

    // 反幻觉：收集 Perplexity citation；0 citation 时不直接丢弃，而是标记 sourceCount=0、
    // sources=[]，让下游与 Google 一手 reviews 合并。仅当模型既无 citation 又没给出任何
    // highlights/complaints 时才视为彻底无证据丢弃。
    const rawCitations: unknown = json?.citations ?? json?.search_results ?? [];
    const citationUrls: string[] = Array.isArray(rawCitations)
      ? (rawCitations as unknown[])
          .map((c) => (typeof c === "string" ? c : (c as { url?: string })?.url))
          .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u))
      : [];

    const parsed = JSON.parse(content);
    const highlights = Array.isArray(parsed.reviewHighlights)
      ? parsed.reviewHighlights.slice(0, 5)
      : [];
    const complaints = Array.isArray(parsed.commonComplaints)
      ? parsed.commonComplaints.slice(0, 3)
      : [];

    if (citationUrls.length === 0 && highlights.length === 0 && complaints.length === 0) {
      console.warn(`[Perplexity] ${name}: no citations & no content → discard`);
      return null;
    }
    if (citationUrls.length === 0) {
      console.warn(`[Perplexity] ${name}: no citations but model returned content → keep with sourceCount=0`);
    }

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
    const rawPrice = parsed.priceLevel;
    const priceLevel =
      typeof rawPrice === "number" && rawPrice > 0 && rawPrice < 1_000_000
        ? Math.round(rawPrice)
        : null;
    const priceCurrency =
      priceLevel != null && typeof parsed.priceCurrency === "string" &&
      (CURRENCY_ENUM as readonly string[]).includes(parsed.priceCurrency)
        ? parsed.priceCurrency
        : null;
    const priceContext =
      priceLevel != null && typeof parsed.priceContext === "string"
        ? parsed.priceContext.slice(0, 30)
        : null;
    // 仅在有 citation 时认可 sources（按真实 citation 数为 sourceCount）
    const sources: string[] =
      citationUrls.length > 0 && Array.isArray(parsed.sources)
        ? Array.from(
            new Set(
              (parsed.sources as unknown[]).filter((s): s is string =>
                typeof s === "string" && (SOURCE_ENUM as readonly string[]).includes(s),
              ),
            ),
          )
        : [];
    return {
      reviewHighlights: highlights as string[],
      commonComplaints: complaints as string[],
      sentiment: ["positive", "mixed", "negative"].includes(parsed.sentiment) ? parsed.sentiment : "unknown",
      sourceCount: citationUrls.length,
      sources,
      dianpingRating: rating,
      dianpingRatingSource: rating == null ? "unknown" : ratingSource,
      priceLevel,
      priceCurrency,
      priceContext,
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
  photoUrls: z.array(z.string()),
});

const ResultsSchema = z.object({
  groups: z.array(
    z.object({
      cuisine: z.string(),
      restaurants: z.array(RestaurantSchema),
      partialRestaurants: z.array(RestaurantSchema).optional(),
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
  hardFilterChecks: z
    .array(
      z.object({
        filter: z.string(),
        status: z.enum(["ok", "unknown", "fail"]),
        note: z.string().optional(),
      }),
    )
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
  if (p.websiteUri) {
    const isDianpingShop = /dianping\.com\/shop\//i.test(p.websiteUri);
    links.push({
      label: isDianpingShop ? "大众点评店铺页" : "官网",
      url: p.websiteUri,
    });
  }

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

function formatPriceFromReview(review: ReviewSummary | null): string | null {
  if (!review || review.priceLevel == null) return null;
  const sym = review.priceCurrency ? CURRENCY_SYMBOL[review.priceCurrency] ?? "" : "";
  const amount = `${sym}${review.priceLevel}`;
  const ctx = review.priceContext ? `（${review.priceContext}，来自网评）` : "（来自网评）";
  return `${amount}${ctx}`;
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
  const priceFromReview = formatPriceFromReview(review);
  // 仅展示从网评直接抓到的人均；Google priceLevel ($/$$) 太粗，不展示以免误导。
  const priceScore = priceFromReview ?? null;
  return [
    { platform: "Google Maps", score },
    { platform: "大众点评", score: dpScore },
    { platform: "人均价格", score: priceScore },
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
    const useDianping = isMainlandChinaCity(data.city);
    const pplxKey = process.env.PERPLEXITY_API_KEY;

    if (!useDianping && !process.env.GOOGLE_PLACES_API_KEY) {
      return {
        groups: [],
        error: "服务未配置 Google Places API Key（GOOGLE_PLACES_API_KEY）",
        suggestions: [],
      };
    }
    if (useDianping && !pplxKey) {
      return {
        groups: [],
        error: "国内城市需要 Perplexity API Key 抓取大众点评数据，但未配置",
        suggestions: [],
      };
    }

    const reviewById = new Map<string, ReviewSummary>();
    const cuisineExpansions = new Map<string, CuisineExpansion>();
    let placeResults: Array<{
      cuisine: string;
      places: PlaceCandidate[];
      error: string | null;
    }>;

    if (useDianping) {
      // 国内城市：大众点评一手数据流（候选 + 网评一次拿到）
      const firecrawlKey = process.env.FIRECRAWL_API_KEY ?? null;
      const settled = await Promise.all(
        data.cuisines.map(async (cuisine) => {
          try {
            const expansion = await expandCuisineQueries({
              cuisine,
              city: data.city,
              language: "zh-CN",
              apiKey: aiKey,
            });
            cuisineExpansions.set(cuisine, expansion);
            const items = await searchDianpingCuisine({
              city: data.city,
              cuisine,
              cuisineSynonyms: expansion.synonyms,
              hardFilters: data.hardFilters,
              perplexityKey: pplxKey!,
              firecrawlKey,
            });
            const places: PlaceCandidate[] = [];
            for (const it of items) {
              places.push(it.candidate);
              if (it.review) {
                reviewById.set(it.candidate.placeId, it.review as ReviewSummary);
              }
            }
            return {
              cuisine,
              places,
              error: places.length ? null : "大众点评未返回候选",
            };
          } catch (e) {
            return {
              cuisine,
              places: [] as PlaceCandidate[],
              error: e instanceof Error ? e.message : String(e),
            };
          }
        }),
      );
      placeResults = settled;
    } else {
      // 海外城市：Google Places + Perplexity 网评（原流程）
      const language = guessLanguageCode(data.city);
      const region = guessRegionCode(data.city);

      const semanticSuffix = (() => {
        if (language === "ja") return "おすすめ";
        if (language === "zh-CN" || language === "zh-TW") return "推荐";
        return "best";
      })();
      placeResults = await Promise.all(
        data.cuisines.map(async (cuisine) => {
          const expansion = await expandCuisineQueries({
            cuisine,
            city: data.city,
            language,
            apiKey: aiKey,
          });
          cuisineExpansions.set(cuisine, expansion);
          const synQueries = expansion.synonyms
            .slice(0, 2)
            .map((s) => `${s} ${data.city}`);
          const queries = Array.from(
            new Set([
              `${expansion.primary} ${data.city}`,
              ...synQueries,
              `${expansion.primary} ${data.city} ${semanticSuffix}`,
            ]),
          );
          const settled = await Promise.allSettled(
            queries.map((query) =>
              searchPlaces({ query, language, region, maxResults: 20 }),
            ),
          );
          const merged = new Map<string, PlaceCandidate>();
          let firstError: string | null = null;
          for (const s of settled) {
            if (s.status === "fulfilled") {
              for (const p of s.value) if (!merged.has(p.placeId)) merged.set(p.placeId, p);
            } else if (!firstError) {
              firstError = s.reason instanceof Error ? s.reason.message : String(s.reason);
            }
          }
          const allPlaces = Array.from(merged.values());
          const places = filterByCuisineRelevance(allPlaces, expansion);
          return { cuisine, places, error: places.length ? null : firstError };
        }),
      );
    }

    const placesError = placeResults.find((r) => r.error)?.error;
    if (placesError && placeResults.every((r) => !r.places.length)) {
      return {
        groups: [],
        error: useDianping
          ? `大众点评检索失败：${placesError}`
          : `Google Places 调用失败：${placesError}`,
        suggestions: FALLBACK_SUGGESTIONS,
      };
    }

    const allHaveZero = placeResults.every((r) => r.places.length === 0);
    if (allHaveZero) {
      return {
        groups: [],
        error: useDianping
          ? `大众点评在「${data.city}」没找到符合的餐厅候选`
          : `Google Places 在「${data.city}」没有找到任何符合的餐厅候选`,
        suggestions: FALLBACK_SUGGESTIONS,
      };
    }

    // 海外城市：先把 Google Places 一手 reviews 作为基线证据塞入（零幻觉），
    // 再用 Perplexity 网评做补充合并；Perplexity 失败也不影响 pros/cons 显示。
    if (!useDianping) {
      for (const r of placeResults) {
        for (const p of r.places) {
          const baseline = googleReviewsToSummary(p);
          if (baseline) reviewById.set(p.placeId, baseline);
        }
      }
      if (pplxKey) {
        const tasks: Array<Promise<{ id: string; summary: ReviewSummary | null }>> = [];
        for (const r of placeResults) {
          const top = [...r.places]
            .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
            .slice(0, 10);
          for (const p of top) {
            tasks.push(
              fetchReviewSummary(p.name, data.city, pplxKey).then((s) => ({
                id: p.placeId,
                summary: s,
              })),
            );
          }
        }
        const settled = await Promise.allSettled(tasks);
        for (const s of settled) {
          if (s.status === "fulfilled" && s.value.summary) {
            const existing = reviewById.get(s.value.id);
            reviewById.set(
              s.value.id,
              existing ? mergeReviewSummaries(existing, s.value.summary) : s.value.summary,
            );
          }
        }
      }
    }

    const candidatesForPrompt = placeResults
      .filter((r) => r.places.length)
      .map((r) => ({
        cuisine: r.cuisine,
        candidates: r.places.map((p) => {
          const review = reviewById.get(p.placeId) ?? null;
          return {
            placeId: p.placeId,
            name: p.name,
            address: p.address,
            rating: p.rating,
            userRatingCount: p.userRatingCount,
            priceLevel: priceLevelLabel(p.priceLevel),
            priceFromReviews:
              review?.priceLevel != null
                ? {
                    amount: review.priceLevel,
                    currency: review.priceCurrency,
                    context: review.priceContext,
                  }
                : null,
            openNow: p.openNow,
            primaryType: p.primaryType,
            editorialSummary: p.editorialSummary,
            realWorldReviews: review,
          };
        }),
      }));

    const gateway = createLovableAiGatewayProvider(aiKey);
    const model = gateway("google/gemini-3-flash-preview");

    const hardFiltersList = data.hardFilters;
    const hardFiltersJson = JSON.stringify(hardFiltersList);

    const cuisineFidelityBlock = Array.from(cuisineExpansions.entries())
      .map(([c, exp]) => {
        const syn = exp.synonyms.length ? exp.synonyms.join("、") : "（无）";
        const neg = exp.negativeKeywords.length ? exp.negativeKeywords.join("、") : "（无）";
        return `- 「${c}」：本地化主词 = "${exp.primary}"；同义词 = ${syn}；反例（明显不是该料理）= ${neg}`;
      })
      .join("\n");

    const prompt = `你是 Echo Eats 的餐厅匹配分析师。下面是 Google Places 返回的真实候选餐厅，按料理分组。请根据用户需求，**尽可能多挑出符合的店（每组最多 15 家，不要刻意压缩数量；只要没有任何硬条件被证伪，都应纳入）**，并给出打分和理由。

用户需求：
- 城市：${data.city}
- 日期/时间：${data.dateTime}
- 硬条件（数组形式，下面 hardFilterChecks 必须**逐条且按相同顺序**对照）：${hardFiltersJson}
- 偏好：${data.softPreferences.join("；") || "无"}
- 避雷：${data.negativeFilters.join("；") || "无"}
- 菜品偏好：${data.dishPreferences.join("、") || "无"}

## 料理保真（最高优先级，先于其它硬条件）
本次每个分组的「料理类型」就是该组的 cuisine 字段。每个分组的本地化主词、同义词、反例如下：
${cuisineFidelityBlock || "（无额外扩展）"}
判定方法：检查候选的 name / primaryType / editorialSummary / realWorldReviews。
- 命中本组反例关键词且未命中本组主词/同义词 → **直接剔除，不进 picks 也不进 partial**。例如本组要"猪肉饭"但候选明显是鳗鱼饭/牛丼/海鲜丼，不要解释，剔除。
- 候选本身就是主菜的小店（招牌菜与本组料理一致）→ 优先纳入。
- 候选模糊（综合定食店、菜单不明）→ 允许保留，对应 matchDetails 标 warn 注明"未确认主营是否为${"${"}本组料理${"}"}"。
- 这条规则**不计入 hardFilterChecks 数组**（hardFilterChecks 仍严格等于 ${hardFiltersList.length} 条用户原始硬条件）。

候选数据（JSON）：
${JSON.stringify(candidatesForPrompt, null, 2)}

铁律：
- **只能使用候选列表里的 placeId**，禁止虚构 placeId、禁止编造店名。
- **hardFilterChecks 必须对每个候选逐条核对所有 ${hardFiltersList.length} 条硬条件**：长度严格等于 ${hardFiltersList.length}，filter 字段原文复述，status 取值：
    - "ok" = 候选数据/realWorldReviews 明确证实满足
    - "unknown" = 信息不足无法判断（既不能确认满足、也不能确认违反）
    - "fail" = 明确证实不满足
  note 字段（可选，≤30 字）写明依据，如"网评人均 ¥120 ≤ ¥150"或"无营业时间数据"。
- **任何一条 status="fail" 的候选不要放进 picks**。允许有 unknown 的候选进入 picks（前端会单独展示）。
- **fail / unknown 边界（严格执行，避免误剔）**：fail 仅在候选数据或 realWorldReviews **明确证伪**时使用（例：editorialSummary 写明"仅晚市营业"但用户要求午餐；commonComplaints 明确提到"不接受预约"但用户要求可预约）。一切"数据里没说"、"网评没提及"、"无法核实"、"凭店名/类型推测"的情况一律 **unknown**，禁止凭推测打 fail。宁可放进 partial 让用户自己核实，也不要错杀。
- 价格判断（重要）：
    1. 若候选有 priceFromReviews.amount 且与用户预算同币种 → 用它判断；超出 → fail；满足 → ok。
    2. 否则用 Google priceLevel：$$$$ 等明显远超用户预算 → fail；可比但模糊 → unknown。
    3. 货币不一致或无任何价格信息且用户给了预算上限 → unknown（不要 fail）。
- **realWorldReviews 优先**：当候选有 realWorldReviews 时，优先依据它判断匹配度，而不是只看 Google 评分；commonComplaints 命中用户避雷项 → 大幅扣分；reviewHighlights 与用户偏好/菜品偏好吻合 → 加分。
- **绝对禁止编造网评**：pros / cons / aiSummary 中提到的"网友评价"内容**只能**来自该候选的 realWorldReviews.reviewHighlights / commonComplaints 原文（可适当浓缩改写到 ≤ 25 字、提炼具体菜名/服务点，但不得新增事实）。**如果 realWorldReviews 为 null，或 reviewHighlights 与 commonComplaints 都为空**：pros 和 cons 必须为空数组 []；aiSummary 只能基于 Google 数据（rating、primaryType、editorialSummary、address），不准出现"网友说""口碑""评价"等字样，并在末尾注明"（暂无可信网评，仅基于 Google 数据）"。
- **pros/cons 必须取真实素材**：当 reviewHighlights 非空时，pros 至少 2 条（不超过可用条数）来自 reviewHighlights 的真实文本浓缩；当 commonComplaints 非空时，cons 至少 1 条来自 commonComplaints（为空则 cons 留空，不要瞎编）。禁止"环境不错""值得一试"等空话。Google Reviews 来源的 highlights 是顾客原文整句，必须提炼成短句（如"出品稳定、服务热情"而不是照抄一整段）。
- aiSummary: 2-3 句中文，结合用户偏好+真实网评说明为什么选它。有 realWorldReviews 时必须明示"网友提到…"。**如果 realWorldReviews.sources 包含「大众点评」或「小红书」**，在 aiSummary 末尾追加一个轻提示括号，如「（综合大众点评、小红书等网友评价）」，只列实际出现在 sources 里的平台。
- matchScore: 0-100；matchTier: perfect (92+) / high (80-91) / partial (<80)。含 unknown 的候选 matchTier 不能给 perfect。
- matchDetails: 3-6 条短描述，每条带 status (ok/warn)。**不要在这里重复 hardFilterChecks 的内容**（系统会自动合并），只写硬条件之外的亮点/注意事项。**严格限定范围**：只能围绕用户实际提到的需求（hardFilters / softPreferences / negativeFilters / dishPreferences）来写。**绝对禁止**对用户没有提到的维度发出 warn 或提醒——例如用户没提预算/价格，就不准出现"价格偏高""人均较贵""超出预算"之类的条目；用户没提氛围，就不准提"氛围一般"；用户没提服务，就不准提"服务慢"。如果某维度用户没提，哪怕网评有相关吐槽，也只能放进 cons，不能进 matchDetails。

输出 JSON：{ "groups": [{ "cuisine": "...", "picks": [{ "placeId": "...", "matchScore": 88, "matchTier": "high", "hardFilterChecks": [{"filter":"...","status":"ok","note":"..."}], "aiSummary": "...", "pros": [...], "cons": [...], "matchDetails": [{ "label": "...", "status": "ok" }] }] }] }`;

    let ranking: z.infer<typeof AiRankingSchema>;
    try {
      const result = await generateText({
        model,
        prompt,
        maxOutputTokens: 10000,
        output: Output.object({
          schema: AiRankingSchema,
          name: "echo_eats_ranking",
          description: "AI ranking of real Google Places restaurant candidates",
        }),
      });
      ranking = result.output;
    } catch (e) {
      const firstErr = e instanceof Error ? e.message : String(e);
      console.warn(`[Echo/AI-rank] Output.object failed (${firstErr}), retrying with raw text…`);
      // 兜底：用原始文本生成 + 正则抽 JSON 再 zod 校验。
      // Gemini 偶尔会输出多余前后缀文字导致 Output.object 解析失败。
      try {
        const fallback = await generateText({
          model,
          prompt:
            prompt +
            `\n\n再次强调：你的回复必须是**纯 JSON**，不要 markdown 代码块、不要前后说明文字、不要 \`\`\`json 包裹。直接以 { 开头、以 } 结尾。`,
          maxOutputTokens: 10000,
        });
        const text = fallback.text || "";
        const jsonText = (() => {
          const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
          if (fenced) return fenced[1].trim();
          const m = text.match(/\{[\s\S]*\}/);
          return m ? m[0] : text;
        })();
        const parsed = JSON.parse(jsonText);
        ranking = AiRankingSchema.parse(parsed);
        console.log(`[Echo/AI-rank] fallback parse succeeded`);
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        console.error(`[Echo/AI-rank] fallback also failed: ${msg}`);
        return {
          groups: [],
          error: `AI 排序失败：${firstErr}`,
          suggestions: FALLBACK_SUGGESTIONS,
        };
      }
    }

    // 3. 合并 AI picks 与真实 Place 数据
    const placeById = new Map<string, { cuisine: string; place: PlaceCandidate }>();
    for (const r of placeResults) {
      for (const p of r.places) placeById.set(p.placeId, { cuisine: r.cuisine, place: p });
    }

    const placeByRestaurantId = new Map<string, PlaceCandidate>();
    const groups = data.cuisines
      .map((cuisine) => {
        const aiGroup =
          ranking.groups.find((g) => g.cuisine.toLowerCase() === cuisine.toLowerCase()) ??
          ranking.groups.find((g) => g.cuisine === cuisine);
        const picks = (aiGroup?.picks ?? []).slice(0, 20);

        type Bucket = "ok" | "partial" | null;

        const built = picks
          .map((pick, idx) => {
            const entry = placeById.get(pick.placeId);
            if (!entry) return null; // AI 编了 placeId
            const p = entry.place;

            // 规范化 hardFilterChecks：长度对齐、缺失视为 unknown
            const checksByFilter = new Map<string, { status: "ok" | "unknown" | "fail"; note?: string }>();
            for (const c of pick.hardFilterChecks ?? []) {
              checksByFilter.set(c.filter, { status: c.status, note: c.note });
            }
            const checks = data.hardFilters.map((f) => {
              const c = checksByFilter.get(f);
              return c ?? { status: "unknown" as const, note: undefined as string | undefined };
            });

            // 任何 fail → 剔除
            if (checks.some((c) => c.status === "fail")) return null;

            const hasUnknown = checks.some((c) => c.status === "unknown");
            const bucket: Bucket = hasUnknown ? "partial" : "ok";

            const score = Math.round(pick.matchScore);
            let tier =
              pick.matchTier === "perfect" || pick.matchTier === "high" || pick.matchTier === "partial"
                ? pick.matchTier
                : tierFromScore(score);
            // 含 unknown 的不允许 perfect
            if (hasUnknown && tier === "perfect") tier = "high";

            // 硬条件 detail 置顶
            const hardDetails = data.hardFilters.map((f, i) => {
              const c = checks[i];
              const noteSuffix = c.note ? ` — ${c.note}` : "";
              if (c.status === "ok") {
                return { label: `✓ 硬条件：${f}${noteSuffix}`, status: "ok" as const };
              }
              return { label: `？ 硬条件待核实：${f}${noteSuffix}`, status: "warn" as const };
            });
            const aiDetails = (pick.matchDetails ?? []).slice(0, 6);
            const matchDetails = [...hardDetails, ...aiDetails].slice(0, 8);

            const review = reviewById.get(p.placeId) ?? null;
            const restaurant = {
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
              ratings: candidateRatings(p, review),
              aiSummary: pick.aiSummary?.trim() ||
                `${p.name} 位于 ${p.address || data.city}，${p.rating != null ? `Google 评分 ${p.rating.toFixed(1)}` : "暂无评分"}。`,
              matchDetails,
              pros: pick.pros,
              cons: pick.cons,
              links: buildLinks(p, data.city),
              photoUrls: [] as string[],
            };
            placeByRestaurantId.set(restaurant.id, p);
            return { bucket, restaurant };
          })
          .filter((r): r is NonNullable<typeof r> => Boolean(r));

        const sortByScore = (a: { restaurant: { matchScore: number } }, b: { restaurant: { matchScore: number } }) =>
          b.restaurant.matchScore - a.restaurant.matchScore;
        const restaurants = built
          .filter((b) => b.bucket === "ok")
          .sort(sortByScore)
          .map((b) => b.restaurant)
          .slice(0, 15);
        const partialRestaurants = built
          .filter((b) => b.bucket === "partial")
          .sort(sortByScore)
          .map((b) => b.restaurant)
          .slice(0, 15);

        if (!restaurants.length && !partialRestaurants.length) return null;
        return {
          cuisine,
          restaurants,
          ...(partialRestaurants.length ? { partialRestaurants } : {}),
        };
      })
      .filter((g): g is NonNullable<typeof g> => Boolean(g));

    if (!groups.length) {
      return {
        groups: [],
        error: "AI 在真实候选中没有挑出匹配的餐厅，请放宽条件或换一个料理类型重试。",
        suggestions: FALLBACK_SUGGESTIONS,
      };
    }

    // Resolve Google photo URLs for displayed restaurants in parallel
    const allRestaurants = groups.flatMap((g) => [
      ...g.restaurants,
      ...(g.partialRestaurants ?? []),
    ]);
    await Promise.all(
      allRestaurants.map(async (r) => {
        const p = placeByRestaurantId.get(r.id);
        const names = (p?.photoNames ?? []).slice(0, 6);
        if (!names.length) return;
        const urls = await Promise.all(names.map((n) => resolvePhotoUrl(n, 800)));
        r.photoUrls = urls.filter((u): u is string => Boolean(u));
      }),
    );

    const missing = data.cuisines.filter(
      (c) => !groups.some((g) => g.cuisine.toLowerCase() === c.toLowerCase()),
    );
    return {
      groups: ResultsSchema.parse({ groups }).groups,
      error: missing.length ? `没有找到「${missing.join("、")}」的可靠候选` : null,
      suggestions: missing.length ? FALLBACK_SUGGESTIONS : [],
    };
  });

