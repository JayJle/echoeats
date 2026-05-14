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

const RestaurantSchema = z.object({
  id: z.string(),
  name: z.string(),
  localName: z.string(),
  cuisine: z.string(),
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

const SearchDraftRestaurantSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().min(1),
    localName: z.string().optional(),
    cuisine: z.string().optional(),
    matchScore: z.union([z.string(), z.number()]).optional(),
    matchTier: z.string().optional(),
    openNow: z.union([z.boolean(), z.string()]).optional(),
    reservable: z.union([z.boolean(), z.string()]).optional(),
    needsReview: z.union([z.boolean(), z.string()]).optional(),
    ratings: z
      .array(
        z.object({
          platform: z.string().optional(),
          score: z.union([z.string(), z.number(), z.null()]).optional(),
        }),
      )
      .optional(),
    aiSummary: z.string().optional(),
    matchDetails: z
      .array(
        z.object({
          label: z.string().optional(),
          status: z.string().optional(),
        }),
      )
      .optional(),
    pros: z.array(z.string()).optional(),
    cons: z.array(z.string()).optional(),
    links: z
      .array(
        z.object({
          label: z.string().optional(),
          url: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

const SearchDraftSchema = z
  .object({
    groups: z.array(
      z
        .object({
          cuisine: z.string().min(1),
          restaurants: z.array(SearchDraftRestaurantSchema).min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough();

type SearchDraft = z.infer<typeof SearchDraftSchema>;
type SearchDraftRestaurant = z.infer<typeof SearchDraftRestaurantSchema>;

const PLACEHOLDER_RE = /推荐候选|餐厅候选|候选\s*\d*$|restaurant\s*candidate|某某店|placeholder|示例/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function getArrayField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function looksLikeRestaurant(value: unknown) {
  if (!isRecord(value)) return false;
  return Boolean(getStringField(value, ["name", "restaurantName", "restaurant_name", "title", "店名", "餐厅名"]));
}

function normalizeDraftRestaurant(value: unknown): SearchDraftRestaurant | null {
  if (!isRecord(value)) return null;
  const name = getStringField(value, ["name", "restaurantName", "restaurant_name", "title", "店名", "餐厅名"]);
  if (!name || PLACEHOLDER_RE.test(name)) return null;

  return {
    ...value,
    id: value.id as SearchDraftRestaurant["id"],
    name,
    localName: getStringField(value, ["localName", "local_name", "nativeName", "native_name", "店铺原名", "本地名"]),
    cuisine: getStringField(value, ["cuisine", "cuisineType", "category", "料理", "料理类型"]),
    ratings: getArrayField(value, ["ratings", "platformRatings", "scores", "评分"]) as SearchDraftRestaurant["ratings"],
    matchDetails: getArrayField(value, ["matchDetails", "match_details", "details", "匹配详情"]) as SearchDraftRestaurant["matchDetails"],
    pros: getArrayField(value, ["pros", "advantages", "highlights", "优点", "好评"]) as SearchDraftRestaurant["pros"],
    cons: getArrayField(value, ["cons", "cautions", "weaknesses", "缺点", "差评"]) as SearchDraftRestaurant["cons"],
    links: getArrayField(value, ["links", "urls", "platformLinks", "链接"]) as SearchDraftRestaurant["links"],
  };
}

function normalizeDraftGroup(value: unknown, fallbackCuisine: string) {
  if (!isRecord(value)) return null;
  const restaurantValues = getArrayField(value, ["restaurants", "items", "recommendations", "results", "餐厅"]);
  if (!restaurantValues) return null;
  const restaurants = restaurantValues
    .map(normalizeDraftRestaurant)
    .filter((item): item is SearchDraftRestaurant => Boolean(item));
  if (!restaurants.length) return null;
  return {
    cuisine: getStringField(value, ["cuisine", "cuisineType", "category", "料理", "料理类型"]) ?? fallbackCuisine,
    restaurants,
  };
}

function toSearchDraft(value: unknown, cuisines: string[]): SearchDraft | null {
  const root = Array.isArray(value)
    ? value.some(looksLikeRestaurant)
      ? { restaurants: value }
      : { groups: value }
    : value;

  const groupCandidates = isRecord(root)
    ? getArrayField(root, ["groups", "cuisineGroups", "recommendations", "results", "餐厅推荐"])
    : undefined;
  const directRestaurants = isRecord(root)
    ? getArrayField(root, ["restaurants", "items", "餐厅"])
    : undefined;

  const groups = groupCandidates
    ?.map((item, index) =>
      looksLikeRestaurant(item)
        ? null
        : normalizeDraftGroup(item, cuisines[index] ?? cuisines[0] ?? "推荐"),
    )
    .filter((item): item is SearchDraft["groups"][number] => Boolean(item));

  const flatRestaurantCandidates = groupCandidates?.some(looksLikeRestaurant)
    ? groupCandidates
    : directRestaurants;
  const restaurants = flatRestaurantCandidates
    ?.map(normalizeDraftRestaurant)
    .filter((item): item is SearchDraftRestaurant => Boolean(item));

  const mappedGroups = isRecord(root)
    ? Object.entries(root)
        .filter(
          ([key, item]) =>
            Array.isArray(item) &&
            !["groups", "cuisineGroups", "recommendations", "results", "餐厅推荐", "restaurants", "items", "餐厅"].includes(
              key,
            ),
        )
        .map(([cuisine, items]) => normalizeDraftGroup({ cuisine, restaurants: items }, cuisine))
        .filter((item): item is SearchDraft["groups"][number] => Boolean(item))
    : [];

  const finalGroups = groups?.length
    ? groups
    : mappedGroups.length
      ? mappedGroups
      : restaurants?.length
        ? [{ cuisine: cuisines[0] ?? "推荐", restaurants }]
        : [];

  if (!finalGroups.length) return null;
  const parsed = SearchDraftSchema.safeParse({ groups: finalGroups });
  return parsed.success ? parsed.data : null;
}

function safeText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function safeList(value: unknown, fallback: string[]) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .map((item) => item.trim())
    : fallback;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function normalizeScore(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").match(/\d+(\.\d+)?/)?.[0]);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : fallback;
}

function tierFromScore(score: number): "perfect" | "high" | "partial" {
  if (score >= 92) return "perfect";
  if (score >= 80) return "high";
  return "partial";
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (["true", "yes", "open", "可", "是"].some((token) => lowered.includes(token))) return true;
    if (["false", "no", "closed", "不可", "否"].some((token) => lowered.includes(token))) return false;
  }
  return fallback;
}

function normalizeRatings(raw: SearchDraftRestaurant["ratings"]) {
  return PLATFORMS.map((platform) => {
    const found = raw?.find((rating) => rating.platform === platform);
    const score = found?.score;
    return { platform, score: score == null ? null : String(score) };
  });
}

function buildSearchLinks(name: string, localName: string, city: string) {
  // Prefer the original local-language name for searches — translated/romanized
  // names often miss on Google Maps / Tabelog / 大众点评.
  const primary = localName && localName !== name ? localName : name;
  const primaryQuery = encodeURIComponent(`${primary} ${city}`);
  const altQuery = encodeURIComponent(`${name} ${city}`);
  const looksJapanese =
    /[\u3040-\u30ff]/.test(primary) ||
    /tokyo|kyoto|osaka|japan|日本|东京|京都|大阪/i.test(city);
  const looksChinese = /[\u4e00-\u9fff]/.test(primary) && !looksJapanese;
  const links: { label: string; url: string }[] = [
    { label: "Google Maps", url: `https://www.google.com/maps/search/?api=1&query=${primaryQuery}` },
    { label: "Google 搜索", url: `https://www.google.com/search?q=${primaryQuery}` },
  ];
  if (primary !== name) {
    links.push({ label: "Google 搜索（英文名）", url: `https://www.google.com/search?q=${altQuery}` });
  }
  if (looksJapanese) {
    // site:tabelog.com 搜索更稳定,直接命中店铺详情页
    links.push({
      label: "Tabelog 搜索",
      url: `https://www.google.com/search?q=${encodeURIComponent(`site:tabelog.com ${primary} ${city}`)}`,
    });
  }
  if (looksChinese) {
    links.push({
      label: "大众点评搜索",
      url: `https://www.google.com/search?q=${encodeURIComponent(`site:dianping.com ${primary} ${city}`)}`,
    });
    links.push({
      label: "美团搜索",
      url: `https://www.google.com/search?q=${encodeURIComponent(`site:meituan.com ${primary} ${city}`)}`,
    });
  }
  return links;
}

function normalizeLinks(
  raw: SearchDraftRestaurant["links"],
  name: string,
  localName: string,
  city: string,
) {
  const aiLinks =
    raw
      ?.map((link) => ({
        label: safeText(link.label, "平台搜索"),
        url: safeText(link.url, ""),
      }))
      .filter((link) => /^https?:\/\//.test(link.url)) ?? [];

  const generated = buildSearchLinks(name, localName, city);
  // Merge: generated search links first (always reliable), then any extra AI URLs that aren't duplicates.
  const seen = new Set(generated.map((l) => l.url));
  for (const link of aiLinks) {
    if (!seen.has(link.url)) {
      generated.push(link);
      seen.add(link.url);
    }
  }
  return generated.slice(0, 6);
}

function normalizeResults(draft: SearchDraft, data: z.infer<typeof ParsedSchema>) {
  const sourceGroups = draft.groups;
  const groups = data.cuisines
    .map((cuisine, groupIndex) => {
      const group =
        sourceGroups.find((item) => item.cuisine?.toLowerCase() === cuisine.toLowerCase()) ??
        sourceGroups[groupIndex];
      if (!group?.restaurants?.length) return null;

      const restaurants = group.restaurants
        .slice(0, 3)
        .map((restaurant, index) => {
          const name = safeText(restaurant.name, "");
          if (!name || PLACEHOLDER_RE.test(name)) return null;

          const score = normalizeScore(restaurant.matchScore, 82 - index * 4);
          const explicitTier = restaurant.matchTier;
          const matchTier =
            explicitTier === "perfect" || explicitTier === "high" || explicitTier === "partial"
              ? explicitTier
              : tierFromScore(score);

          const ratings = normalizeRatings(restaurant.ratings);
          const hasAnyScore = ratings.some((r) => r.score);
          const needsReview = normalizeBoolean(restaurant.needsReview, !hasAnyScore);

          return {
            id:
              slugify(String(restaurant.id ?? `${cuisine}-${name}-${index + 1}`)) ||
              `restaurant-${groupIndex}-${index}`,
            name,
            localName: safeText(restaurant.localName, name),
            cuisine,
            matchScore: score,
            matchTier,
            openNow: normalizeBoolean(restaurant.openNow, true),
            reservable: normalizeBoolean(restaurant.reservable, true),
            needsReview,
            ratings,
            aiSummary: safeText(
              restaurant.aiSummary,
              `这家店与 ${data.city} 的 ${cuisine} 需求方向匹配。建议点开下方搜索链接确认最新评分、营业时间与预约情况。`,
            ),
            matchDetails: restaurant.matchDetails?.length
              ? restaurant.matchDetails.slice(0, 7).map((detail) => ({
                  label: safeText(detail.label, "符合当前搜索条件"),
                  status: detail.status === "warn" ? ("warn" as const) : ("ok" as const),
                }))
              : [
                  { label: `位于 ${data.city}`, status: "ok" as const },
                  { label: `符合 ${cuisine} 料理需求`, status: "ok" as const },
                  { label: "请在平台确认实时营业状态", status: "warn" as const },
                ],
            pros: safeList(restaurant.pros, ["匹配当前口味方向", "适合作为优先比较对象"]),
            cons: safeList(restaurant.cons, ["AI 信息可能不实时，请确认", "热门时段可能需要等待"]),
            links: normalizeLinks(restaurant.links, name, data.city),
          };
        })
        .filter((r): r is NonNullable<typeof r> => Boolean(r));

      if (!restaurants.length) return null;
      return { cuisine, restaurants };
    })
    .filter((g): g is NonNullable<typeof g> => Boolean(g));

  return ResultsSchema.parse({ groups }).groups;
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
    const key = process.env.LOVABLE_API_KEY;
    if (!key) {
      return { groups: [], error: "服务未配置 AI 凭据", suggestions: [] };
    }
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("google/gemini-3-flash-preview");

    const prompt = `你是 Echo Eats 的餐厅推荐分析师。Echo Eats 不是地图数据库，你只负责基于既有知识，推荐当地真实存在的、知名度足够的餐厅。

城市：${data.city}
料理：${data.cuisines.join("、")}
日期/时间：${data.dateTime}
硬条件：${data.hardFilters.join("；") || "无"}
偏好：${data.softPreferences.join("；") || "无"}
避雷：${data.negativeFilters.join("；") || "无"}
菜品偏好：${data.dishPreferences.join("；") || "无"}
搜索策略：${data.searchStrategy.join("；") || "无"}

诚实性原则（非常重要）：
- 不要假装做了实时网络搜索；基于你的知识推荐。
- 如果某个料理你没有真实店铺把握，宁可少返回也不要编造店名。
- 不要使用"推荐候选"、"餐厅候选"、"Restaurant Candidate"、"示例"、"某某店"等占位名称。
- 评分没有把握时 score 设为 null，绝不编造数字。
- 不要伪造店铺详情页 URL，链接交给前端生成搜索链接。

输出 JSON 结构：
{
  "groups": [
    {
      "cuisine": "原料理名（与输入一致）",
      "restaurants": [
        {
          "name": "罗马字/英文店名",
          "localName": "本地语言店名（日本=日文，中国=中文）",
          "matchScore": 0-100 数字,
          "matchTier": "perfect | high | partial",
          "openNow": true/false,
          "reservable": true/false,
          "needsReview": true/false（信息把握不大时为 true）,
          "ratings": [{ "platform": "Google Maps|Tabelog|Yelp|大众点评|美团", "score": "4.3 / 5" 或 null }],
          "aiSummary": "2-3 句中文，说明为什么匹配用户偏好",
          "matchDetails": [{ "label": "短描述", "status": "ok | warn" }],
          "pros": ["..."],
          "cons": ["..."]
        }
      ]
    }
  ]
}

每组返回 1-3 家具体的真实店铺。如果某料理你没有可靠候选，可以返回空 restaurants 数组（前端会显示提示）。只返回 JSON，不要包裹在 markdown 中。`;

    let output: unknown;
    let finishReason: string | undefined;
    try {
      const result = await generateText({
        model,
        prompt,
        maxOutputTokens: 8000,
        output: Output.json({
          name: "restaurant_recommendation_groups",
          description: "Echo Eats 餐厅推荐结果",
        }),
      });
      output = result.output;
      finishReason = result.finishReason;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        groups: [],
        error: `AI 调用失败：${msg}`,
        suggestions: FALLBACK_SUGGESTIONS,
      };
    }

    if (finishReason === "length") {
      return {
        groups: [],
        error: "AI 输出被截断，请减少同时搜索的料理类型后重试",
        suggestions: FALLBACK_SUGGESTIONS,
      };
    }

    const draft = toSearchDraft(output, data.cuisines);
    if (!draft) {
      return {
        groups: [],
        error: "AI 这次没有返回可靠的餐厅。可能是它对该城市/料理把握不够。",
        suggestions: FALLBACK_SUGGESTIONS,
      };
    }

    const groups = normalizeResults(draft, data);
    if (!groups.length) {
      return {
        groups: [],
        error: "AI 返回的餐厅都被反幻觉过滤掉了（占位名称或无效信息）。",
        suggestions: FALLBACK_SUGGESTIONS,
      };
    }

    const missing = data.cuisines.filter(
      (cuisine) => !groups.some((g) => g.cuisine.toLowerCase() === cuisine.toLowerCase()),
    );
    return {
      groups,
      error: missing.length ? `没有找到「${missing.join("、")}」的可靠候选` : null,
      suggestions: missing.length ? FALLBACK_SUGGESTIONS : [],
    };
  });
