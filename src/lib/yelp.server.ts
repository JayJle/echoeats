// Yelp 信息抓取层（US / CA / 西欧分支用）
// 架构完全复用 tabelog.server.ts：不直接爬 yelp（ToS + 反爬），用 Perplexity 代读 yelp.com
// 两阶段策略：
//   1) sonar + search_domain_filter=[yelp.com, yelp.fr, yelp.it, ...]
//   2) 兜底 sonar-pro + 显式 site:yelp.com 提示

export type YelpInfo = {
  rating: string | null; // 例 "4.3"
  reviewCount: number | null; // 例 1234
  url: string | null; // yelp.<tld>/biz/<slug>
  priceLevel: "$" | "$$" | "$$$" | "$$$$" | null;
  summary: string | null; // 1-2 句摘要（中文或英文，由 isEn 决定）
};

const cache = new Map<string, YelpInfo | null>();

// yelp 店铺详情页 URL：yelp.<tld>/biz/<slug>
// 兼容地区域名：yelp.com / yelp.fr / yelp.it / yelp.de / yelp.es / yelp.co.uk / yelp.ca
const YELP_SHOP_URL_RE = /https?:\/\/(?:www\.)?yelp\.[a-z.]{2,8}\/biz\/[a-z0-9\-_%]+/i;

const YELP_DOMAINS = [
  "yelp.com",
  "yelp.fr",
  "yelp.it",
  "yelp.de",
  "yelp.es",
  "yelp.co.uk",
  "yelp.ca",
];

// 从英文地址抽 city + state/region 提示
// 形如 "123 Main St, San Francisco, CA 94103, USA" → "San Francisco, CA"
// "12 Rue de Rivoli, 75001 Paris, France" → "Paris"
function extractArea(address: string, city: string): string {
  if (!address) return city;
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return city;
  // 找含 city 的片段及其后一片段（通常是 state/region）
  const lower = city.toLowerCase();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].toLowerCase().includes(lower)) {
      const region = parts[i + 1]?.replace(/\d{3,}.*$/, "").trim();
      return region ? `${city}, ${region}` : city;
    }
  }
  return city;
}

type Stage = "sonar" | "sonar-pro";

async function callPerplexity(opts: {
  apiKey: string;
  stage: Stage;
  name: string;
  address: string;
  city: string;
  area: string;
  isEn: boolean;
}): Promise<{ json: unknown; ok: boolean; status: number } | null> {
  const { apiKey, stage, name, address, city, area, isEn } = opts;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const isFirst = stage === "sonar";
    const summaryRule = isEn
      ? "1-2 sentences in English summarizing Yelp reviews (specific dishes/service/atmosphere), <= 80 chars. Unreadable -> null."
      : "1-2 句简体中文，归纳 Yelp 评论口碑（具体菜品/服务/氛围），≤ 60 字。读不到 → null。";

    const userPrompt = isFirst
      ? `查找 Yelp 上的店铺：
- 店名：${name}
- 地址：${address}
- 城市：${city}
- 地区提示：${area}

要求：
- 必须是 yelp.com / yelp.<地区域名> 上**真实存在**的店铺**详情页**（URL 形如 https://www.yelp.com/biz/<slug>）。**绝对不要返回搜索/列表/分类/排行榜页**。
- 店名和地址必须能合理对应；同名不同店一律算找不到，宁可全部返回 null。
- url: 找到即返回；即使评分/评论数/价位/摘要暂时读取不到，也照常返回 url。
- rating: Yelp 综合评分（数字字符串如 "4.3"，范围 0-5）。读不到 → null。
- reviewCount: 评论数（整数）。读不到 → null。
- priceLevel: "$" / "$$" / "$$$" / "$$$$" 之一（Yelp 页面 Price 字段，美元符号）。读不到 → null。
- summary: ${summaryRule}

只输出 JSON。找不到任何匹配店铺时，所有字段返回 null。`
      : `请用 Google 搜索 \`site:yelp.com "${name}" "${area || city}"\` 找到该店在 Yelp 的店铺详情页，然后读取评分/评论数/价位/摘要。

店铺信息：
- 店名：${name}
- 地址：${address}
- 城市：${city}
- 期望地区：${area || city}

严格要求：
- 必须返回**店铺详情页** URL（形如 https://www.yelp.com/biz/<slug>）。**禁止返回搜索/列表/排行榜页**。
- 该店铺页的地址必须落在「${area || city}」附近；落在其它城市的同名店一律视为不匹配。
- 即便没有评分/价位也要返回 url；只在确认 Yelp 上没有这家店时全部返回 null。
- rating / reviewCount / priceLevel / summary 同第一轮规则；读不到原样返回 null，禁止编造。
- summary: ${summaryRule}

只输出 JSON。`;

    const body: Record<string, unknown> = {
      model: isFirst ? "sonar" : "sonar-pro",
      messages: [
        {
          role: "system",
          content:
            "你是 Yelp 查询助手。只参考 yelp.* 真实页面，找到与给定店名+地址最匹配的店铺**详情页**，输出结构化 JSON。找不到必须返回 null 字段，禁止编造。",
        },
        { role: "user", content: userPrompt },
      ],
      max_tokens: isFirst ? 400 : 700,
      temperature: 0.1,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "yelp_info",
          schema: {
            type: "object",
            properties: {
              rating: { type: ["string", "null"] },
              reviewCount: { type: ["number", "null"] },
              url: { type: ["string", "null"] },
              priceLevel: { type: ["string", "null"] },
              summary: { type: ["string", "null"] },
            },
            required: ["rating", "reviewCount", "url", "priceLevel", "summary"],
          },
        },
      },
    };
    if (isFirst) {
      body.search_domain_filter = YELP_DOMAINS;
    }

    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[Yelp/${stage}] ${name}: HTTP ${res.status}`);
      return { json: null, ok: false, status: res.status };
    }
    const json = await res.json();
    return { json, ok: true, status: 200 };
  } catch (e) {
    console.warn(`[Yelp/${stage}] ${name}:`, e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePriceLevel(raw: unknown): YelpInfo["priceLevel"] {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "$" || s === "$$" || s === "$$$" || s === "$$$$") return s;
  return null;
}

function parseStage(name: string, stage: Stage, raw: unknown): YelpInfo | null {
  const json = raw as Record<string, unknown> | null;
  if (!json) return null;
  const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content;
  const citations: string[] = Array.isArray(json.citations)
    ? (json.citations as unknown[]).filter((c): c is string => typeof c === "string")
    : [];

  const yelpCitation = citations.find((c) => YELP_SHOP_URL_RE.test(c)) ?? null;

  if (!content) {
    if (yelpCitation) {
      console.log(`[Yelp/${stage}] ${name}: empty content but citation hit → url-only`);
      return {
        rating: null,
        reviewCount: null,
        url: yelpCitation,
        priceLevel: null,
        summary: null,
      };
    }
    console.warn(`[Yelp/${stage}] ${name}: empty content & no shop-page citation`);
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    console.warn(`[Yelp/${stage}] ${name}: parse_error`);
    return null;
  }

  const rawUrl = typeof parsed.url === "string" ? parsed.url.trim() : null;
  const urlFromJson = rawUrl && YELP_SHOP_URL_RE.test(rawUrl) ? rawUrl : null;
  const url = urlFromJson ?? yelpCitation;

  if (!url) {
    console.warn(`[Yelp/${stage}] ${name}: no shop-page url in JSON or citations`);
    return null;
  }

  const ratingRaw = parsed.rating;
  const rating =
    typeof ratingRaw === "string" && /^\d(\.\d{1,2})?$/.test(ratingRaw.trim())
      ? ratingRaw.trim()
      : typeof ratingRaw === "number" && ratingRaw > 0 && ratingRaw <= 5
        ? ratingRaw.toFixed(1)
        : null;
  const reviewCount =
    typeof parsed.reviewCount === "number" && parsed.reviewCount >= 0
      ? Math.round(parsed.reviewCount)
      : null;
  const priceLevel = normalizePriceLevel(parsed.priceLevel);
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim().length > 0
      ? parsed.summary.trim().slice(0, 160)
      : null;

  console.log(
    `[Yelp/${stage}] ${name}: ok rating=${rating} reviews=${reviewCount} price=${priceLevel ?? "-"}`,
  );

  return { rating, reviewCount, url, priceLevel, summary };
}

export async function fetchYelpInfo(
  name: string,
  address: string,
  city: string,
  isEn = false,
): Promise<YelpInfo | null> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;

  const cacheKey = `${name}|${address}`.toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const area = extractArea(address, city);

  // Stage 1
  const r1 = await callPerplexity({ apiKey, stage: "sonar", name, address, city, area, isEn });
  let info = r1?.ok ? parseStage(name, "sonar", r1.json) : null;

  // Stage 2 fallback
  if (!info) {
    const r2 = await callPerplexity({
      apiKey,
      stage: "sonar-pro",
      name,
      address,
      city,
      area,
      isEn,
    });
    info = r2?.ok ? parseStage(name, "sonar-pro", r2.json) : null;
  }

  cache.set(cacheKey, info);
  return info;
}
