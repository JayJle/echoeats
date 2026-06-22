// Yelp 信息抓取层（US / CA / 西欧分支用）
// 策略：
//   Stage 0: 多变体并发 /search → /biz/<slug> 候选 + 打分 → top1 + confidence
//   Stage 1: sonar 补字段（high/medium 置信度跑）
//   Stage 2: sonar-pro 核验+补字段（medium/low 置信度跑）

export type YelpConfidence = "high" | "medium" | "low";

export type YelpEvidence = {
  matchEvidence: string[];
  fieldEvidence: string[];
  reviewEvidence: string[];
  pageSignals: string[];
};

// rating/reviewCount/priceLevel/summary 默认 null：由下游 DeepSeek 排序时从 evidence 中提取。
// 保留这些字段是为了 UI 兼容；displayFields 合并后会覆盖。
export type YelpInfo = {
  rating: string | null;
  reviewCount: number | null;
  url: string | null;
  priceLevel: "$" | "$$" | "$$$" | "$$$$" | null;
  summary: string | null;
  confidence: YelpConfidence;
  evidence: YelpEvidence | null;
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
  const area = extractArea(address, city);

  const queries: Array<{ q: string; label: string }> = [
    { q: `"${name}" ${city} site:yelp.com`, label: "name+city" },
  ];
  if (cuisine && cuisine.trim()) {
    queries.push({
      q: `"${name}" ${area} ${city} ${cuisine} site:yelp.com`,
      label: "name+area+city+cuisine",
    });
  }

  const batches = await Promise.all(queries.map((q) => perplexitySearch({ apiKey, query: q.q, label: q.label, name })));
  const scored = scoreCandidates(batches, name, city, address, cuisine);

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

// 调 Perplexity 拉 evidence 包：URL + 4 类短引用（不再让 Perplexity 直接产业务字段）。
async function callPerplexity(opts: {
  apiKey: string;
  stage: Stage;
  name: string;
  address: string;
  city: string;
  area: string;
  preUrl: string | null;
  verifyMode: boolean;
}): Promise<{ json: unknown; ok: boolean } | null> {
  const { apiKey, stage, name, address, city, area, preUrl, verifyMode } = opts;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const isFirst = stage === "sonar";

    const hintLine = preUrl
      ? `\n候选 Yelp 详情页 URL：${preUrl}\n${verifyMode
          ? `**先核验**：检查页面店名是否与"${name}"吻合、地址是否与"${address}"在同一城市/街区。不吻合则 url=null。`
          : `直接打开这个页面读取证据。`}\n`
      : "";

    const userPrompt = `从 Yelp 上为这家店收集**证据片段**（不要做归纳，不要打分，不要写结论）：
- 店名：${name}
- 地址：${address}
- 城市：${city}
- 地区提示：${area}
${hintLine}
**任务**：找到该店的 Yelp 详情页（https://www.yelp.com/biz/<slug>，禁止搜索/列表页），输出 JSON：

\`\`\`
{
  "url": "https://www.yelp.com/biz/...",
  "matchEvidence":  [2-3 条，必须含店名 + 地址原文（用来核验是否同一家店）],
  "fieldEvidence":  [3-5 条，包含 rating 行原文、review count 原文、价位($/$$/$$$/$$$$)原文、营业类别],
  "reviewEvidence": [6-8 条，从真实 Yelp 评论里摘的**原话片段**，覆盖菜品/服务/氛围/价格],
  "pageSignals":    [3-5 条，营业时间/电话/品类 tag/招牌菜/地标]
}
\`\`\`

硬规则：
- 每条 evidence 80–120 字符；超过截断；不要改写或翻译，保留原文（包括中英文）。
- 找不到该字段就给空数组 []，**禁止编造**。
- url 必须是真实 biz 详情页；找不到 → url=null 且所有数组为空。
${verifyMode ? "- 核验不通过时 url=null。\n" : ""}- 只输出 JSON，不要前后说明。`;

    const body: Record<string, unknown> = {
      model: isFirst ? "sonar" : "sonar-pro",
      messages: [
        {
          role: "system",
          content:
            "你是 Yelp 证据采集助手：只摘原文片段，不归纳、不结构化业务字段、不打分。" +
            (verifyMode ? "先核验候选页店名+地址是否匹配，不匹配 url=null。" : ""),
        },
        { role: "user", content: userPrompt },
      ],
      max_tokens: isFirst ? 600 : 900,
      temperature: 0.1,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "yelp_evidence",
          schema: {
            type: "object",
            properties: {
              url: { type: ["string", "null"] },
              matchEvidence: { type: "array", items: { type: "string" } },
              fieldEvidence: { type: "array", items: { type: "string" } },
              reviewEvidence: { type: "array", items: { type: "string" } },
              pageSignals: { type: "array", items: { type: "string" } },
            },
            required: ["url", "matchEvidence", "fieldEvidence", "reviewEvidence", "pageSignals"],
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

function sanitizeEvidenceList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, max)
    .map((s) => (s.length > 140 ? s.slice(0, 140) : s));
}

function emptyEvidence(): YelpEvidence {
  return { matchEvidence: [], fieldEvidence: [], reviewEvidence: [], pageSignals: [] };
}

function urlOnlyInfo(url: string, confidence: YelpConfidence, evidence: YelpEvidence | null): YelpInfo {
  return { rating: null, reviewCount: null, url, priceLevel: null, summary: null, confidence, evidence };
}

function parseEvidenceStage(
  name: string,
  stage: Stage,
  raw: unknown,
  preUrl: string | null,
  confidence: YelpConfidence,
): YelpInfo | null {
  const json = raw as Record<string, unknown> | null;
  if (!json) {
    return preUrl ? urlOnlyInfo(preUrl, confidence, null) : null;
  }
  const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content;
  const citations: string[] = Array.isArray(json.citations)
    ? (json.citations as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  const yelpCitation = citations.find((c) => YELP_SHOP_URL_RE.test(c)) ?? null;

  if (!content) {
    const url = preUrl ?? yelpCitation;
    return url ? urlOnlyInfo(url, confidence, null) : null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    const url = preUrl ?? yelpCitation;
    return url ? urlOnlyInfo(url, confidence, null) : null;
  }

  const rawUrl = typeof parsed.url === "string" ? parsed.url.trim() : null;
  const urlFromJson = rawUrl && YELP_SHOP_URL_RE.test(rawUrl) ? rawUrl : null;
  const verifyRejected = parsed.url === null;
  const url = urlFromJson ?? (verifyRejected ? null : (preUrl ?? yelpCitation));
  if (!url) return null;

  const evidence: YelpEvidence = {
    matchEvidence: sanitizeEvidenceList(parsed.matchEvidence, 3),
    fieldEvidence: sanitizeEvidenceList(parsed.fieldEvidence, 5),
    reviewEvidence: sanitizeEvidenceList(parsed.reviewEvidence, 8),
    pageSignals: sanitizeEvidenceList(parsed.pageSignals, 5),
  };

  const totalEv =
    evidence.matchEvidence.length +
    evidence.fieldEvidence.length +
    evidence.reviewEvidence.length +
    evidence.pageSignals.length;

  console.log(
    `[Yelp/${stage}] ${name}: ok conf=${confidence} url=${url.slice(0, 60)} evidence=${totalEv}(m${evidence.matchEvidence.length}/f${evidence.fieldEvidence.length}/r${evidence.reviewEvidence.length}/s${evidence.pageSignals.length})`,
  );

  return urlOnlyInfo(url, confidence, totalEv > 0 ? evidence : emptyEvidence());
}

function hasUsefulEvidence(info: YelpInfo | null): boolean {
  if (!info || !info.evidence) return false;
  return info.evidence.reviewEvidence.length > 0 || info.evidence.fieldEvidence.length > 0;
}

export async function fetchYelpInfo(
  name: string,
  address: string,
  city: string,
  _isEn = false,
  cuisine?: string,
): Promise<YelpInfo | null> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;

  const cacheKey = `${name}|${address}`.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && cached.expireAt > Date.now()) return cached.info;

  const area = extractArea(address, city);

  const { url: preUrl, confidence } = await preSearchYelp({ apiKey, name, city, address, cuisine });

  let info: YelpInfo | null = null;

  if (preUrl && confidence === "high") {
    const r = await callPerplexity({
      apiKey, stage: "sonar", name, address, city, area, preUrl, verifyMode: false,
    });
    info = r?.ok ? parseEvidenceStage(name, "sonar", r.json, preUrl, confidence) : null;
    if (!info || !hasUsefulEvidence(info)) {
      const r2 = await callPerplexity({
        apiKey, stage: "sonar-pro", name, address, city, area, preUrl: info?.url ?? preUrl, verifyMode: false,
      });
      const info2 = r2?.ok ? parseEvidenceStage(name, "sonar-pro", r2.json, info?.url ?? preUrl, confidence) : null;
      if (info2) info = info2;
    }
  } else if (preUrl && confidence === "medium") {
    const r = await callPerplexity({
      apiKey, stage: "sonar", name, address, city, area, preUrl, verifyMode: false,
    });
    info = r?.ok ? parseEvidenceStage(name, "sonar", r.json, preUrl, confidence) : null;
    if (!info || !hasUsefulEvidence(info)) {
      const r2 = await callPerplexity({
        apiKey, stage: "sonar-pro", name, address, city, area, preUrl: info?.url ?? preUrl, verifyMode: true,
      });
      const info2 = r2?.ok ? parseEvidenceStage(name, "sonar-pro", r2.json, info?.url ?? preUrl, confidence) : null;
      if (info2) info = info2;
    }
  } else if (preUrl) {
    const r = await callPerplexity({
      apiKey, stage: "sonar-pro", name, address, city, area, preUrl, verifyMode: true,
    });
    info = r?.ok ? parseEvidenceStage(name, "sonar-pro", r.json, preUrl, confidence) : null;
  } else {
    const r = await callPerplexity({
      apiKey, stage: "sonar", name, address, city, area, preUrl: null, verifyMode: false,
    });
    info = r?.ok ? parseEvidenceStage(name, "sonar", r.json, null, "low") : null;
  }

  const ttl = info ? POS_TTL_MS : NEG_TTL_MS;
  cache.set(cacheKey, { info, expireAt: Date.now() + ttl });
  return info;
}

