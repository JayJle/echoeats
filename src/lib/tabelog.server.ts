// Tabelog 信息抓取层（仅 JP 分支用）
// 不直接爬 Tabelog（ToS + 反爬），用 Perplexity sonar + search_domain_filter
// 让 Perplexity 代为读取 tabelog.com 并返回结构化结果。

export type TabelogInfo = {
  rating: string | null; // 例 "3.62"
  reviewCount: number | null; // 例 412
  url: string | null; // tabelog 店铺页 URL（必须包含 tabelog.com）
  priceRange: string | null; // 兼容旧缓存：合并价位
  dinnerBudget: string | null; // 例 "￥6,000〜￥7,999"
  lunchBudget: string | null; // 例 "￥1,000〜￥1,999"
  summary: string | null; // 1-2 句中文摘要
  topDishes: string[]; // 招牌菜，最多 4
  goodPoints: string[]; // 好评要点，最多 3，每条 ≤ 25 字
  badPoints: string[]; // 差评要点，最多 3，每条 ≤ 25 字
  reviewQuotes: string[]; // 食客原话节选（中文翻译），最多 2，每条 ≤ 40 字
  awards: string | null; // 例 "百名店 2024" / "Tabelog Award Bronze"
  recommendedScene: string | null; // 例 "约会 / 接待"
};

const cache = new Map<string, TabelogInfo | null>();

const cleanStr = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/<[^>]*>/g, "").trim();
  return s.length > 0 ? s.slice(0, max) : null;
};

const cleanArr = (v: unknown, maxItems: number, maxLen: number): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = cleanStr(item, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
};

export async function fetchTabelogInfo(
  name: string,
  address: string,
  city: string,
): Promise<TabelogInfo | null> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;

  const cacheKey = `v2|${name}|${address}`.toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

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
              "你是 Tabelog（食べログ）查询助手。只参考 tabelog.com 上目标店铺页面的真实信息（综合评分、口コミ、店舗情報、予算、おすすめメニュー、TabelogAward/百名店徽章等），输出结构化 JSON。任何字段读不到必须返回 null 或空数组，**严禁编造、严禁跨站补全**。",
          },
          {
            role: "user",
            content: `查找 Tabelog 上的店铺并提取信息：
- 店名：${name}
- 地址：${address}
- 城市：${city}

要求：
- 必须是 tabelog.com 上**真实存在**的店铺页（URL 形如 https://tabelog.com/xx/A.../...../...../）。店名+地址必须能合理对应；同名不同店一律算找不到。

字段说明（只要找到店铺页，url 必返回；其余读不到一律 null/[]，禁止编造）：
- url: tabelog.com 店铺页 URL（必须包含 "tabelog.com"）。
- rating: Tabelog 综合评分数字字符串，如 "3.62"。Tabelog 满分 5，3.5+ 即优秀。
- reviewCount: 口コミ件数（整数）。
- dinnerBudget: 「夜の予算」字段原文，如 "￥6,000〜￥7,999"。
- lunchBudget: 「ランチ予算」字段原文，如 "￥1,000〜￥1,999"。
- priceRange: 如果只有一个综合预算字段，填这里；否则与 dinnerBudget 一致即可。
- summary: 1-2 句简体中文，归纳店铺整体定位与口碑，≤ 60 字。
- topDishes: 口コミ/メニュー高频招牌菜名数组，最多 4 个；用日文原名或中文皆可，每条 ≤ 20 字。
- goodPoints: 高频好评要点（食材/服务/氛围/性价比等），最多 3 条简体中文，每条 ≤ 25 字。
- badPoints: 高频差评/吐槽（价格/嘈杂/服务等），最多 3 条简体中文，每条 ≤ 25 字。无明显差评 → []。
- reviewQuotes: 1-2 条具有代表性的食客口コミ原话，翻译为简体中文，每条 ≤ 40 字。
- awards: Tabelog 页面上是否标注 "百名店 YYYY"、"The Tabelog Award Bronze/Silver/Gold" 等荣誉。原文短语，否则 null。
- recommendedScene: 适合场景（如 "约会 / 接待"、"家庭聚餐"、"独食"），简体中文，≤ 20 字。

只输出 JSON 对象。如果找不到任何匹配店铺，所有字段返回 null/[]。`,
          },
        ],
        max_tokens: 900,
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
                dinnerBudget: { type: ["string", "null"] },
                lunchBudget: { type: ["string", "null"] },
                summary: { type: ["string", "null"] },
                topDishes: { type: "array", items: { type: "string" } },
                goodPoints: { type: "array", items: { type: "string" } },
                badPoints: { type: "array", items: { type: "string" } },
                reviewQuotes: { type: "array", items: { type: "string" } },
                awards: { type: ["string", "null"] },
                recommendedScene: { type: ["string", "null"] },
              },
              required: [
                "rating",
                "reviewCount",
                "url",
                "priceRange",
                "dinnerBudget",
                "lunchBudget",
                "summary",
                "topDishes",
                "goodPoints",
                "badPoints",
                "reviewQuotes",
                "awards",
                "recommendedScene",
              ],
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

    const rawUrl = typeof parsed.url === "string" ? (parsed.url as string).trim() : null;
    const urlFromJson = rawUrl && /tabelog\.com\//i.test(rawUrl) ? rawUrl : null;
    const url = urlFromJson ?? tabelogCitation;

    if (!url) {
      console.warn(`[Tabelog] ${name}: no tabelog.com url in JSON or citations`);
      cache.set(cacheKey, null);
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

    const dinnerBudget = cleanStr(parsed.dinnerBudget, 40);
    const lunchBudget = cleanStr(parsed.lunchBudget, 40);
    const priceRange = cleanStr(parsed.priceRange, 40) ?? dinnerBudget;
    const summary = cleanStr(parsed.summary, 120);
    const awards = cleanStr(parsed.awards, 40);
    const recommendedScene = cleanStr(parsed.recommendedScene, 30);
    const topDishes = cleanArr(parsed.topDishes, 4, 20);
    const goodPoints = cleanArr(parsed.goodPoints, 3, 25);
    const badPoints = cleanArr(parsed.badPoints, 3, 25);
    const reviewQuotes = cleanArr(parsed.reviewQuotes, 2, 40);

    console.log(
      `[Tabelog] ${name}: ok rating=${rating} reviews=${reviewCount} dishes=${topDishes.length} good=${goodPoints.length} quotes=${reviewQuotes.length}`,
    );

    const info: TabelogInfo = {
      rating,
      reviewCount,
      url,
      priceRange,
      dinnerBudget,
      lunchBudget,
      summary,
      topDishes,
      goodPoints,
      badPoints,
      reviewQuotes,
      awards,
      recommendedScene,
    };
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
