// Yelp 信息抓取层（US / CA / 西欧分支用）
// 三阶段策略：
//   Stage 0: Perplexity /search 直接拿候选 Yelp 详情页 URL（命中率高、便宜）
//   Stage 1: sonar + 单域名过滤 yelp.com，带上 Stage0 的 URL hint
//   Stage 2: sonar-pro 兜底（不带 domain filter），URL hint 优先

export type YelpInfo = {
  rating: string | null;
  reviewCount: number | null;
  url: string | null;
  priceLevel: "$" | "$$" | "$$$" | "$$$$" | null;
  summary: string | null;
};

const cache = new Map<string, YelpInfo | null>();

// yelp 店铺详情页 URL：yelp.<tld>/biz/<slug>
const YELP_SHOP_URL_RE = /https?:\/\/(?:www\.)?yelp\.[a-z.]{2,8}\/biz\/[a-z0-9\-_%]+/i;

// 单域名召回最稳，yelp.com 已覆盖全球绝大多数店铺
const YELP_DOMAINS = ["yelp.com"];

function extractArea(address: string, city: string): string {
  if (!address) return city;
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return city;
  const lower = city.toLowerCase();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].toLowerCase().includes(lower)) {
      const region = parts[i + 1]?.replace(/\d{3,}.*$/, "").trim();
      return region ? `${city}, ${region}` : city;
    }
  }
  return city;
}

// Stage 0：调用 Perplexity /search 直接获取 yelp 详情页 URL
async function preSearchYelpUrl(opts: {
  apiKey: string;
  name: string;
  city: string;
  area: string;
}): Promise<string | null> {
  const { apiKey, name, city, area } = opts;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const query = `${name} ${area || city} site:yelp.com`;
    const res = await fetch("https://api.perplexity.ai/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({ query, max_results: 5 }),
    });
    if (!res.ok) {
      console.warn(`[Yelp/search] ${name}: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as Record<string, unknown>;
    // Perplexity /search 返回结构：{ results: [{ url, title, snippet }, ...] }
    const results = (json.results ?? json.data ?? []) as Array<Record<string, unknown>>;
    for (const r of results) {
      const u = typeof r.url === "string" ? r.url : null;
      if (u && YELP_SHOP_URL_RE.test(u)) {
        console.log(`[Yelp/search] ${name}: pre-url ${u}`);
        return u;
      }
    }
    return null;
  } catch (e) {
    console.warn(`[Yelp/search] ${name}:`, e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
  preUrl: string | null;
}): Promise<{ json: unknown; ok: boolean; status: number } | null> {
  const { apiKey, stage, name, address, city, area, isEn, preUrl } = opts;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const isFirst = stage === "sonar";
    const summaryRule = isEn
      ? "1-2 sentences in English summarizing Yelp reviews (specific dishes/service/atmosphere), <= 80 chars. Unreadable -> null."
      : "1-2 句简体中文，归纳 Yelp 评论口碑（具体菜品/服务/氛围），≤ 60 字。读不到 → null。";

    const hintLine = preUrl
      ? `\n已知该店的 Yelp 详情页 URL 是：${preUrl}\n请**直接读取**这个页面的 rating / reviewCount / priceLevel / summary，并把 url 字段原样返回这个 URL。\n`
      : "";

    const userPrompt = isFirst
      ? `查找 Yelp 上的店铺：
- 店名：${name}
- 地址：${address}
- 城市：${city}
- 地区提示：${area}
${hintLine}
要求（按优先级）：
- **url 是最重要的字段**：只要 Yelp 上有这家店的详情页（形如 https://www.yelp.com/biz/<slug>），就返回 URL，**哪怕评分等其它字段读不到也要返回 URL**。
- ✓ 正例：https://www.yelp.com/biz/mizu-sushi-bar-saint-louis
- ✗ 反例：https://www.yelp.com/search?find_desc=...（搜索页禁止）
- 同名店：选地址/城市最匹配的那家，不要返回 null。
- rating: Yelp 综合评分（数字字符串如 "4.3"，范围 0-5）。读不到 → null（不影响 url 返回）。
- reviewCount: 评论数（整数）。读不到 → null。
- priceLevel: "$" / "$$" / "$$$" / "$$$$" 之一。读不到 → null。
- summary: ${summaryRule}

只输出 JSON。确实 Yelp 上没有这家店时，所有字段才返回 null。`
      : `请在 Yelp 上找到这家店的详情页，读取评分/评论数/价位/摘要。

店铺信息：
- 店名：${name}
- 地址：${address}
- 城市：${city}
- 期望地区：${area || city}
${hintLine}
要求：
- url 优先级最高：找到 Yelp 详情页（形如 https://www.yelp.com/biz/<slug> 或 yelp.<tld>/biz/<slug>）就返回；**其它字段为 null 不影响 url 返回**。
- ✗ 禁止返回搜索/列表/排行榜页 URL。
- 同名不同店：选地址最匹配该城市的那家。
- rating / reviewCount / priceLevel / summary：读到就给，读不到 null，禁止编造。
- summary: ${summaryRule}

只输出 JSON。Yelp 上确实没有这家店时所有字段才返回 null。`;

    const body: Record<string, unknown> = {
      model: isFirst ? "sonar" : "sonar-pro",
      messages: [
        {
          role: "system",
          content:
            "你是 Yelp 查询助手。优先返回真实存在的 Yelp 店铺详情页 URL，再读取页面字段。url 字段优先级最高，其它字段读不到时返回 null，禁止编造。",
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
    // 仅 Stage1 用单域名过滤；Stage2 解开过滤以提高召回
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

function parseStage(
  name: string,
  stage: Stage | "search",
  raw: unknown,
  preUrl: string | null,
): YelpInfo | null {
  const json = raw as Record<string, unknown> | null;
  if (!json) return preUrl ? { rating: null, reviewCount: null, url: preUrl, priceLevel: null, summary: null } : null;
  const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content;
  const citations: string[] = Array.isArray(json.citations)
    ? (json.citations as unknown[]).filter((c): c is string => typeof c === "string")
    : [];

  const yelpCitation = citations.find((c) => YELP_SHOP_URL_RE.test(c)) ?? null;

  if (!content) {
    const url = preUrl ?? yelpCitation;
    if (url) {
      console.log(`[Yelp/${stage}] ${name}: empty content → url-only (${url})`);
      return { rating: null, reviewCount: null, url, priceLevel: null, summary: null };
    }
    console.warn(`[Yelp/${stage}] ${name}: empty content & no shop-page citation`);
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    console.warn(`[Yelp/${stage}] ${name}: parse_error`);
    const url = preUrl ?? yelpCitation;
    return url ? { rating: null, reviewCount: null, url, priceLevel: null, summary: null } : null;
  }

  const rawUrl = typeof parsed.url === "string" ? parsed.url.trim() : null;
  const urlFromJson = rawUrl && YELP_SHOP_URL_RE.test(rawUrl) ? rawUrl : null;
  const url = urlFromJson ?? preUrl ?? yelpCitation;

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

function hasUsefulFields(info: YelpInfo | null): boolean {
  if (!info) return false;
  return info.rating != null || info.reviewCount != null || info.summary != null || info.priceLevel != null;
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

  // Stage 0: 用 /search 直接拿 URL（最便宜、命中最高）
  const preUrl = await preSearchYelpUrl({ apiKey, name, city, area });

  // Stage 1: sonar + 单域名过滤，带 URL hint
  const r1 = await callPerplexity({
    apiKey,
    stage: "sonar",
    name,
    address,
    city,
    area,
    isEn,
    preUrl,
  });
  let info = r1?.ok ? parseStage(name, "sonar", r1.json, preUrl) : null;

  // Stage 2: 仅当 Stage1 完全失败、或拿到 url 但所有字段都空时才跑（用 sonar-pro 补字段）
  if (!info || !hasUsefulFields(info)) {
    const r2 = await callPerplexity({
      apiKey,
      stage: "sonar-pro",
      name,
      address,
      city,
      area,
      isEn,
      preUrl: info?.url ?? preUrl,
    });
    const info2 = r2?.ok ? parseStage(name, "sonar-pro", r2.json, info?.url ?? preUrl) : null;
    if (info2 && (hasUsefulFields(info2) || !info)) {
      info = info2;
    }
  }

  // 最后兜底：只有 preUrl 也比什么都没有强
  if (!info && preUrl) {
    info = { rating: null, reviewCount: null, url: preUrl, priceLevel: null, summary: null };
  }

  cache.set(cacheKey, info);
  return info;
}
