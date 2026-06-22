// Tabelog 信息抓取层（仅 JP 分支用）
// 不直接爬 Tabelog（ToS + 反爬），用 Perplexity 让其代为读取 tabelog.com 并返回结构化结果。
// 三阶段策略：
//   Stage 0: 多变体 /search 预搜（含 name+area+city+cuisine），打分挑最真实候选页
//   Stage 1: sonar + search_domain_filter=tabelog.com（快、便宜），带 preUrl 提示
//   Stage 2: sonar-pro + site: 提示（更强推理），仅在 Stage 1 失败时

export type TabelogPriceJPY = { low: number | null; high: number | null };

export type TabelogEvidence = {
  matchEvidence: string[];
  fieldEvidence: string[];
  reviewEvidence: string[];
  pageSignals: string[];
};

// rating/reviewCount/priceRange/summary 默认 null：由下游 DeepSeek 排序时从 evidence 中提取。
// 保留这些字段是为了 UI 兼容；displayFields 合并后会覆盖。
export type TabelogInfo = {
  rating: string | null;
  reviewCount: number | null;
  url: string | null;
  priceRange: string | null;
  priceJPY: TabelogPriceJPY | null;
  summary: string | null;
  evidence: TabelogEvidence | null;
};

const cache = new Map<string, TabelogInfo | null>();

// tabelog 店铺页 URL：tabelog.com/<region>/A.../...../<digits>/
// 例：https://tabelog.com/tokyo/A1301/A130101/13001234/
const TABELOG_SHOP_URL_RE = /https?:\/\/(?:www\.|s\.)?tabelog\.com\/[a-z\-]+\/A\d+\/A\d+\/\d+\/?/i;

// 从 Google 地址里抽出 都道府県 + 区/市/町 提示给 Perplexity
function extractJPArea(address: string): string {
  if (!address) return "";
  // 常见形态："Japan, 〒150-0001 東京都渋谷区神宮前1-2-3" 或 "東京都渋谷区..."
  const m = address.match(
    /([\u4e00-\u9fff]{2,4}(?:都|道|府|県))?\s*([\u4e00-\u9fff]{1,8}(?:区|市|町|村))?/,
  );
  const pref = m?.[1] ?? "";
  const ward = m?.[2] ?? "";
  return [pref, ward].filter(Boolean).join(" ");
}

// 都道府县中文/日文 → tabelog URL 路径段
const PREF_TO_PATH: Record<string, string> = {
  東京: "tokyo", 东京: "tokyo",
  大阪: "osaka", 京都: "kyoto",
  神奈川: "kanagawa", 横浜: "kanagawa", 横滨: "kanagawa",
  愛知: "aichi", 爱知: "aichi", 名古屋: "aichi",
  福岡: "fukuoka", 福冈: "fukuoka",
  北海道: "hokkaido", 札幌: "hokkaido",
  兵庫: "hyogo", 兵库: "hyogo", 神戸: "hyogo", 神户: "hyogo",
  沖縄: "okinawa", 冲绳: "okinawa",
};

function prefPathHint(area: string, city: string): string | null {
  const combined = `${area} ${city}`;
  for (const [k, v] of Object.entries(PREF_TO_PATH)) {
    if (combined.includes(k)) return v;
  }
  return null;
}

// 解析 Tabelog 价位字符串到数字区间 (JPY)
// 支持：
//   "￥6,000〜￥7,999" / "¥6000～¥7999"
//   "￥10,000～" / "～￥3,000" / "〜￥3,000"
//   "￥3,000"（单值）
export function parseTabelogPriceJPY(raw: string | null): TabelogPriceJPY | null {
  if (!raw) return null;
  const s = raw.replace(/,/g, "").replace(/[¥￥]/g, "¥").trim();
  // 提取所有 ¥数字
  const nums = Array.from(s.matchAll(/¥\s*(\d{2,7})/g)).map((m) => parseInt(m[1], 10));
  if (nums.length === 0) return null;
  const hasUpperOpen = /[〜～~]\s*$/.test(s); // "￥10,000～"
  const hasLowerOpen = /^\s*[〜～~]/.test(s); // "～￥3,000"
  if (nums.length === 1) {
    if (hasUpperOpen) return { low: nums[0], high: null };
    if (hasLowerOpen) return { low: null, high: nums[0] };
    // 单值：当作"约该价位"，给 ±0 区间
    return { low: nums[0], high: nums[0] };
  }
  const [a, b] = nums;
  return { low: Math.min(a, b), high: Math.max(a, b) };
}

// =========================================================================
// Stage 0: 多变体预搜 + 真实性打分
// =========================================================================

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
      console.warn(`[Tabelog/search:${label}] ${name}: HTTP ${res.status}`);
      return [];
    }
    const json = (await res.json()) as Record<string, unknown>;
    const results = (json.results ?? json.data ?? []) as Array<Record<string, unknown>>;
    return results
      .map((r) => ({
        url: typeof r.url === "string" ? r.url : "",
        title: typeof r.title === "string" ? r.title : "",
        snippet:
          typeof r.snippet === "string"
            ? r.snippet
            : typeof r.description === "string"
              ? r.description
              : "",
      }))
      .filter((r) => r.url && TABELOG_SHOP_URL_RE.test(r.url));
  } catch (e) {
    console.warn(`[Tabelog/search:${label}] ${name}:`, e instanceof Error ? e.message : e);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff]+/g, " ")
    .trim();
}

function nameTokens(name: string): string[] {
  return normalizeToken(name)
    .split(" ")
    .filter((t) => t.length >= 1);
}

type ScoredCandidate = { url: string; score: number; appearances: number };

function scoreTabelogCandidates(
  batches: SearchResult[][],
  name: string,
  area: string,
  city: string,
  cuisine?: string,
): ScoredCandidate[] {
  const nameToks = nameTokens(name);
  const cuisineToks = cuisine ? nameTokens(cuisine) : [];
  const prefPath = prefPathHint(area, city); // e.g. "tokyo"

  const byUrl = new Map<string, { score: number; appearances: number }>();

  for (const batch of batches) {
    const seenInBatch = new Set<string>();
    for (const r of batch) {
      if (seenInBatch.has(r.url)) continue;
      seenInBatch.add(r.url);

      const urlLower = r.url.toLowerCase();
      const titleNorm = normalizeToken(r.title);
      const snippetNorm = normalizeToken(r.snippet);

      let score = 0;
      // 店名 token 命中 title/snippet
      const nameHits = nameToks.filter(
        (t) => titleNorm.includes(t) || snippetNorm.includes(t),
      ).length;
      if (nameToks.length > 0) {
        const ratio = nameHits / nameToks.length;
        if (ratio >= 0.7) score += 3;
        else if (ratio >= 0.4) score += 2;
        else if (ratio > 0) score += 1;
      }
      // 都道府县路径命中（/tokyo/、/osaka/ 等）
      if (prefPath && urlLower.includes(`/${prefPath}/`)) score += 2;
      // cuisine 关键词命中 snippet/title
      if (cuisineToks.length > 0) {
        const cuisineHit = cuisineToks.some(
          (t) => snippetNorm.includes(t) || titleNorm.includes(t),
        );
        if (cuisineHit) score += 1;
      }

      const prev = byUrl.get(r.url);
      if (prev) {
        prev.appearances += 1;
        prev.score = Math.max(prev.score, score);
      } else {
        byUrl.set(r.url, { score, appearances: 1 });
      }
    }
  }

  const scored: ScoredCandidate[] = [];
  for (const [url, v] of byUrl.entries()) {
    // 多变体重复命中 → 更真实
    const repeatBonus = v.appearances >= 3 ? 2 : v.appearances >= 2 ? 1 : 0;
    scored.push({ url, score: v.score + repeatBonus, appearances: v.appearances });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

async function preSearchTabelog(opts: {
  apiKey: string;
  name: string;
  city: string;
  address: string;
  cuisine?: string;
}): Promise<string | null> {
  const { apiKey, name, city, address, cuisine } = opts;
  const area = extractJPArea(address);
  const where = area || city;

  const queries: Array<{ q: string; label: string }> = [
    { q: `"${name}" ${where} site:tabelog.com`, label: "name+area" },
  ];
  if (cuisine && cuisine.trim()) {
    queries.push({
      q: `"${name}" ${where} ${city} ${cuisine} site:tabelog.com`,
      label: "name+area+city+cuisine",
    });
  }

  const batches = await Promise.all(
    queries.map((q) => perplexitySearch({ apiKey, query: q.q, label: q.label, name })),
  );
  let scored = scoreTabelogCandidates(batches, name, area, city, cuisine);

  // 全空兜底
  if (scored.length === 0) {
    const fallback = await perplexitySearch({
      apiKey,
      query: `${name} site:tabelog.com`,
      label: "name-only",
      name,
    });
    scored = scoreTabelogCandidates([fallback], name, area, city, cuisine);
  }

  if (scored.length === 0) {
    console.log(`[Tabelog/search] ${name}: no candidates`);
    return null;
  }
  const top = scored[0];
  console.log(
    `[Tabelog/search] ${name}: top=${top.url} score=${top.score} appearances=${top.appearances} (${scored.length} candidates, ${queries.length} variants)`,
  );
  return top.url;
}

// =========================================================================
// Stage 1/2: Perplexity chat 读取字段
// =========================================================================

type Stage = "sonar" | "sonar-pro";

// 调 Perplexity 拉 evidence 包：URL + 4 类短引用（不再让 Perplexity 直接产业务字段）。
async function callPerplexity(opts: {
  apiKey: string;
  stage: Stage;
  name: string;
  address: string;
  city: string;
  area: string;
  cuisine?: string;
  preUrl: string | null;
}): Promise<{ json: unknown; ok: boolean; status: number } | null> {
  const { apiKey, stage, name, address, city, area, cuisine, preUrl } = opts;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const isFirst = stage === "sonar";
    const hintLine = preUrl
      ? `\n候选 Tabelog 详情页：${preUrl}\n先打开页面核验店名+地址是否吻合，吻合再摘 evidence；不吻合 url=null。\n`
      : "";
    const cuisineLine = cuisine ? `- 料理类型：${cuisine}\n` : "";

    const userPrompt = isFirst
      ? `从 Tabelog（食べログ）上为这家店收集**证据片段**（不要做归纳，不要写结论）：
- 店名：${name}
- 地址：${address}
- 城市：${city}
- 行政区提示：${area || "（未知）"}
${cuisineLine}${hintLine}
**任务**：找到该店的 Tabelog 店铺详情页（https://tabelog.com/<pref>/A.../...../<数字>/，禁止搜索/列表页），输出 JSON：

\`\`\`
{
  "url": "https://tabelog.com/...",
  "matchEvidence":  [2-3 条，必须含店名 + 地址原文（用来核验是否同一家店）],
  "fieldEvidence":  [3-5 条，包含 总合点数原文、口コミ件数原文、夜の予算/ランチ予算原文、ジャンル],
  "reviewEvidence": [6-8 条，从真实 口コミ 里摘的**原话片段**，覆盖料理/接客/雰囲気/コスパ],
  "pageSignals":    [3-5 条，营业时间/电话/最寄駅/招牌菜]
}
\`\`\`

硬规则：
- 每条 evidence 80–120 字符；超过截断；不要翻译或改写，保留日文/中文原文。
- 找不到的字段给空数组 []，**禁止编造**。
- url 必须是真实店铺详情页；同名不同区一律视为不匹配 → url=null + 全空数组。
- 只输出 JSON，不要前后说明。`
      : `请用 Google 搜索 \`site:tabelog.com "${name}" "${area || city}"\` 找到该店在 Tabelog 的店铺页，然后采集 evidence。

店铺信息：
- 店名：${name}
- 地址：${address}
- 城市：${city}
- 期望行政区：${area || "（未知，按城市判断）"}
${cuisineLine}${hintLine}
**任务**：输出 JSON：

\`\`\`
{
  "url": "https://tabelog.com/...",
  "matchEvidence":  [2-3 条，必须含店名 + 地址原文],
  "fieldEvidence":  [3-5 条，rating/口コミ件数/夜の予算/ランチ予算/ジャンル 原文],
  "reviewEvidence": [6-8 条，真实口コミ原话片段],
  "pageSignals":    [3-5 条，营业时间/最寄駅/招牌菜]
}
\`\`\`

硬规则：
- 必须返回**店铺详情页** URL（形如 https://tabelog.com/<pref>/A.../...../<数字>/）；禁止搜索/列表页。
- 店铺地址必须落在「${area || city}」内；不在则 url=null。
- 每条 evidence 80–120 字符，原文保留，禁止编造；只输出 JSON。`;

    const body: Record<string, unknown> = {
      model: isFirst ? "sonar" : "sonar-pro",
      messages: [
        {
          role: "system",
          content:
            "你是 Tabelog 证据采集助手：只摘原文片段，不归纳、不产业务字段、不打分。同名不同区 → url=null。",
        },
        { role: "user", content: userPrompt },
      ],
      max_tokens: isFirst ? 600 : 900,
      temperature: 0.1,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "tabelog_evidence",
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
    if (isFirst) {
      body.search_domain_filter = ["tabelog.com"];
    }

    const res = await (await import("./retry.server")).withRetry(
      (sig) =>
        fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          signal: sig ?? controller.signal,
          body: JSON.stringify(body),
        }).then((r) => {
          if (!r.ok && (r.status >= 500 || r.status === 429)) {
            throw new Error(`Tabelog upstream ${r.status}`);
          }
          return r;
        }),
      { label: `tabelog.${stage}`, retries: 1, timeoutMs: 15_000 },
    );
    if (!res.ok) {
      console.warn(`[Tabelog/${stage}] ${name}: HTTP ${res.status}`);
      return { json: null, ok: false, status: res.status };
    }
    const json = await res.json();
    return { json, ok: true, status: 200 };
  } catch (e) {
    console.warn(`[Tabelog/${stage}] ${name}:`, e instanceof Error ? e.message : e);
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

function emptyEvidence(): TabelogEvidence {
  return { matchEvidence: [], fieldEvidence: [], reviewEvidence: [], pageSignals: [] };
}

function urlOnlyInfo(url: string, evidence: TabelogEvidence | null): TabelogInfo {
  return {
    rating: null,
    reviewCount: null,
    url,
    priceRange: null,
    priceJPY: null,
    summary: null,
    evidence,
  };
}

function parseEvidenceStage(
  name: string,
  stage: Stage,
  raw: unknown,
  preUrl: string | null,
): TabelogInfo | null {
  const json = raw as Record<string, unknown> | null;
  if (!json) return null;
  const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content;
  const citations: string[] = Array.isArray(json.citations)
    ? (json.citations as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  const tabelogCitation = citations.find((c) => TABELOG_SHOP_URL_RE.test(c)) ?? null;

  if (!content) {
    const url = preUrl ?? tabelogCitation;
    if (url) {
      console.log(`[Tabelog/${stage}] ${name}: empty content but url available → url-only`);
      return urlOnlyInfo(url, null);
    }
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    const url = preUrl ?? tabelogCitation;
    return url ? urlOnlyInfo(url, null) : null;
  }

  const rawUrl = typeof parsed.url === "string" ? parsed.url.trim() : null;
  const urlFromJson = rawUrl && TABELOG_SHOP_URL_RE.test(rawUrl) ? rawUrl : null;
  const verifyRejected = parsed.url === null;
  const url = urlFromJson ?? (verifyRejected ? null : (preUrl ?? tabelogCitation));
  if (!url) return null;

  const evidence: TabelogEvidence = {
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
    `[Tabelog/${stage}] ${name}: ok url=${url.slice(0, 60)} evidence=${totalEv}(m${evidence.matchEvidence.length}/f${evidence.fieldEvidence.length}/r${evidence.reviewEvidence.length}/s${evidence.pageSignals.length})`,
  );

  return urlOnlyInfo(url, totalEv > 0 ? evidence : emptyEvidence());
}

function hasUsefulEvidence(info: TabelogInfo | null): boolean {
  if (!info || !info.evidence) return false;
  return info.evidence.reviewEvidence.length > 0 || info.evidence.fieldEvidence.length > 0;
}

export async function fetchTabelogInfo(
  name: string,
  address: string,
  city: string,
  cuisine?: string,
): Promise<TabelogInfo | null> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;

  const cacheKey = `${name}|${address}`.toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const area = extractJPArea(address);
  const preUrl = await preSearchTabelog({ apiKey, name, city, address, cuisine });

  const r1 = await callPerplexity({
    apiKey, stage: "sonar", name, address, city, area, cuisine, preUrl,
  });
  let info = r1?.ok ? parseEvidenceStage(name, "sonar", r1.json, preUrl) : null;

  if (!info || !hasUsefulEvidence(info)) {
    const r2 = await callPerplexity({
      apiKey, stage: "sonar-pro", name, address, city, area, cuisine, preUrl: info?.url ?? preUrl,
    });
    const info2 = r2?.ok ? parseEvidenceStage(name, "sonar-pro", r2.json, info?.url ?? preUrl) : null;
    if (info2) info = info2;
  }

  cache.set(cacheKey, info);
  return info;
}

