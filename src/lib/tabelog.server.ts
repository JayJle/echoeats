// Tabelog 信息抓取层（仅 JP 分支用）
// 不直接爬 Tabelog（ToS + 反爬），用 Perplexity 让其代为读取 tabelog.com 并返回结构化结果。
// 三阶段策略：
//   Stage 0: 多变体 /search 预搜（含 name+area+city+cuisine），打分挑最真实候选页
//   Stage 1: sonar + search_domain_filter=tabelog.com（快、便宜），带 preUrl 提示
//   Stage 2: sonar-pro + site: 提示（更强推理），仅在 Stage 1 失败时

export type TabelogPriceJPY = { low: number | null; high: number | null };

export type TabelogInfo = {
  rating: string | null; // 例 "3.62"
  reviewCount: number | null; // 例 412
  url: string | null; // tabelog 店铺页 URL（必须包含 tabelog.com）
  priceRange: string | null; // 例 "￥6,000〜￥7,999"（原文）
  priceJPY: TabelogPriceJPY | null; // 解析后的数字区间（JPY）
  summary: string | null; // 1 句中文短摘要，前端展示
  signals: string[]; // 后台隐藏评论信号，最多 8 条，每条 ≤35 字
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

    const priorityBlock = `**字段优先级（按顺序尽力读）**：
1. **summary（评论口碑，最关键）**：基于真实 Tabelog 口コミ 文本归纳具体菜品/服务/氛围；能读到一定要写，宁可短不要空，禁止编造。
2. **rating（综合评分）/ reviewCount（口コミ件数）**：直接读页面字段。
3. **priceRange（夜の予算/ランチ予算）**：读到就给。`;

    const hintLine = preUrl
      ? `\n候选 Tabelog 店铺页 URL：${preUrl}\n请优先打开该页面核验店名+地址是否吻合，吻合则原样返回 url 并读取字段。\n`
      : "";

    const cuisineLine = cuisine ? `- 料理类型：${cuisine}\n` : "";

    const userPrompt = isFirst
      ? `查找 Tabelog 上的店铺：
- 店名：${name}
- 地址：${address}
- 城市：${city}
- 行政区提示：${area || "（未知）"}
${cuisineLine}${hintLine}
${priorityBlock}

其它要求：
- 必须是 tabelog.com 上**真实存在**的店铺页（URL 形如 https://tabelog.com/<pref>/A.../...../<数字>/，例 tabelog.com/tokyo/A1301/A130101/13001234/）。**绝对不要返回搜索页/分类页/列表页 URL**。
- 店名和地址必须能合理对应；同名不同店一律算找不到，宁可返回 null。
- url: 找到即返回；即使评分/口コミ件数/价位/摘要暂时读取不到，也照常返回 url。
- rating: Tabelog 综合评分（数字字符串如 "3.62"）。读不到 → null。
- reviewCount: 口コミ件数（整数）。读不到 → null。
- priceRange: "夜の予算" 或 "ランチ予算" 字段原文（如 "￥6,000〜￥7,999"）。读不到 → null。
- summary: 1-2 句简体中文，归纳口碑（具体菜品/服务/氛围），≤ 60 字。读不到 → null。

只输出 JSON。找不到任何匹配店铺时，所有字段返回 null。`
      : `请用 Google 搜索 \`site:tabelog.com "${name}" "${area || city}"\` 找到该店在 Tabelog 的店铺页，然后读取评分/口コミ件数/价位/摘要。

店铺信息：
- 店名：${name}
- Google 地址：${address}
- 城市：${city}
- 期望行政区：${area || "（未知，按城市判断）"}
${cuisineLine}${hintLine}
${priorityBlock}

严格要求：
- 必须返回**店铺详情页** URL（形如 https://tabelog.com/<pref>/A.../...../<数字>/）。**禁止返回搜索/列表/排行榜页**。
- 该店铺页的地址必须落在「${area || city}」内；落在其它行政区的同名店一律视为不匹配。
- 即便没有评分/价位也要返回 url；只在确认 Tabelog 上没有这家店时全部返回 null。
- rating / reviewCount / priceRange / summary 同第一轮规则；读不到原样返回 null，禁止编造。

只输出 JSON。`;

    const body: Record<string, unknown> = {
      model: isFirst ? "sonar" : "sonar-pro",
      messages: [
        {
          role: "system",
          content:
            "你是 Tabelog（食べログ）查询助手。只参考 tabelog.com 的真实页面，找到与给定店名+地址最匹配的店铺页，输出结构化 JSON。找不到必须返回 null 字段，禁止编造。",
        },
        { role: "user", content: userPrompt },
      ],
      max_tokens: isFirst ? 400 : 700,
      temperature: 0.1,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "tabelog_info",
          schema: {
            type: "object",
            properties: {
              rating: { type: ["string", "null"] },
              reviewCount: { type: ["number", "null"] },
              url: { type: ["string", "null"] },
              priceRange: { type: ["string", "null"] },
              summary: { type: ["string", "null"] },
            },
            required: ["rating", "reviewCount", "url", "priceRange", "summary"],
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
          // 内层用 retry signal；外层 controller 仍保留 20s 兜底总超时
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

function parseStage(name: string, stage: Stage, raw: unknown, preUrl: string | null): TabelogInfo | null {
  const json = raw as Record<string, unknown> | null;
  if (!json) return null;
  const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content;
  const citations: string[] = Array.isArray(json.citations)
    ? (json.citations as unknown[]).filter((c): c is string => typeof c === "string")
    : [];

  // 只接受店铺详情页 URL
  const tabelogCitation = citations.find((c) => TABELOG_SHOP_URL_RE.test(c)) ?? null;

  if (!content) {
    const url = preUrl ?? tabelogCitation;
    if (url) {
      console.log(`[Tabelog/${stage}] ${name}: empty content but url available → url-only`);
      return {
        rating: null,
        reviewCount: null,
        url,
        priceRange: null,
        priceJPY: null,
        summary: null,
      };
    }
    console.warn(`[Tabelog/${stage}] ${name}: empty content & no shop-page url`);
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    console.warn(`[Tabelog/${stage}] ${name}: parse_error`);
    return null;
  }

  const rawUrl = typeof parsed.url === "string" ? parsed.url.trim() : null;
  const urlFromJson = rawUrl && TABELOG_SHOP_URL_RE.test(rawUrl) ? rawUrl : null;
  const url = urlFromJson ?? preUrl ?? tabelogCitation;

  if (!url) {
    console.warn(`[Tabelog/${stage}] ${name}: no shop-page url in JSON or citations`);
    return null;
  }

  const ratingRaw = parsed.rating;
  const rating =
    typeof ratingRaw === "string" && /^\d(\.\d{1,2})?$/.test(ratingRaw.trim())
      ? ratingRaw.trim()
      : typeof ratingRaw === "number" && ratingRaw > 0 && ratingRaw <= 5
        ? ratingRaw.toFixed(2)
        : null;
  const reviewCount =
    typeof parsed.reviewCount === "number" && parsed.reviewCount >= 0
      ? Math.round(parsed.reviewCount)
      : null;
  const priceRange =
    typeof parsed.priceRange === "string" && parsed.priceRange.trim().length > 0
      ? parsed.priceRange.trim().slice(0, 60)
      : null;
  const priceJPY = parseTabelogPriceJPY(priceRange);
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim().length > 0
      ? parsed.summary.trim().slice(0, 120)
      : null;

  console.log(
    `[Tabelog/${stage}] ${name}: ok rating=${rating} reviews=${reviewCount} price=${priceRange ?? "-"} priceJPY=${priceJPY ? `${priceJPY.low ?? "-"}~${priceJPY.high ?? "-"}` : "-"}`,
  );

  return { rating, reviewCount, url, priceRange, priceJPY, summary };
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

  // Stage 0：多变体预搜，挑最真实候选页 URL
  const preUrl = await preSearchTabelog({ apiKey, name, city, address, cuisine });

  // Stage 1
  const r1 = await callPerplexity({
    apiKey, stage: "sonar", name, address, city, area, cuisine, preUrl,
  });
  let info = r1?.ok ? parseStage(name, "sonar", r1.json, preUrl) : null;

  // Stage 2 fallback
  if (!info) {
    const r2 = await callPerplexity({
      apiKey, stage: "sonar-pro", name, address, city, area, cuisine, preUrl,
    });
    info = r2?.ok ? parseStage(name, "sonar-pro", r2.json, preUrl) : null;
  }

  cache.set(cacheKey, info);
  return info;
}
