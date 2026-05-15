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
const PPLX_SUMMARY_TIMEOUT_MS = 30_000;
const FIRECRAWL_TOP_N = 10; // A: expand from 5 → 10
const FIRECRAWL_REVIEW_PAGES = 3; // A: fetch first 3 pages of review_all
const PER_SHOP_HIGHLIGHT_CAP = 12;
const PER_SHOP_COMPLAINT_CAP = 8;

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

// 把任意大众点评店铺 URL 转成评论列表分页 URL
// 形如 https://www.dianping.com/shop/XXXX -> https://www.dianping.com/shop/XXXX/review_all/p{n}
function buildReviewPageUrls(dianpingUrl: string, pages: number): string[] {
  const m = dianpingUrl.match(/dianping\.com\/shop\/(\d+)/i);
  if (!m) {
    // 不是标准 /shop/ID 形式，就只抓原页
    return [dianpingUrl];
  }
  const shopId = m[1];
  const base = `https://www.dianping.com/shop/${shopId}`;
  const urls = [base];
  for (let p = 1; p <= pages; p++) {
    urls.push(`${base}/review_all${p > 1 ? `/p${p}` : ""}`);
  }
  return urls;
}

async function firecrawlScrapeMarkdown(url: string, apiKey: string): Promise<string | null> {
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
        url,
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
    return md && md.length >= 100 ? md : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// A: Firecrawl 抓 top N 店铺 + 每店多页评论，从 markdown 中抽取更多真实顾客留言
async function enrichShopWithFirecrawl(
  shop: RawShop,
  apiKey: string,
): Promise<{ extraHighlights: string[]; extraComplaints: string[]; rawComments: string[] } | null> {
  if (!shop.dianpingUrl) return null;

  const urls = buildReviewPageUrls(shop.dianpingUrl, FIRECRAWL_REVIEW_PAGES);
  const settled = await Promise.allSettled(urls.map((u) => firecrawlScrapeMarkdown(u, apiKey)));
  const mds: string[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) mds.push(r.value);
  }
  if (!mds.length) return null;

  const combinedMd = mds.join("\n\n");
  const lines = combinedMd
    .split(/\r?\n/)
    .map((l) => l.replace(/[*_`#>\\\-\[\]\(\)!]/g, "").trim())
    .filter((l) => l.length >= 6 && l.length <= 80);

  const seenH = new Set<string>();
  const seenC = new Set<string>();
  const seenRaw = new Set<string>();
  const extraHighlights: string[] = [];
  const extraComplaints: string[] = [];
  const rawComments: string[] = [];

  for (const l of lines) {
    // 收集明显像"用户留言"的句子（含中文，且非纯导航/分类）
    if (rawComments.length < 40 && /[\u4e00-\u9fff]/.test(l) && !/^[\u4e00-\u9fff]{1,4}$/.test(l) && !seenRaw.has(l)) {
      seenRaw.add(l);
      rawComments.push(l);
    }
    if (extraHighlights.length < PER_SHOP_HIGHLIGHT_CAP && /[好赞棒爱推荐惊艳值得地道精致香嫩鲜美味新鲜环境好服务好]/.test(l) && !seenH.has(l)) {
      seenH.add(l);
      extraHighlights.push(l.slice(0, 40));
    }
    if (extraComplaints.length < PER_SHOP_COMPLAINT_CAP && /[差慢贵失望不行难吃吵拥挤一般踩雷难等态度差排队久]/.test(l) && !seenC.has(l)) {
      seenC.add(l);
      extraComplaints.push(l.slice(0, 40));
    }
  }
  return { extraHighlights, extraComplaints, rawComments };
}

// B: 用 Perplexity sonar-pro 对单店做一次"网评倾向汇总"
// 直接给 shop 名 + 城市 + 已抓到的原始评论片段（如有），让模型聚合 ~20 条总结
async function summarizeShopReviewsViaPerplexity(opts: {
  shopName: string;
  city: string;
  rawComments: string[];
  apiKey: string;
}): Promise<{ pros: string[]; cons: string[] } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PPLX_SUMMARY_TIMEOUT_MS);
  try {
    const sample = opts.rawComments.slice(0, 30).join("\n");
    const userMsg = `店铺：${opts.shopName}（${opts.city}）

请从大众点评、美团、小红书、知乎等网评中，聚合这家店真实顾客的评价倾向。${sample ? `\n\n以下是已抓取到的部分原始片段（可作为参考，但不要照抄，要二次提炼）：\n${sample.slice(0, 3000)}` : ""}

请给出：
- pros: 8-12 条网友普遍称赞的点（每条 ≤ 25 字，具体到菜品/口味/环境/服务/性价比，不要空话）
- cons: 0-8 条网友常见吐槽（每条 ≤ 25 字，没有就给空数组）

只输出 JSON。`;
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "sonar-pro",
        search_recency_filter: "year",
        max_tokens: 1500,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "你是中文餐饮网评聚合助手。基于大众点评/美团/小红书/知乎等真实网评提炼倾向，禁止凭空编造，只输出 JSON。",
          },
          { role: "user", content: userMsg },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "shop_review_summary",
            schema: {
              type: "object",
              properties: {
                pros: { type: "array", items: { type: "string" } },
                cons: { type: "array", items: { type: "string" } },
              },
              required: ["pros", "cons"],
            },
          },
        },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) return null;
    let parsed: { pros?: unknown; cons?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    const pros = Array.isArray(parsed.pros)
      ? (parsed.pros.filter((x) => typeof x === "string") as string[]).slice(0, 12)
      : [];
    const cons = Array.isArray(parsed.cons)
      ? (parsed.cons.filter((x) => typeof x === "string") as string[]).slice(0, 8)
      : [];
    if (!pros.length && !cons.length) return null;
    return { pros, cons };
  } catch (e) {
    console.warn(
      `[Dianping/PPLX-summary] ${opts.shopName}@${opts.city}:`,
      e instanceof Error ? e.message : e,
    );
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
