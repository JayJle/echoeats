// Shared evidence helpers: raw platform reviews, Perplexity chat call, official-site + web-supplement readers.
// Perplexity only reads first-hand content here; all analysis is done by our own ranking model.
import { withRetry } from "./retry.server";

export type PlatformReview = { text: string; rating: number | null; date: string | null };

export const PLATFORM_REVIEW_LIMIT = 6;
const REVIEW_CHAR_LIMIT = 300;

// JSON schema fragment for platform reviews (used by Tabelog / Yelp readers).
export const REVIEWS_JSON_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      text: { type: "string" },
      rating: { type: ["number", "null"] },
      date: { type: ["string", "null"] },
    },
    required: ["text", "rating", "date"],
  },
} as const;

export const REVIEWS_PROMPT_RULE = `reviews（最关键）：从店铺页上**原样摘录最多 ${PLATFORM_REVIEW_LIMIT} 条真实评论原文**（保持原语言，不翻译、不总结、不改写），每条截取最能说明菜品/服务/环境/价格的 ≤${REVIEW_CHAR_LIMIT} 字片段；尽量选最新的，并且好评差评都要有（如果存在低分评论，至少放 1–2 条）。每条带 rating（该条星级，读不到 null）和 date（日期原文，读不到 null）。读不到任何评论 → []。严禁编造或拼接不存在的评论。`;

export function parseReviews(raw: unknown): PlatformReview[] {
  if (!Array.isArray(raw)) return [];
  const out: PlatformReview[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim().slice(0, REVIEW_CHAR_LIMIT) : "";
    if (text.length < 8 || seen.has(text)) continue;
    seen.add(text);
    const rating = typeof o.rating === "number" && o.rating >= 0 && o.rating <= 5 ? o.rating : null;
    const date = typeof o.date === "string" && o.date.trim() ? o.date.trim().slice(0, 30) : null;
    out.push({ text, rating, date });
    if (out.length >= PLATFORM_REVIEW_LIMIT) break;
  }
  return out;
}

type ChatResult = { content: string | null; citations: string[] } | null;

export async function pplxChat(opts: {
  apiKey: string;
  model: "sonar" | "sonar-pro";
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  domainFilter?: string[];
  label: string;
}): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    max_tokens: opts.maxTokens,
    temperature: 0.1,
    response_format: { type: "json_schema", json_schema: { name: opts.schemaName, schema: opts.schema } },
  };
  if (opts.domainFilter?.length) body.search_domain_filter = opts.domainFilter;
  try {
    const res = await withRetry(
      (sig) =>
        fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          signal: sig,
          body: JSON.stringify(body),
        }).then((r) => {
          if (!r.ok && (r.status >= 500 || r.status === 429)) throw new Error(`${opts.label} upstream ${r.status}`);
          return r;
        }),
      { label: opts.label, retries: 1, timeoutMs: 20_000 },
    );
    if (!res.ok) {
      console.warn(`[${opts.label}] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as Record<string, unknown>;
    const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
    const citations = Array.isArray(json.citations)
      ? (json.citations as unknown[]).filter((c): c is string => typeof c === "string")
      : [];
    return { content: choices?.[0]?.message?.content ?? null, citations };
  } catch (e) {
    console.warn(`[${opts.label}]`, e instanceof Error ? e.message : e);
    return null;
  }
}

function safeJson(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

const str = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

// ===================== Official website =====================

export type MenuItem = { name: string; price: string | null };
export type OfficialSiteInfo = {
  url: string;
  intro: string | null;
  menu: MenuItem[];
  signatureDishes: string[];
  priceRange: string | null;
  address: string | null;
  hours: string | null;
  reservation: string | null;
};

// Hosts that are not an official site (social / booking / aggregator).
const NON_OFFICIAL_HOST_RE =
  /(instagram|facebook|fb\.com|twitter|x\.com|tiktok|linktr\.ee|yelp\.|tabelog|tripadvisor|google\.|opentable|resy\.com|tock|ubereats|doordash|grubhub|deliveroo|thefork|lafourchette|hotpepper|gurunavi|retty|ikyu|tablecheck|toreta|ebica|sevenrooms|exploretock|squareup|toasttab|wolt|seamless|postmates)/i;

export function officialDomain(websiteUri: string | null): string | null {
  if (!websiteUri) return null;
  try {
    const host = new URL(websiteUri).hostname.replace(/^www\./, "");
    if (NON_OFFICIAL_HOST_RE.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

const officialCache = new Map<string, OfficialSiteInfo | null>();

const OFFICIAL_SCHEMA = {
  type: "object",
  properties: {
    url: { type: ["string", "null"] },
    intro: { type: ["string", "null"] },
    menu: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, price: { type: ["string", "null"] } },
        required: ["name", "price"],
      },
    },
    signatureDishes: { type: "array", items: { type: "string" } },
    priceRange: { type: ["string", "null"] },
    address: { type: ["string", "null"] },
    hours: { type: ["string", "null"] },
    reservation: { type: ["string", "null"] },
  },
  required: ["url", "intro", "menu", "signatureDishes", "priceRange", "address", "hours", "reservation"],
};

export async function fetchOfficialSite(opts: {
  name: string;
  address: string;
  city: string;
  websiteUri: string | null;
}): Promise<OfficialSiteInfo | null> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;
  const { name, address, city, websiteUri } = opts;
  const cacheKey = `${name}|${address}`.toLowerCase();
  if (officialCache.has(cacheKey)) return officialCache.get(cacheKey) ?? null;

  const domain = officialDomain(websiteUri);
  const where = domain
    ? `官网：${websiteUri}（只读这个网站的页面：首页、About、Menu/Carte/お品書き、Access、Reservation 等）`
    : `Google 上没有可用的官网链接。请搜索这家店**自己的官方网站**（不是 Instagram/Facebook/Yelp/Tabelog/订餐平台）。找不到就所有字段返回 null / []。`;
  const user = `读取这家餐厅官方网站上的一手信息：
- 店名：${name}
- 地址：${address}
- 城市：${city}
- ${where}

要求：
- 网站上的店名和地址必须能对上这家店；对不上 → 所有字段返回 null / []。
- url：实际读取的官网页面 URL。
- intro：官网上的餐厅介绍原文摘录（保持原语言，≤300 字），读不到 null。
- menu：官网菜单上的菜品，原样抄录菜名和价格（价格保持原文含币种），最多 20 项；优先招牌菜/套餐；没有菜单 → []。
- signatureDishes：官网明确标注的招牌菜/推荐菜（最多 5 个，原文），没有 → []。
- priceRange：官网写明的价格区间/套餐价原文，读不到 null。
- address / hours / reservation：官网写的地址、营业时间、预约方式原文，读不到 null。
- 严禁编造；只抄录页面上实际存在的内容。

只输出 JSON。`;
  const r = await pplxChat({
    apiKey,
    model: "sonar",
    system: "你是餐厅官网读取助手。只摘录官网页面上真实存在的内容，不总结、不编造。",
    user,
    schemaName: "official_site",
    schema: OFFICIAL_SCHEMA,
    maxTokens: 1500,
    domainFilter: domain ? [domain] : undefined,
    label: "official-site",
  });
  const j = safeJson(r?.content ?? null);
  let info: OfficialSiteInfo | null = null;
  if (j) {
    const menu: MenuItem[] = Array.isArray(j.menu)
      ? (j.menu as unknown[])
          .map((m) => {
            const o = (m ?? {}) as Record<string, unknown>;
            const n = str(o.name, 80);
            return n ? { name: n, price: str(o.price, 40) } : null;
          })
          .filter((m): m is MenuItem => m !== null)
          .slice(0, 20)
      : [];
    const signatureDishes = Array.isArray(j.signatureDishes)
      ? (j.signatureDishes as unknown[]).map((d) => str(d, 60)).filter((d): d is string => !!d).slice(0, 5)
      : [];
    const intro = str(j.intro, 300);
    const urlRaw = str(j.url, 300);
    const citedOfficial = r?.citations.find((c) => {
      try {
        const h = new URL(c).hostname.replace(/^www\./, "");
        return domain ? h.endsWith(domain) : !NON_OFFICIAL_HOST_RE.test(h);
      } catch {
        return false;
      }
    });
    const url =
      (urlRaw && !NON_OFFICIAL_HOST_RE.test(urlRaw) ? urlRaw : null) ??
      (domain ? websiteUri : null) ??
      citedOfficial ??
      null;
    const hasContent = !!(intro || menu.length || signatureDishes.length || str(j.priceRange, 80));
    if (url && hasContent) {
      info = {
        url,
        intro,
        menu,
        signatureDishes,
        priceRange: str(j.priceRange, 80),
        address: str(j.address, 160),
        hours: str(j.hours, 200),
        reservation: str(j.reservation, 120),
      };
    }
  }
  console.log(
    `[OfficialSite] ${name}: ${info ? `ok menu=${info.menu.length} sig=${info.signatureDishes.length} intro=${info.intro ? "y" : "n"}` : "miss"} domain=${domain ?? "search"}`,
  );
  officialCache.set(cacheKey, info);
  return info;
}

// ===================== On-demand web supplement =====================

export type WebSnippet = { topic: string; text: string; sourceUrl: string | null };

export async function fetchWebSupplement(opts: {
  name: string;
  address: string;
  city: string;
  topics: string[];
}): Promise<WebSnippet[]> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey || opts.topics.length === 0) return [];
  const topics = opts.topics.slice(0, 5);
  const r = await pplxChat({
    apiKey,
    model: "sonar",
    system: "你是网络资料摘录助手。只摘录网页上真实存在的原文片段并给出来源 URL，不总结、不编造。",
    user: `在网上查找这家餐厅关于下列问题的一手信息：
- 店名：${opts.name}
- 地址：${opts.address}
- 城市：${opts.city}

问题：
${topics.map((t, i) => `${i + 1}. ${t}`).join("\n")}

要求：每个问题最多 2 条原文片段（保持原语言，≤200 字），必须是关于**这家店**的（店名+地址对得上），附 sourceUrl。找不到就不要输出该问题。只输出 JSON。`,
    schemaName: "web_supplement",
    schema: {
      type: "object",
      properties: {
        snippets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              topic: { type: "string" },
              text: { type: "string" },
              sourceUrl: { type: ["string", "null"] },
            },
            required: ["topic", "text", "sourceUrl"],
          },
        },
      },
      required: ["snippets"],
    },
    maxTokens: 900,
    label: "web-supplement",
  });
  const j = safeJson(r?.content ?? null);
  const out: WebSnippet[] = Array.isArray(j?.snippets)
    ? (j!.snippets as unknown[])
        .map((s) => {
          const o = (s ?? {}) as Record<string, unknown>;
          const text = str(o.text, 200);
          return text ? { topic: str(o.topic, 80) ?? "", text, sourceUrl: str(o.sourceUrl, 300) } : null;
        })
        .filter((s): s is WebSnippet => s !== null)
        .slice(0, 8)
    : [];
  console.log(`[WebSupplement] ${opts.name}: snippets=${out.length} topics=${topics.length}`);
  return out;
}
