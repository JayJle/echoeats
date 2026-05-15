// Tabelog 信息抓取层（仅 JP 分支用）
// 不直接爬 Tabelog（ToS + 反爬），用 Perplexity sonar + search_domain_filter
// 让 Perplexity 代为读取 tabelog.com 并返回结构化结果。

export type TabelogInfo = {
  rating: string | null; // 例 "3.62"
  reviewCount: number | null; // 例 412
  url: string | null; // tabelog 店铺页 URL（必须包含 tabelog.com）
  priceRange: string | null; // 例 "￥6,000〜￥7,999"
  summary: string | null; // 1-2 句中文摘要
};

const cache = new Map<string, TabelogInfo | null>();

export async function fetchTabelogInfo(
  name: string,
  address: string,
  city: string,
): Promise<TabelogInfo | null> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;

  const cacheKey = `${name}|${address}`.toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content:
              "你是 Tabelog（食べログ）查询助手。只参考 tabelog.com 的页面，找到与给定店名+地址最匹配的那一家店铺页，输出结构化 JSON。找不到必须返回 null 字段，禁止编造。",
          },
          {
            role: "user",
            content: `查找 Tabelog 上的店铺：
- 店名：${name}
- 地址：${address}
- 城市：${city}

要求：
- 必须是 tabelog.com 上**真实存在**的店铺页（URL 形如 https://tabelog.com/xx/A.../...../...../）。
- 店名和地址必须能合理对应（同名不同店一律算找不到）。
- rating: Tabelog 综合评分（数字字符串，如 "3.62"）。Tabelog 评分体系特殊（满分 5，3.5+ 即优秀），原样返回。找不到 → null。
- reviewCount: 口コミ件数（整数）。找不到 → null。
- url: 该店铺 Tabelog 页面 URL（必须包含 "tabelog.com"）。找不到 → null。
- priceRange: "夜の予算" 或 "ランチ予算" 字段原文（如 "￥6,000〜￥7,999"）。找不到 → null。
- summary: 1-2 句简体中文，归纳 Tabelog 用户口碑（具体菜品/服务/氛围），≤ 60 字。找不到 → null。

只输出 JSON 对象。如果找不到任何匹配，所有字段返回 null。`,
          },
        ],
        max_tokens: 400,
        temperature: 0.1,
        search_domain_filter: ["tabelog.com"],
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
      }),
    });

    if (!res.ok) {
      console.warn(`[Tabelog] ${name}: HTTP ${res.status}`);
      cache.set(cacheKey, null);
      return null;
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    const citations: string[] = Array.isArray(json?.citations) ? json.citations : [];
    const tabelogCitation = citations.find((c) => typeof c === "string" && /tabelog\.com\//i.test(c)) ?? null;
    if (!content) {
      console.warn(`[Tabelog] ${name}: empty content (citations=${citations.length})`);
      cache.set(cacheKey, null);
      return null;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.warn(`[Tabelog] ${name}: JSON parse failed`);
      cache.set(cacheKey, null);
      return null;
    }

    // URL 优先取 JSON 内 url 字段，否则回落到 citations 中第一个 tabelog.com 链接
    const rawUrl = typeof parsed.url === "string" ? (parsed.url as string).trim() : null;
    const urlFromJson = rawUrl && /tabelog\.com\//i.test(rawUrl) ? rawUrl : null;
    const url = urlFromJson ?? tabelogCitation;

    if (!url) {
      console.warn(`[Tabelog] ${name}: no tabelog.com url in JSON or citations`);
      cache.set(cacheKey, null);
      return null;
    }

    const rating =
      typeof parsed.rating === "string" && /^\d(\.\d{1,2})?$/.test(parsed.rating.trim())
        ? parsed.rating.trim()
        : null;
    const reviewCount =
      typeof parsed.reviewCount === "number" && parsed.reviewCount >= 0
        ? Math.round(parsed.reviewCount)
        : null;
    const priceRange =
      typeof parsed.priceRange === "string" && parsed.priceRange.trim().length > 0
        ? parsed.priceRange.trim().slice(0, 40)
        : null;
    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim().length > 0
        ? parsed.summary.trim().slice(0, 120)
        : null;

    // 至少 rating 或 summary 二者之一有效，否则视为找不到
    if (rating == null && summary == null) {
      cache.set(cacheKey, null);
      return null;
    }

    const info: TabelogInfo = { rating, reviewCount, url, priceRange, summary };
    cache.set(cacheKey, info);
    return info;
  } catch (e) {
    console.warn(`[Tabelog] ${name}:`, e instanceof Error ? e.message : e);
    cache.set(cacheKey, null);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
