// 大众点评数据源（国内城市专用）
// 通过 Perplexity sonar（限定 site:dianping.com）获取候选，再用 Firecrawl
// 抓取 top 5 详情页增强评论内容。返回 PlaceCandidate + ReviewSummary
// 兼容形状，让 echo.functions.ts 现有 AI ranking 流程零改动复用。

import type { PlaceCandidate } from "./google-places.server";

export type DianpingReview = {
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

export type DianpingCandidate = {
  candidate: PlaceCandidate;
  review: DianpingReview | null;
};

type RawShop = {
  name: string;
  address: string | null;
  dianpingUrl: string | null;
  rating: number | null;
  perCapita: number | null;
  highlightDishes: string[];
  highlights: string[];
  complaints: string[];
  hours: string | null;
  district: string | null;
};

const PPLX_TIMEOUT_MS = 25_000;
const FIRECRAWL_TIMEOUT_MS = 20_000;

function safeId(input: string, fallback: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 60);
  return cleaned || fallback;
}

async function fetchDianpingShopsViaPerplexity(opts: {
  city: string;
  cuisine: string;
  hardFilters: string[];
  apiKey: string;
}): Promise<RawShop[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PPLX_TIMEOUT_MS);
  try {
    const hardFiltersText = opts.hardFilters.length
      ? `\n用户硬性需求（请在筛选时尽量考虑，但不要因此减少结果数量）：${opts.hardFilters.join("；")}`
      : "";
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "sonar",
        // 不限制 search_domain_filter — 大众点评本身反爬严格，Perplexity 索引很少；
        // 改为优先大众点评 + 美食榜单/小红书等中文媒体兜底
        search_recency_filter: "year",
        max_tokens: 3500,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "你是中文美食信息采集助手。优先采用大众点评（dianping.com）数据；若大众点评页面无法访问，可以参考美团、小红书、知乎、橘子娱乐、Time Out、米其林指南等可信中文来源。不许凭空编造店名。只输出 JSON。",
          },
          {
            role: "user",
            content: `检索「${opts.city}」的「${opts.cuisine}」餐厅，返回 12-15 家本地真实存在、口碑较好的店。优先用大众点评数据，找不到时可参考其它中文美食媒体。${hardFiltersText}

每家店给出（**所有字段必须直接来自大众点评页面，不要凭推测**）：
- name: 店名（中文原名）
- address: 完整地址（含商圈/路名/门牌），找不到返回 null
- dianpingUrl: 该店在大众点评的店铺详情页 URL（形如 https://www.dianping.com/shop/XXXXXXXX 或 https://www.dianping.com/${opts.city}/ch10/...）；找不到返回 null
- rating: 大众点评星级评分（0-5，例如 4.5），找不到返回 null
- perCapita: 大众点评页面"人均"金额（人民币整数，例如 328），找不到返回 null
- highlightDishes: 招牌菜/推荐菜 2-5 个，没有返回 []
- highlights: 网友常提到的优点 2-4 条（具体，每条 ≤ 25 字），没有返回 []
- complaints: 网友常提到的缺点 0-3 条
- hours: 营业时间文字描述，找不到返回 null
- district: 所在商圈/区，例如"静安寺""国贸"，找不到返回 null

铁律：
- 只输出真实存在于大众点评的店，禁止编造。
- 尽可能多返回（目标 12-15 家），但宁缺毋滥。
- 评分和人均必须来自大众点评页面真实数字，不要根据"贵/便宜/口碑好"自行估算。

只输出 JSON。`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "dianping_shops",
            schema: {
              type: "object",
              properties: {
                shops: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      address: { type: ["string", "null"] },
                      dianpingUrl: { type: ["string", "null"] },
                      rating: { type: ["number", "null"] },
                      perCapita: { type: ["number", "null"] },
                      highlightDishes: { type: "array", items: { type: "string" } },
                      highlights: { type: "array", items: { type: "string" } },
                      complaints: { type: "array", items: { type: "string" } },
                      hours: { type: ["string", "null"] },
                      district: { type: ["string", "null"] },
                    },
                    required: [
                      "name",
                      "address",
                      "dianpingUrl",
                      "rating",
                      "perCapita",
                      "highlightDishes",
                      "highlights",
                      "complaints",
                      "hours",
                      "district",
                    ],
                  },
                },
              },
              required: ["shops"],
            },
          },
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[Dianping/PPLX] ${opts.cuisine}@${opts.city}: HTTP ${res.status} ${text.slice(0, 200)}`,
      );
      return [];
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) {
      console.warn(`[Dianping/PPLX] ${opts.cuisine}@${opts.city}: empty content`);
      return [];
    }
    let parsed: { shops?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          console.warn(`[Dianping/PPLX] ${opts.cuisine}@${opts.city}: JSON parse fail. content=${content.slice(0, 300)}`);
          return [];
        }
      } else {
        console.warn(`[Dianping/PPLX] ${opts.cuisine}@${opts.city}: no JSON. content=${content.slice(0, 300)}`);
        return [];
      }
    }
    if (!parsed?.shops || !Array.isArray(parsed.shops)) {
      console.warn(`[Dianping/PPLX] ${opts.cuisine}@${opts.city}: no shops. parsed=${JSON.stringify(parsed).slice(0, 300)}`);
      return [];
    }
    console.log(`[Dianping/PPLX] ${opts.cuisine}@${opts.city}: got ${parsed.shops.length} shops`);
    const out: RawShop[] = [];
    for (const raw of parsed.shops) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name.trim() : "";
      if (!name) continue;
      out.push({
        name,
        address: typeof r.address === "string" && r.address.trim() ? r.address.trim() : null,
        dianpingUrl:
          typeof r.dianpingUrl === "string" && /^https?:\/\//i.test(r.dianpingUrl)
            ? r.dianpingUrl
            : null,
        rating:
          typeof r.rating === "number" && r.rating >= 0 && r.rating <= 5
            ? Math.round(r.rating * 10) / 10
            : null,
        perCapita:
          typeof r.perCapita === "number" && r.perCapita > 0 && r.perCapita < 100_000
            ? Math.round(r.perCapita)
            : null,
        highlightDishes: Array.isArray(r.highlightDishes)
          ? (r.highlightDishes.filter((x) => typeof x === "string") as string[]).slice(0, 5)
          : [],
        highlights: Array.isArray(r.highlights)
          ? (r.highlights.filter((x) => typeof x === "string") as string[]).slice(0, 5)
          : [],
        complaints: Array.isArray(r.complaints)
          ? (r.complaints.filter((x) => typeof x === "string") as string[]).slice(0, 3)
          : [],
        hours: typeof r.hours === "string" && r.hours.trim() ? r.hours.trim() : null,
        district:
          typeof r.district === "string" && r.district.trim() ? r.district.trim() : null,
      });
    }
    return out;
  } catch (e) {
    console.warn(
      `[Dianping/PPLX] ${opts.cuisine}@${opts.city}:`,
      e instanceof Error ? e.message : e,
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Firecrawl scrape 大众点评店铺页，提取 markdown 后挑出额外评论 / 缺点
async function enrichShopWithFirecrawl(
  shop: RawShop,
  apiKey: string,
): Promise<{ extraHighlights: string[]; extraComplaints: string[] } | null> {
  if (!shop.dianpingUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        url: shop.dianpingUrl,
        formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 1500,
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const md: string | undefined =
      (json?.data?.markdown as string | undefined) ??
      (json?.markdown as string | undefined);
    if (!md || md.length < 100) return null;

    // 简单从 markdown 抽取"含'好/赞/不错/推荐/喜欢'的短句"作为亮点
    // 含 "差/慢/贵/不行/吵/拥挤/失望" 作为吐槽
    const lines = md
      .split(/\r?\n/)
      .map((l) => l.replace(/[*_`#>\\\-\[\]\(\)!]/g, "").trim())
      .filter((l) => l.length >= 4 && l.length <= 60);
    const seenH = new Set<string>();
    const seenC = new Set<string>();
    const extraHighlights: string[] = [];
    const extraComplaints: string[] = [];
    for (const l of lines) {
      if (extraHighlights.length < 3 && /[好赞棒爱推荐惊艳值得地道精致]/.test(l) && !seenH.has(l)) {
        seenH.add(l);
        extraHighlights.push(l.slice(0, 25));
      }
      if (extraComplaints.length < 2 && /[差慢贵失望不行难吃吵拥挤一般踩雷]/.test(l) && !seenC.has(l)) {
        seenC.add(l);
        extraComplaints.push(l.slice(0, 25));
      }
      if (extraHighlights.length >= 3 && extraComplaints.length >= 2) break;
    }
    return { extraHighlights, extraComplaints };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function shopToCandidate(shop: RawShop, city: string, idx: number): PlaceCandidate {
  // 用稳定的人造 placeId（PlaceCandidate 形状要求）
  const placeId = `dp-${safeId(shop.name, String(idx))}-${idx}`;
  const mapsQuery = encodeURIComponent(`${shop.name} ${shop.address || city}`);
  return {
    placeId,
    name: shop.name,
    address: shop.address || "",
    rating: shop.rating,
    userRatingCount: null,
    priceLevel: null, // 大众点评走 review.priceLevel（人民币人均），不用 Google $/$$
    openNow: null,
    websiteUri: shop.dianpingUrl,
    googleMapsUri: `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`,
    primaryType: shop.district ? `${shop.district} · 大众点评` : "大众点评",
    editorialSummary: [
      shop.highlightDishes.length ? `招牌：${shop.highlightDishes.join("、")}` : null,
      shop.hours ? `营业：${shop.hours}` : null,
    ]
      .filter(Boolean)
      .join("；") || null,
    location: null,
  };
}

function shopToReview(shop: RawShop, extra?: { extraHighlights: string[]; extraComplaints: string[] } | null): DianpingReview {
  const highlights = [
    ...shop.highlights,
    ...(shop.highlightDishes.length ? [`招牌：${shop.highlightDishes.slice(0, 3).join("、")}`] : []),
    ...(extra?.extraHighlights ?? []),
  ];
  const dedupedH = Array.from(new Set(highlights)).slice(0, 5);
  const complaints = Array.from(
    new Set([...shop.complaints, ...(extra?.extraComplaints ?? [])]),
  ).slice(0, 3);
  const sentiment: DianpingReview["sentiment"] =
    complaints.length === 0 && dedupedH.length > 0
      ? "positive"
      : complaints.length > 0 && dedupedH.length > 0
        ? "mixed"
        : dedupedH.length === 0
          ? "unknown"
          : "positive";
  return {
    reviewHighlights: dedupedH,
    commonComplaints: complaints,
    sentiment,
    sourceCount: dedupedH.length + complaints.length > 0 ? 1 : 0,
    sources: ["大众点评"],
    dianpingRating: shop.rating,
    dianpingRatingSource: shop.rating != null ? "dianping" : "unknown",
    priceLevel: shop.perCapita,
    priceCurrency: shop.perCapita != null ? "CNY" : null,
    priceContext: shop.perCapita != null ? "大众点评人均" : null,
  };
}

export async function searchDianpingCuisine(opts: {
  city: string;
  cuisine: string;
  hardFilters: string[];
  perplexityKey: string;
  firecrawlKey: string | null;
}): Promise<DianpingCandidate[]> {
  const shops = await fetchDianpingShopsViaPerplexity({
    city: opts.city,
    cuisine: opts.cuisine,
    hardFilters: opts.hardFilters,
    apiKey: opts.perplexityKey,
  });
  if (!shops.length) return [];

  // 去重（按店名）
  const seen = new Set<string>();
  const dedup: RawShop[] = [];
  for (const s of shops) {
    const key = s.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(s);
  }

  // Firecrawl 增强 top 5（按评分降序，需有 dianpingUrl）
  let extras: Map<string, { extraHighlights: string[]; extraComplaints: string[] }> = new Map();
  if (opts.firecrawlKey) {
    const top5 = [...dedup]
      .filter((s) => s.dianpingUrl)
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, 5);
    const settled = await Promise.allSettled(
      top5.map(async (s) => ({
        name: s.name,
        result: await enrichShopWithFirecrawl(s, opts.firecrawlKey!),
      })),
    );
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value.result) {
        extras.set(r.value.name, r.value.result);
      }
    }
  }

  return dedup.map((shop, idx) => ({
    candidate: shopToCandidate(shop, opts.city, idx),
    review: shopToReview(shop, extras.get(shop.name)),
  }));
}

// 中国大陆城市判定：含中文字符 + 不在港澳台/日韩英文/中文白名单中
const NON_MAINLAND_CITY_PATTERNS = [
  // 港澳台
  /香港|澳门|台湾|台北|高雄|台中|台南|新北|桃园/i,
  /hong\s*kong|macau|taipei|taiwan|kaohsiung/i,
  // 日本
  /日本|东京|京都|大阪|名古屋|札幌|福冈|横滨|神户|奈良|冲绳/i,
  /tokyo|kyoto|osaka|nagoya|sapporo|fukuoka|yokohama|kobe|nara|okinawa|japan/i,
  // 韩国
  /韩国|首尔|釜山|济州/i,
  /korea|seoul|busan|jeju/i,
  // 新加坡 / 马来西亚等东南亚常见中文表达
  /新加坡|吉隆坡|曼谷|马来西亚|泰国|越南|河内|胡志明/i,
  /singapore|kuala\s*lumpur|bangkok|thailand|vietnam|hanoi|ho\s*chi\s*minh/i,
];

export function isMainlandChinaCity(city: string): boolean {
  const trimmed = city.trim();
  if (!trimmed) return false;
  // 必须含中文字符，否则不算（北京 ✓ / Tokyo ✗）
  if (!/[\u4e00-\u9fff]/.test(trimmed)) return false;
  // 排除港澳台/日韩等中文写法
  for (const pat of NON_MAINLAND_CITY_PATTERNS) {
    if (pat.test(trimmed)) return false;
  }
  return true;
}
