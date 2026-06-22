// Yelp 信息抓取层（US / CA / 西欧分支用）
// 策略：
//   Stage 0: 多变体并发 /search → /biz/<slug> 候选 + 打分 → top1 + confidence
//   Stage 1: sonar 补字段（high/medium 置信度跑）
//   Stage 2: sonar-pro 核验+补字段（medium/low 置信度跑）

export type YelpConfidence = "high" | "medium" | "low";

export type YelpInfo = {
  rating: string | null;
  reviewCount: number | null;
  url: string | null;
  priceLevel: "$" | "$$" | "$$$" | "$$$$" | null;
  summary: string | null;
  confidence: YelpConfidence;
};

type CacheEntry = { info: YelpInfo | null; expireAt: number };
const cache = new Map<string, CacheEntry>();
const NEG_TTL_MS = 30 * 60 * 1000;
const POS_TTL_MS = 24 * 60 * 60 * 1000;

const YELP_SHOP_URL_RE = /https?:\/\/(?:www\.)?yelp\.[a-z.]{2,8}\/biz\/[a-z0-9\-_%]+/i;
const YELP_DOMAINS = ["yelp.com"];

function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function nameTokens(name: string): string[] {
  const stop = new Set(["the", "a", "an", "of", "and", "de", "la", "le", "el", "and"]);
  return normalizeToken(name)
    .split(" ")
    .filter((t) => t.length >= 2 && !stop.has(t));
}

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

// 从地址首段抽出街道关键词（去掉门牌号/邮编/国家），最多 3 个 token。
function extractStreetTokens(address: string): string[] {
  if (!address) return [];
  const first = address.split(",")[0] ?? "";
  // 去掉前导门牌号 / 单元号
  const cleaned = first.replace(/^\s*\d+[a-z\-/]*\s*/i, "").trim();
  return normalizeToken(cleaned)
    .split(" ")
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t))
    .slice(0, 3);
}

function slugOf(url: string): string {
  const m = url.match(/\/biz\/([a-z0-9\-_%]+)/i);
  return m ? m[1].toLowerCase() : "";
}

type SearchResult = { url: string; title: string; snippet: string };

async function perplexitySearch(opts: {
  apiKey: string;
  query: string;
  label: string;
  name: string;
}): Promise<SearchResult[]> {
  const { apiKey, query, label, name } = opts;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch("https://api.perplexity.ai/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ query, max_results: 6 }),
    });
    if (!res.ok) {
      console.warn(`[Yelp/search:${label}] ${name}: HTTP ${res.status}`);
      return [];
    }
    const json = (await res.json()) as Record<string, unknown>;
    const results = (json.results ?? json.data ?? []) as Array<Record<string, unknown>>;
    return results
      .map((r) => ({
        url: typeof r.url === "string" ? r.url : "",
        title: typeof r.title === "string" ? r.title : "",
        snippet: typeof r.snippet === "string" ? r.snippet : (typeof r.description === "string" ? r.description : ""),
      }))
      .filter((r) => r.url && YELP_SHOP_URL_RE.test(r.url));
  } catch (e) {
    console.warn(`[Yelp/search:${label}] ${name}:`, e instanceof Error ? e.message : e);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

type ScoredCandidate = { url: string; score: number; appearances: number };

function scoreCandidates(
  batches: SearchResult[][],
  name: string,
  city: string,
  address: string,
  cuisine?: string,
): ScoredCandidate[] {
  const tokens = nameTokens(name);
  const cityToken = normalizeToken(city);
  const streetToks = extractStreetTokens(address);
  const cuisineToks = cuisine ? nameTokens(cuisine) : [];
  // 抽取门牌号
  const streetNumMatch = address.match(/\b(\d{1,5})\b/);
  const streetNum = streetNumMatch ? streetNumMatch[1] : null;

  const byUrl = new Map<string, { score: number; appearances: number; sample: SearchResult }>();

  for (const batch of batches) {
    const seenInBatch = new Set<string>();
    for (const r of batch) {
      if (seenInBatch.has(r.url)) continue;
      seenInBatch.add(r.url);

      const slug = slugOf(r.url);
      const titleNorm = normalizeToken(r.title);
      const snippetNorm = normalizeToken(r.snippet);
      const slugTokens = slug.split("-").filter(Boolean);

      let score = 0;
      // 店名 token 在 slug 中命中
      const nameHits = tokens.filter((t) => slugTokens.includes(t) || slug.includes(t)).length;
      if (tokens.length > 0) {
        const ratio = nameHits / tokens.length;
        if (ratio >= 0.7) score += 3;
        else if (ratio >= 0.4) score += 2;
        else if (ratio > 0) score += 1;
      }
      // 城市在 slug 或 title
      if (cityToken && (slug.includes(cityToken.replace(/ /g, "-")) || slug.includes(cityToken.replace(/ /g, "")) || titleNorm.includes(cityToken))) {
        score += 2;
      }
      // 街道关键词 in snippet/title
      const streetHit = streetToks.some((t) => snippetNorm.includes(t) || titleNorm.includes(t));
      if (streetHit) score += 2;
      // 门牌号 in snippet
      if (streetNum && (r.snippet.includes(streetNum) || r.title.includes(streetNum))) score += 1;
      // cuisine 关键词命中 snippet/title/slug → +1（多变体真实性加分）
      if (cuisineToks.length > 0) {
        const cuisineHit = cuisineToks.some(
          (t) => snippetNorm.includes(t) || titleNorm.includes(t) || slug.includes(t),
        );
        if (cuisineHit) score += 1;
      }

      const prev = byUrl.get(r.url);
      if (prev) {
        prev.appearances += 1;
        prev.score = Math.max(prev.score, score);
      } else {
        byUrl.set(r.url, { score, appearances: 1, sample: r });
      }
    }
  }

  // 多 batch 重复出现加分（出现在多条 query 里 = 更真实）
  const scored: ScoredCandidate[] = [];
  for (const [url, v] of byUrl.entries()) {
    const repeatBonus = v.appearances >= 3 ? 2 : v.appearances >= 2 ? 1 : 0;
    const final = v.score + repeatBonus;
    scored.push({ url, score: final, appearances: v.appearances });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function bucketConfidence(score: number): YelpConfidence {
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

// Stage 0：多变体并发
async function preSearchYelp(opts: {
  apiKey: string;
  name: string;
  city: string;
  address: string;
  cuisine?: string;
}): Promise<{ url: string | null; confidence: YelpConfidence }> {
  const { apiKey, name, city, address, cuisine } = opts;
  const streetToks = extractStreetTokens(address);
  const area = extractArea(address, city);

  const queries: Array<{ q: string; label: string }> = [
    { q: `"${name}" ${city} site:yelp.com`, label: "name+city" },
  ];
  if (streetToks.length > 0) {
    queries.push({ q: `${name} ${streetToks.join(" ")} site:yelp.com`, label: "name+street" });
  }
  // 新增：name + area + city + cuisine（强制变体）
  if (cuisine && cuisine.trim()) {
    queries.push({
      q: `"${name}" ${area} ${city} ${cuisine} site:yelp.com`,
      label: "name+area+city+cuisine",
    });
  }

  const batches = await Promise.all(queries.map((q) => perplexitySearch({ apiKey, query: q.q, label: q.label, name })));
  let scored = scoreCandidates(batches, name, city, address, cuisine);

  // 如果前面所有 query 都没召回，name-only 兜底
  if (scored.length === 0) {
    const fallback = await perplexitySearch({
      apiKey,
      query: `${name} site:yelp.com/biz`,
      label: "name-only",
      name,
    });
    scored = scoreCandidates([fallback], name, city, address, cuisine);
  }

  if (scored.length === 0) {
    console.log(`[Yelp/search] ${name}: no candidates`);
    return { url: null, confidence: "low" };
  }

  const top = scored[0];
  const confidence = bucketConfidence(top.score);
  console.log(
    `[Yelp/search] ${name}: top=${top.url} score=${top.score} conf=${confidence} (${scored.length} candidates, ${queries.length} variants)`,
  );
  return { url: top.url, confidence };
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
  verifyMode: boolean; // true 时 prompt 要求先核验店名+地址
}): Promise<{ json: unknown; ok: boolean } | null> {
  const { apiKey, stage, name, address, city, area, isEn, preUrl, verifyMode } = opts;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const isFirst = stage === "sonar";
    const summaryRule = isEn
      ? "1-2 sentences in English summarizing Yelp reviews (specific dishes/service/atmosphere), <= 80 chars. Unreadable -> null."
      : "1-2 句简体中文，归纳 Yelp 评论口碑（具体菜品/服务/氛围），≤ 60 字。读不到 → null。";

    const hintLine = preUrl
      ? `\n候选 Yelp 详情页 URL：${preUrl}\n${verifyMode
          ? `**先核验**：打开这个页面，检查店名是否与"${name}"吻合、地址是否与"${address}"在同一城市/街区。\n- 不吻合 → 所有字段（包括 url）全部返回 null。\n- 吻合 → 把 url 字段原样返回，并读取其它字段。\n`
          : `直接读取这个页面的字段，url 字段原样返回。\n`}`
      : "";

    const userPrompt = isFirst
      ? `查找 Yelp 上的店铺：
- 店名：${name}
- 地址：${address}
- 城市：${city}
- 地区提示：${area}
${hintLine}
**字段优先级（按顺序尽力读）**：
1. **summary（评论口碑，最关键）**：基于真实 Yelp 评论文本归纳具体菜品/服务/氛围；能读到一定要写，宁可短不要空，禁止编造。
2. **rating（评分）/ reviewCount（评论数）**：直接读页面字段。
3. **priceLevel（价位）**：读到就给。

其它要求：
- url 优先级最高：只要 Yelp 上有这家店的详情页（https://www.yelp.com/biz/<slug>），就返回 URL，**哪怕评分等其它字段读不到也要返回 URL**${verifyMode ? "（前提是核验通过）" : ""}。
- ✗ 反例：https://www.yelp.com/search?find_desc=...（搜索页禁止）
- 同名店：选地址/城市最匹配的那家。
- rating: 0-5 数字字符串如 "4.3"，读不到 → null。
- reviewCount: 整数，读不到 → null。
- priceLevel: "$" / "$$" / "$$$" / "$$$$"，读不到 → null。
- summary: ${summaryRule}

只输出 JSON。`
      : `请在 Yelp 详情页读取这家店的字段${verifyMode ? "，**严格核验店名+地址**" : ""}。

店铺信息：
- 店名：${name}
- 地址：${address}
- 城市：${city}
- 期望地区：${area || city}
${hintLine}
**字段优先级（按顺序尽力读）**：
1. **summary（评论口碑，最关键）**：基于真实 Yelp 评论文本归纳具体菜品/服务/氛围；能读到一定要写，宁可短不要空，禁止编造。
2. **rating（评分）/ reviewCount（评论数）**：直接读页面字段。
3. **priceLevel（价位）**：读到就给。

其它要求：
- url 优先级最高：找到 Yelp 详情页（https://www.yelp.com/biz/<slug>）就返回${verifyMode ? "（核验通过的前提下）" : ""}。
- ✗ 禁止返回搜索/列表/排行榜 URL。
- 同名不同店：选地址最匹配该城市的那家。
- rating / reviewCount / priceLevel / summary：读到就给，读不到 null，禁止编造。
- summary: ${summaryRule}

只输出 JSON。${verifyMode ? "核验不通过时 url 也必须为 null。" : ""}`;

    const body: Record<string, unknown> = {
      model: isFirst ? "sonar" : "sonar-pro",
      messages: [
        {
          role: "system",
          content:
            "你是 Yelp 查询助手。" +
            (verifyMode ? "先严格核验候选页面的店名+地址是否匹配，匹配才返回字段，不匹配把 url 也设为 null。" : "返回真实存在的 Yelp 店铺详情页 URL 和字段，禁止编造。"),
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
    if (isFirst) body.search_domain_filter = YELP_DOMAINS;

    const res = await (await import("./retry.server")).withRetry(
      (sig) =>
        fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          signal: sig ?? controller.signal,
          body: JSON.stringify(body),
        }).then((r) => {
          if (!r.ok && (r.status >= 500 || r.status === 429)) {
            throw new Error(`Yelp upstream ${r.status}`);
          }
          return r;
        }),
      { label: `yelp.${stage}`, retries: 1, timeoutMs: 15_000 },
    );
    if (!res.ok) {
      console.warn(`[Yelp/${stage}] ${name}: HTTP ${res.status}`);
      return { json: null, ok: false };
    }
    return { json: await res.json(), ok: true };
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
  stage: Stage,
  raw: unknown,
  preUrl: string | null,
  confidence: YelpConfidence,
): YelpInfo | null {
  const json = raw as Record<string, unknown> | null;
  if (!json) {
    return preUrl
      ? { rating: null, reviewCount: null, url: preUrl, priceLevel: null, summary: null, confidence }
      : null;
  }
  const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content;
  const citations: string[] = Array.isArray(json.citations)
    ? (json.citations as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  const yelpCitation = citations.find((c) => YELP_SHOP_URL_RE.test(c)) ?? null;

  if (!content) {
    const url = preUrl ?? yelpCitation;
    return url ? { rating: null, reviewCount: null, url, priceLevel: null, summary: null, confidence } : null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    const url = preUrl ?? yelpCitation;
    return url ? { rating: null, reviewCount: null, url, priceLevel: null, summary: null, confidence } : null;
  }

  const rawUrl = typeof parsed.url === "string" ? parsed.url.trim() : null;
  const urlFromJson = rawUrl && YELP_SHOP_URL_RE.test(rawUrl) ? rawUrl : null;
  // 核验模式下：如果模型明确返回 url=null，说明核验不通过，丢弃 preUrl
  const verifyRejected = rawUrl === null && parsed.url === null;
  const url = urlFromJson ?? (verifyRejected ? null : (preUrl ?? yelpCitation));

  if (!url) return null;

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
    `[Yelp/${stage}] ${name}: ok conf=${confidence} rating=${rating} reviews=${reviewCount} price=${priceLevel ?? "-"}`,
  );

  return { rating, reviewCount, url, priceLevel, summary, confidence };
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
  const cached = cache.get(cacheKey);
  if (cached && cached.expireAt > Date.now()) return cached.info;

  const area = extractArea(address, city);

  // Stage 0：多变体并发 + 打分
  const { url: preUrl, confidence } = await preSearchYelp({ apiKey, name, city, address });

  let info: YelpInfo | null = null;

  if (preUrl && confidence === "high") {
    // 高置信度：一次 sonar 调用补字段
    const r = await callPerplexity({
      apiKey, stage: "sonar", name, address, city, area, isEn, preUrl, verifyMode: false,
    });
    info = r?.ok ? parseStage(name, "sonar", r.json, preUrl, confidence) : null;
    // 字段全空再补一次 sonar-pro
    if (!info || !hasUsefulFields(info)) {
      const r2 = await callPerplexity({
        apiKey, stage: "sonar-pro", name, address, city, area, isEn, preUrl: info?.url ?? preUrl, verifyMode: false,
      });
      const info2 = r2?.ok ? parseStage(name, "sonar-pro", r2.json, info?.url ?? preUrl, confidence) : null;
      if (info2) info = info2;
    }
  } else if (preUrl && confidence === "medium") {
    // 中置信度：Stage 1 跑 sonar，字段空再 Stage 2 sonar-pro（带核验）
    const r = await callPerplexity({
      apiKey, stage: "sonar", name, address, city, area, isEn, preUrl, verifyMode: false,
    });
    info = r?.ok ? parseStage(name, "sonar", r.json, preUrl, confidence) : null;
    if (!info || !hasUsefulFields(info)) {
      const r2 = await callPerplexity({
        apiKey, stage: "sonar-pro", name, address, city, area, isEn, preUrl: info?.url ?? preUrl, verifyMode: true,
      });
      const info2 = r2?.ok ? parseStage(name, "sonar-pro", r2.json, info?.url ?? preUrl, confidence) : null;
      if (info2) info = info2;
    }
  } else if (preUrl) {
    // 低置信度：直接 sonar-pro + 强制核验
    const r = await callPerplexity({
      apiKey, stage: "sonar-pro", name, address, city, area, isEn, preUrl, verifyMode: true,
    });
    info = r?.ok ? parseStage(name, "sonar-pro", r.json, preUrl, confidence) : null;
    // 核验后 url 仍在，但字段空 → 保留 url-only 低置信卡
    if (!info && preUrl) {
      // 不再保留 preUrl：sonar-pro 核验失败时保护性丢弃
    }
  } else {
    // 没有候选 URL：跑一次 sonar 作最后兜底
    const r = await callPerplexity({
      apiKey, stage: "sonar", name, address, city, area, isEn, preUrl: null, verifyMode: false,
    });
    info = r?.ok ? parseStage(name, "sonar", r.json, null, "low") : null;
  }

  const ttl = info ? POS_TTL_MS : NEG_TTL_MS;
  cache.set(cacheKey, { info, expireAt: Date.now() + ttl });
  return info;
}
