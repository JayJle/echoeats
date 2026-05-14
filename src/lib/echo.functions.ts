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
  if (!name) return null;

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
  const restaurants = restaurantValues.map(normalizeDraftRestaurant).filter((item): item is SearchDraftRestaurant => Boolean(item));
  if (!restaurants.length) return null;
  return {
    cuisine: getStringField(value, ["cuisine", "cuisineType", "category", "料理", "料理类型"]) ?? fallbackCuisine,
    restaurants,
  };
}

function toSearchDraft(value: unknown, cuisines: string[]): SearchDraft {
  const root = Array.isArray(value) ? { groups: value } : value;
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

  const restaurants = directRestaurants
    ?.map(normalizeDraftRestaurant)
    .filter((item): item is SearchDraftRestaurant => Boolean(item));

  const candidate = {
    groups: groups?.length
      ? groups
      : restaurants?.length
        ? [{ cuisine: cuisines[0] ?? "推荐", restaurants }]
        : [],
  };

  const parsed = SearchDraftSchema.safeParse(candidate);
  if (!parsed.success || !parsed.data.groups.length) {
    throw new Error("AI 没有返回可用餐厅，请换一个城市或减少料理类型后重试");
  }
  return parsed.data;
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

function normalizeLinks(raw: SearchDraftRestaurant["links"], name: string, city: string) {
  const query = encodeURIComponent(`${name} ${city}`);
  const links =
    raw
      ?.map((link) => ({
        label: safeText(link.label, "平台搜索"),
        url: safeText(link.url, ""),
      }))
      .filter((link) => /^https?:\/\//.test(link.url)) ?? [];

  return links.length >= 2
    ? links.slice(0, 4)
    : [
        { label: "Google Maps", url: `https://www.google.com/maps/search/?api=1&query=${query}` },
        { label: "Google Search", url: `https://www.google.com/search?q=${query}` },
      ];
}

function normalizeResults(draft: SearchDraft, data: z.infer<typeof ParsedSchema>) {
  const sourceGroups = Array.isArray(draft.groups) ? draft.groups : [];
  const groups = data.cuisines.map((cuisine, groupIndex) => {
    const group =
      sourceGroups.find((item) => item.cuisine?.toLowerCase() === cuisine.toLowerCase()) ??
      sourceGroups[groupIndex];
    if (!group?.restaurants?.length) {
      throw new Error(`AI 没有为「${cuisine}」返回具体餐厅，请调整条件后重试`);
    }
    const restaurants = group.restaurants.slice(0, 3);

    return {
      cuisine,
      restaurants: restaurants.map((restaurant, index) => {
        const name = safeText(restaurant.name, "");
        if (!name || /推荐候选|candidate/i.test(name)) {
          throw new Error(`AI 返回了无效餐厅名称，请重新搜索`);
        }
        const score = normalizeScore(restaurant.matchScore, 88 - index * 4);
        const explicitTier = restaurant.matchTier;
        const matchTier =
          explicitTier === "perfect" || explicitTier === "high" || explicitTier === "partial"
            ? explicitTier
            : tierFromScore(score);

        return {
          id: slugify(String(restaurant.id ?? `${cuisine}-${name}-${index + 1}`)) || `restaurant-${groupIndex}-${index}`,
          name,
          localName: safeText(restaurant.localName, name),
          cuisine,
          matchScore: score,
          matchTier,
          openNow: normalizeBoolean(restaurant.openNow, true),
          reservable: normalizeBoolean(restaurant.reservable, true),
          ratings: normalizeRatings(restaurant.ratings),
          aiSummary: safeText(
            restaurant.aiSummary,
            `这家店与 ${data.city} 的 ${cuisine} 需求匹配度较高，适合作为当前条件下的优先候选。建议点开平台链接确认最新营业时间与预约情况。`,
          ),
          matchDetails:
            restaurant.matchDetails?.length
              ? restaurant.matchDetails.slice(0, 7).map((detail) => ({
                  label: safeText(detail.label, "符合当前搜索条件"),
                  status: detail.status === "warn" ? "warn" : "ok",
                }))
              : [
                  { label: `位于 ${data.city}`, status: "ok" as const },
                  { label: `符合 ${cuisine} 料理需求`, status: "ok" as const },
                  { label: "请在平台确认实时营业状态", status: "warn" as const },
                ],
          pros: safeList(restaurant.pros, ["匹配当前口味方向", "适合作为优先比较对象"]),
          cons: safeList(restaurant.cons, ["热门时段可能需要等待", "平台信息需以实时页面为准"]),
          links: normalizeLinks(restaurant.links, name, data.city),
        };
      }),
    };
  });

  return ResultsSchema.parse({ groups }).groups;
}

export const searchRestaurants = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ParsedSchema.parse(input))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("google/gemini-3-flash-preview");

    const prompt = `你是 Echo Eats 的餐厅推荐引擎。基于以下结构化需求，给出最匹配的真实餐厅候选清单。

城市：${data.city}
料理：${data.cuisines.join("、")}
日期/时间：${data.dateTime}
硬条件：${data.hardFilters.join("；") || "无"}
偏好：${data.softPreferences.join("；") || "无"}
避雷：${data.negativeFilters.join("；") || "无"}
菜品偏好：${data.dishPreferences.join("；") || "无"}
搜索策略：${data.searchStrategy.join("；") || "无"}

要求：
- 按"料理类型"分组（每个用户输入的料理类型一组）。
- 每组返回 1-3 家具体餐厅，必须给出真实餐厅名或看起来像真实店铺的完整店名，按 matchScore 降序。
- 禁止使用"推荐候选"、"餐厅候选"、"Restaurant Candidate"、"某某店"这类占位名称。
- name 用英文/罗马字，localName 用本地语言（日本=日文，中国=中文）。
- matchScore 0-100。matchTier：>=92 perfect, >=80 high, 其余 partial。
- ratings 包含 Google Maps / Tabelog / Yelp / 大众点评 / 美团 五项；不存在的平台 score 设为 null。日本店通常无大众点评/美团数据，中国店通常无 Tabelog。分数为字符串如 "4.5 / 5" 或 "3.68 / 5"。
- aiSummary 用一段中文解释推荐理由（2-3 句），结合用户的偏好与避雷。
- matchDetails 列出 5-7 条匹配点，status=ok 表示符合，warn 表示提醒（如"晚餐需提前预约"）。
- pros / cons 各 2-4 条简短中文。
- links 包含相关平台搜索链接（用 https://www.google.com/maps/search/?api=1&query=... 这类可点击 URL，至少 2 条）。
- id 用短小写英文 slug。
- openNow / reservable 设为合理值（多数为 true）。

只返回 JSON。`;

    try {
      const { output, finishReason } = await generateText({
        model,
        prompt,
        maxOutputTokens: 8000,
        output: Output.json({
          name: "restaurant_recommendation_groups",
          description: "Grouped Echo Eats restaurant recommendations that can be normalized before display",
        }),
      });
      if (finishReason === "length") {
        throw new Error("AI 输出被截断，请减少料理类型数量后重试");
      }
      return normalizeResults(toSearchDraft(output), data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`AI 推荐失败：${msg}`);
    }
  });
