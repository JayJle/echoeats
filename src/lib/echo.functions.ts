import { createServerFn } from "@tanstack/react-start";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway";

const PLATFORMS = ["Google Maps", "Tabelog", "Yelp", "大众点评", "美团"];

const ParseInput = z.object({
  city: z.string().min(1),
  cuisines: z.array(z.string()).default([]),
  autoInferCuisines: z.boolean().default(true),
  date: z.string().default(""),
  freeText: z.string().default(""),
  uiLanguage: z.enum(["zh", "en"]).default("zh"),
});


// 宽松的 weight：接受字符串/越界数字/缺失，归一到 [0.1, 1.0]
const WeightCoerced = z.preprocess((v) => {
  if (v == null || v === "") return 0.7;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || Number.isNaN(n)) return 0.7;
  if (n > 1 && n <= 10) return n / 10; // 模型偶尔输出 0-10
  return Math.max(0.1, Math.min(1, n));
}, z.number().min(0).max(1));

const WeightedConditionSchema = z.object({
  text: z.string(),
  weight: WeightCoerced.default(0.7),
});

// hhmm：允许 "7:00" / "07:00" / 不规范字符串；非法时归 null
const HhmmCoerced = z.preprocess((v) => {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}, z.string().regex(/^\d{2}:\d{2}$/).nullable());

const WeekdayCoerced = z.preprocess((v) => {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || Number.isNaN(n)) return null;
  if (n < 0 || n > 6) return null;
  return Math.floor(n);
}, z.number().int().min(0).max(6).nullable());

const VisitTimeSchema = z
  .object({
    mentioned: z.boolean().default(false),
    evidence: z.string().default(""),
    weekday: WeekdayCoerced.default(null),
    hhmm: HhmmCoerced.default(null),
    raw: z.string().default(""),
  })
  .nullable()
  .optional()
  .catch(null)
  .default(null);

const ParsedSchema = z.object({
  city: z.string().default(""),
  cuisines: z.array(z.string()).default([]),
  dateTime: z.string().default(""),
  hardFilters: z.array(WeightedConditionSchema).catch([]).default([]),
  softPreferences: z.array(WeightedConditionSchema).catch([]).default([]),
  negativeFilters: z.array(WeightedConditionSchema).catch([]).default([]),
  dishPreferences: z.array(z.string()).catch([]).default([]),
  cuisineLevelConstraints: z.array(WeightedConditionSchema).catch([]).default([]),
  cuisinesInferred: z.boolean().catch(false).default(false),
  searchStrategy: z.array(z.string()).catch([]).default([]),
  country: z.string().default(""), // ISO 3166-1 alpha-2
  language: z.string().default(""), // BCP 47
  mode: z.enum(["quick", "deep"]).catch("deep").default("deep"),
  visitTime: VisitTimeSchema,
  uiLanguage: z.enum(["zh", "en"]).catch("zh").default("zh"),
});

export const parseRequirements = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ParseInput.parse(input))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");
    const gateway = createLovableAiGatewayProvider(key);

    // 松散 schema：让 AI SDK 转出的 JSON Schema 极宽松，避免模型偶尔返回
    // weight:"0.8" / hhmm:"7:00" 之类被 SDK 内部 zod 直接判失败。
    // 拿到松散对象后再用严格 ParsedSchema（含 WeightCoerced / HhmmCoerced /
    // .catch）把脏数据救回来。
    const LooseParsedSchema = z.object({
      city: z.string().optional(),
      cuisines: z.array(z.string()).optional(),
      dateTime: z.string().optional(),
      hardFilters: z.array(z.unknown()).optional(),
      softPreferences: z.array(z.unknown()).optional(),
      negativeFilters: z.array(z.unknown()).optional(),
      dishPreferences: z.array(z.string()).optional(),
      cuisineLevelConstraints: z.array(z.unknown()).optional(),
      searchStrategy: z.array(z.string()).optional(),
      country: z.string().optional(),
      language: z.string().optional(),
      mode: z.string().optional(),
      visitTime: z.unknown().optional(),
    });

    const prompt = `你是 Echo Eats 的需求结构化引擎。用户填写了餐厅搜索表单：

- 城市：${data.city}
- 料理类型：${data.cuisines.length ? data.cuisines.join("、") : data.autoInferCuisines ? "（用户跳过了料理选择并要求 AI 自动识别，请从「其它需求」推断 1-3 个料理候选；推断不出来再填 [\"餐厅\"]）" : "（用户跳过了料理选择并要求按所有品类搜索，cuisines 字段直接填 [\"餐厅\"]）"}
- 日期：${data.date || (data.uiLanguage === "en" ? "（用户未指定，dateTime 字段必须填英文字符串 \"Unspecified\"，不要填中文，也不要把日期/营业时间当 hardFilter）" : "（用户未指定，dateTime 字段填 \"未指定\"，不要把日期/营业时间当 hardFilter）")}
- 其它需求（自然语言）：${data.freeText || "（无）"}

请把需求结构化为 JSON。**所有自由文本字段（hardFilters/softPreferences/negativeFilters/dishPreferences/cuisineLevelConstraints/searchStrategy/cuisines/dateTime/visitTime.raw/visitTime.evidence 中所有人类可读内容）必须用 ${data.uiLanguage === "en" ? "English（英文）" : "简体中文"} 撰写**。注意：\`language\` 字段（BCP47 搜索目标语言，用于 Google Maps）按城市本地语言填写，不受此影响；\`visitTime.evidence\` 必须是用户原文片段，保持原文不翻译。如果用户没提到某类，返回空数组。

## 字段说明

- city：原样回传。cuisines：若用户已选则原样回传；若用户跳过（输入为空），从「其它需求」自由文本中推断 1-3 个最相关的料理类型（如 freeText 提到「想吃辣的」→ ["川菜","湘菜"]；提到「轻食」→ ["沙拉","三明治"]）；都推不出来填 ["餐厅"]。
- dateTime：直接用日期字符串，如 "2026/05/20"。
- hardFilters / softPreferences / negativeFilters：**对象数组**，每条形如 \`{"text": "原话片段 → 标准化条件", "weight": 0.0-1.0}\`。
- dishPreferences：用户希望吃到的具体菜品名（字符串数组，无 weight）。
- searchStrategy：3-5 条搜索策略说明。
- cuisineLevelConstraints：**品类级约束**（对象数组，形如 \`{"text":"原话 → 翻译","weight":0.1-1.0}\`），见下节。

## 品类级 vs 餐厅级约束（最高优先级，先判这一条）

有一类条件**本质上不是单家餐厅的可查属性，而是「整个品类」的特征**。这类条件直接当 hardFilter 塞给地图文本搜索会查不到（候选变空），必须用「先推品类、再搜索」的方式处理。

**品类级约束识别清单**（凡涉及以下语义之一，即视为品类级，按需自行扩展）：

- 用餐时长 / 总耗时：「1 小时内吃完」、「快一点」、「想慢慢吃」、「2 小时左右」
- 同行人结构：「带 3 岁小孩」、「带宝宝」、「家庭聚餐」、「一个人吃」、「10 人聚会」
- 食量/口味强度：「想轻一点」、「不想太饱」、「吃饱一点」、「想吃辣」、「想清淡」
- 氛围属性：「想热闹」、「想安静」、「适合约会」、「适合谈事」
- 用餐场景：「快速解决一顿」、「顺路解决」、「慢慢喝一杯」、「夜宵」

**处理规则（务必按顺序执行）**：

1. 这类条件**必须**进 \`cuisineLevelConstraints\`（带 weight，规则同下文权重表）。
2. **同时**把同一条复制进 \`softPreferences\`（保留排序信号，weight 相同）。
3. **绝对不要**进 \`hardFilters\`（会让 Google Maps 文本搜索查不到候选）。
4. 当**用户输入的 cuisines 为空时**，模型必须根据这些约束在 \`cuisines\` 字段里**主动产出 1–3 个匹配品类**，替代之前那种 \`["餐厅"]\` 的兜底。例：
   - 「东京、用餐 1 小时内、想轻一点」→ cuisines: ["拉面","乌冬","定食"]
   - 「大阪、带 3 岁小孩、想吃饱」→ cuisines: ["家庭餐厅","回转寿司","お好み焼き"]
   - 「京都、想慢慢吃、安静」→ cuisines: ["怀石","会席料理","日本料理"]
5. 当用户**已显式提供 cuisines** 时，**不要覆盖** cuisines；在 \`searchStrategy\` 里说明会按这些品类级约束做排序倾斜即可。

## hardFilters 判定规则（关键，务必严格执行）

只要用户原话出现以下任一信号，必须归入 hardFilters：

1. **强制词**：必须 / 一定 / 务必 / 只 / 仅 / 不能 / 不要 / 禁止 / 拒绝 / 不接受 / 得 / 需要
2. **数值上下限**："X 以内"、"不超过 X"、"至多 X"、"至少 X"、"X 以上"、"≤ / ≥ / < / >"。
3. **明确可验证属性**：可预约 / 接受信用卡 / 有包间 / 有吧台 / 无烟 / 营业到 X 点 / 步行 X 分钟内 等。
4. 用户用陈述句给出的具体可核实条件，例如"两个人"→ 人数=2。

## softPreferences 判定规则

仅当满足以下之一才归 soft，否则倾向 hard：

- 模糊形容词："氛围好"、"舒服"、"地道"、"环境不错"
- 弱化词："最好"、"希望"、"偏好"、"优先"、"如果可以"、"尽量"

## 权重判定（每条 hard / soft / neg 都必须打 weight，0.1-1.0，保留 1 位小数）

按用户原话语气强度打分：
- **1.0**：务必 / 绝对 / 一定 + 强调副词（"务必必须"、"绝对不要"、"一定要"）
- **0.9**：必须 / 一定 / 不能 / 不要 / 只 / 仅 / 拒绝 / 禁止
- **0.8**：要 / 需要 / 得 / 明确数值上下限（如"15000 以内"哪怕没强制词，也算 0.8，可验证硬约束）
- **0.6**：最好 / 希望 / 偏好 / 优先
- **0.4**：如果可以 / 尽量 / 有的话更好
- **0.3**：随便提一句、轻描淡写

类别先验（与语气取较高值）：
- **预算上限 / 人数 / 可预约 / 营业时间** 这类「可验证硬属性」基线 ≥ 0.8（即使语气随意也保持 0.8）。
- **氛围 / 装修 / 服务态度** 这类主观偏好基线 ≤ 0.7。
- 避雷条目：「不要 X」=0.7，「绝对不要 X」=1.0。

## 边界与去重

- 否定句一律进 negativeFilters，不要再复制到 hardFilters。
- 同一条只放一个数组里，不要重复。
- 具体菜品名同时进 dishPreferences；如果用户说"必须有蟹刺身"，则 dishPreferences + hardFilters 都放（hardFilter 项带 weight）。

## 示例

输入："两个人务必必须 15000 日元以内，不要游客店，适合聊天，最好有蟹刺身，可以预约。"
- hardFilters: [
    {"text":"两个人 → 人数 = 2","weight":0.9},
    {"text":"务必必须 15000 日元以内 → 人均预算 ≤ 15000 JPY","weight":1.0},
    {"text":"可以预约 → 支持预约","weight":0.8}
  ]
- softPreferences: [
    {"text":"适合聊天（安静、便于交谈）","weight":0.7},
    {"text":"最好有蟹刺身","weight":0.6}
  ]
- negativeFilters: [{"text":"不要游客店","weight":0.7}]
- dishPreferences: ["蟹刺身"]

## 国家/语言识别（重要）

- **country**：根据 city 推断 ISO 3166-1 alpha-2 国家码（两个大写字母）。覆盖所有城市，不只是大城市：
  - 函馆/小樽/旭川/轻井泽/由布院/别府/熊本/鹿儿岛/长崎/姬路/和歌山/石垣岛/那霸 → "JP"
  - 上海/北京/成都/苏州/杭州/重庆/西安等大陆城市 → "CN"
  - 香港 → "HK"，澳门 → "MO"，台北/高雄/台中 → "TW"
  - 首尔/釜山/济州 → "KR"
  - 清迈/曼谷/普吉 → "TH"
  - 新加坡 → "SG"
  - 巴黎/里昂 → "FR"，米兰/罗马/佛罗伦萨 → "IT"，纽约/旧金山 → "US"
  - 实在判断不出来留 ""。
- **language**：该城市本地主要书面语言的 BCP 47 代码：
  - JP → "ja"，KR → "ko"
  - CN → "zh-CN"，HK → "zh-HK"，TW → "zh-TW"，MO → "zh-HK"
  - TH → "th"，FR → "fr"，IT → "it"，DE → "de"，ES → "es"
  - US/UK/AU/CA/SG → "en"
  - 其它按国家主语言映射，判断不出留 ""。

## visitTime（就餐日期/时间，严格抽取，禁止脑补）

服务端今天的本地 weekday 是 **${new Date().getDay()}**（0=周日..6=周六），今天日期 ${new Date().toISOString().slice(0, 10)}。

**只有当用户原文「其它需求」里明确提到了具体的星期/日期/时段/钟点，才填 visitTime。模糊词如「随便」「找一家」「想去吃饭」一律视为未提到。**

字段规则：
- \`mentioned\`：用户是否真的提到了。没提到 → false，且其它字段全部填 null / 空串。
- \`evidence\`：必须是原文「其它需求」里**逐字出现**的连续片段（不得改写、不得翻译、不得拼接）。后端会做子串校验，对不上就整条作废。
- \`weekday\`：0=周日, 1=周一, ..., 6=周六。
  - "今天/today/今晚/tonight" → ${new Date().getDay()}
  - "明天/tomorrow/明晚" → ${(new Date().getDay() + 1) % 7}
  - "后天" → ${(new Date().getDay() + 2) % 7}
  - "周六/周日/周一" / "Saturday/Sunday/Monday..." → 直接对应
  - **有具体钟点（原文出现明确的钟表数字，如 "12:00"、"7 点"、"7pm"、"14:30"）但没有任何星期/日期词 → 默认填今天的 weekday = ${new Date().getDay()}**
  - 只有模糊时段词（"晚上"/"中午"/"tonight"/"evening" 等，没有具体钟点）且没有日期词 → null
- \`hhmm\`：24 小时制 "HH:MM"。
  - 具体钟点："7 点"→"19:00"（晚上语境）/"07:00"（早上语境）；"7pm"→"19:00"；"12:30"→"12:30"；"下午 2 点半"→"14:30"
  - 模糊时段锚点：早上/morning→"08:30"，中午/noon→"12:30"，下午/afternoon→"14:30"，傍晚/evening→"18:30"，晚上/night→"19:00"，深夜/late night→"22:00"
  - 没有时间信号 → null
- \`raw\`：原话直接抄过来，用于 UI 展示，例如 "周六晚上 7 点"。

### 示例
- 输入「两个人预算 15000，不要游客店」→ \`{"mentioned":false,"evidence":"","weekday":null,"hhmm":null,"raw":""}\`
- 输入「find a good ramen place」→ \`{"mentioned":false,...}\`
- 输入「周六晚上 7 点去」→ \`{"mentioned":true,"evidence":"周六晚上 7 点","weekday":6,"hhmm":"19:00","raw":"周六晚上 7 点"}\`
- 输入「this Saturday 7pm」→ \`{"mentioned":true,"evidence":"this Saturday 7pm","weekday":6,"hhmm":"19:00","raw":"this Saturday 7pm"}\`
- 输入「晚上去」→ \`{"mentioned":true,"evidence":"晚上","weekday":null,"hhmm":"19:00","raw":"晚上"}\`（只有模糊时段，不过滤）
- 输入「12:00 去吃」→ \`{"mentioned":true,"evidence":"12:00","weekday":${new Date().getDay()},"hhmm":"12:00","raw":"12:00"}\`（具体钟点无日期 → 默认今天）
- 输入「7pm sushi」→ \`{"mentioned":true,"evidence":"7pm","weekday":${new Date().getDay()},"hhmm":"19:00","raw":"7pm"}\`
- 输入「明天 12:30」→ \`{"mentioned":true,"evidence":"明天 12:30","weekday":${(new Date().getDay() + 1) % 7},"hhmm":"12:30","raw":"明天 12:30"}\``;

    const runOnce = async (modelId: string, opts?: { forceInfer?: boolean }) => {
      const model = gateway(modelId);
      const effectivePrompt = opts?.forceInfer
        ? prompt +
          `\n\n## 强制识别品类（重试指令）\n用户已**明确要求**自动识别料理品类。即使「其它需求」线索很弱，也必须从菜品、口味、人群、场景、时段、价位中任选维度，给出 1-3 个最相关的**具体**料理品类。**禁止**返回 ["餐厅"] / ["restaurants"] / ["レストラン"] / ["음식점"] 等通用兜底词。`
        : prompt;
      const { output } = await generateText({
        model,
        prompt: effectivePrompt,
        maxOutputTokens: 8000,
        output: Output.object({
          schema: LooseParsedSchema,
          name: "parsed_restaurant_requirements",
          description: "Echo Eats structured restaurant search requirements",
        }),
      });
      const parsed = ParsedSchema.parse(output);
      parsed.uiLanguage = data.uiLanguage;
      // 一致性兜底：weight >= 0.8 的 soft 一律提升为 hard
      const promoted = parsed.softPreferences.filter((s) => s.weight >= 0.8);
      if (promoted.length) {
        parsed.hardFilters = [...parsed.hardFilters, ...promoted];
        parsed.softPreferences = parsed.softPreferences.filter((s) => s.weight < 0.8);
      }
      // 用户未选 cuisines 且 AI 推断出了非兜底品类 → 标注为 AI 识别
      const userProvidedCuisines = data.cuisines.length > 0;
      const fallbackWord = data.uiLanguage === "en" ? "Restaurants" : "餐厅";
      parsed.cuisinesInferred =
        !userProvidedCuisines &&
        parsed.cuisines.length > 0 &&
        !(parsed.cuisines.length === 1 && parsed.cuisines[0] === fallbackWord);
      return parsed;
    };

    const FALLBACK_CUISINE_WORDS = new Set([
      "餐厅",
      "restaurants",
      "restaurant",
      "レストラン",
      "음식점",
      "食堂",
    ]);
    const isAllFallback = (arr: string[]) =>
      arr.length > 0 &&
      arr.every((c) => FALLBACK_CUISINE_WORDS.has(c.trim().toLowerCase()));

    const enforceInferIfRequested = async (
      parsed: z.infer<typeof ParsedSchema>,
    ): Promise<z.infer<typeof ParsedSchema>> => {
      const userProvidedCuisines = data.cuisines.length > 0;
      const wantsInfer = !userProvidedCuisines && data.autoInferCuisines !== false;
      if (!wantsInfer || !isAllFallback(parsed.cuisines)) return parsed;
      console.warn(
        "[parseRequirements] 用户要求 AI 识别但首轮返回兜底词，跨模型重试 forceInfer",
      );
      try {
        const retry = await runOnce("openai/gpt-5-mini", { forceInfer: true });
        if (!isAllFallback(retry.cuisines)) return retry;
        console.warn("[parseRequirements] forceInfer 重试仍为兜底，沿用首轮结果");
      } catch (e) {
        console.warn(
          "[parseRequirements] forceInfer 重试失败：",
          e instanceof Error ? e.message : e,
        );
      }
      return parsed;
    };

    const sanitizeVisitTime = (
      parsed: z.infer<typeof ParsedSchema>,
    ): z.infer<typeof ParsedSchema> => {
      const vt = parsed.visitTime;
      if (!vt || !vt.mentioned) {
        return { ...parsed, visitTime: null };
      }
      // evidence 必须真实出现在原文里（大小写/空格归一化），防 AI 幻觉
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
      const ev = norm(vt.evidence ?? "");
      const src = norm(data.freeText ?? "");
      if (!ev || !src.includes(ev)) {
        return { ...parsed, visitTime: null };
      }
      // 必须 weekday + hhmm 都齐才用于过滤
      if (vt.weekday == null || !vt.hhmm) {
        return { ...parsed, visitTime: null };
      }
      return parsed;
    };

    try {
      try {
        const first = await runOnce("google/gemini-2.5-flash");
        return sanitizeVisitTime(await enforceInferIfRequested(first));
      } catch (e1) {
        console.warn("[parseRequirements] 第一次解析失败：", e1 instanceof Error ? e1.message : e1);
        // 跨供应商重试，避免同模型以同样方式再次失败
        const second = await runOnce("openai/gpt-5-mini");
        return sanitizeVisitTime(await enforceInferIfRequested(second));
      }

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 兜底：返回最小可用结构，避免整页崩溃
      console.warn("[parseRequirements] AI 解析失败，使用兜底结构：", msg);
      return ParsedSchema.parse({
        city: data.city,
        cuisines: data.cuisines.length
          ? data.cuisines
          : [data.uiLanguage === "en" ? "Restaurants" : "餐厅"],
        dateTime: data.date || (data.uiLanguage === "en" ? "Unspecified" : "未指定"),
        country: "",
        language: "",
        visitTime: null,
        uiLanguage: data.uiLanguage,
      });
    }
  });

import {
  guessLanguageCode,
  guessRegionCode,
  resolvePhotoUrl,
  searchPlaces,
  type PlaceCandidate,
} from "./google-places.server";
import {
  isMainlandChinaCity,
  searchDianpingCuisine,
  type DianpingReview,
} from "./dianping.server";
import {
  expandCuisineQueries,
  filterByCuisineRelevance,
  type CuisineExpansion,
} from "./cuisine-expand.server";
import { fetchTabelogInfo, type TabelogInfo } from "./tabelog.server";
import { fetchYelpInfo, type YelpInfo } from "./yelp.server";

const YELP_COUNTRIES = new Set(["US", "CA", "FR", "IT", "DE", "ES", "GB"]);

// Perplexity 真实网评摘要
type ReviewSummary = {
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

const CURRENCY_ENUM = ["CNY", "JPY", "USD", "EUR", "HKD", "TWD", "KRW", "SGD", "GBP", "其它"] as const;

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: "¥",
  JPY: "¥",
  USD: "$",
  EUR: "€",
  HKD: "HK$",
  TWD: "NT$",
  KRW: "₩",
  SGD: "S$",
  GBP: "£",
};

const SOURCE_ENUM = ["大众点评", "Tabelog", "Google Reviews", "Yelp", "TripAdvisor", "其它"] as const;


// 把 Google Places 一手 reviews 转成 ReviewSummary（零幻觉，第一手数据）
function googleReviewsToSummary(p: PlaceCandidate): ReviewSummary | null {
  if (!p.reviews || p.reviews.length === 0) return null;
  const trim = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80);
  const highlights: string[] = [];
  const complaints: string[] = [];
  for (const r of p.reviews) {
    const t = trim(r.text);
    if (!t) continue;
    if (r.rating != null && r.rating <= 2) {
      if (complaints.length < 3) complaints.push(t);
    } else {
      if (highlights.length < 5) highlights.push(t);
    }
  }
  if (highlights.length === 0 && complaints.length === 0) return null;
  const sentiment: ReviewSummary["sentiment"] =
    complaints.length === 0
      ? "positive"
      : highlights.length === 0
        ? "negative"
        : complaints.length >= highlights.length
          ? "mixed"
          : "positive";
  return {
    reviewHighlights: highlights,
    commonComplaints: complaints,
    sentiment,
    sourceCount: p.reviews.length,
    sources: ["Google Reviews"],
    dianpingRating: null,
    dianpingRatingSource: "unknown",
    priceLevel: null,
    priceCurrency: null,
    priceContext: null,
  };
}

function mergeReviewSummaries(base: ReviewSummary, extra: ReviewSummary): ReviewSummary {
  const dedup = (arr: string[]) =>
    Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
  return {
    reviewHighlights: dedup([...base.reviewHighlights, ...extra.reviewHighlights]).slice(0, 8),
    commonComplaints: dedup([...base.commonComplaints, ...extra.commonComplaints]).slice(0, 5),
    sentiment: extra.sentiment !== "unknown" ? extra.sentiment : base.sentiment,
    sourceCount: base.sourceCount + extra.sourceCount,
    sources: Array.from(new Set([...base.sources, ...extra.sources])),
    dianpingRating: extra.dianpingRating ?? base.dianpingRating,
    dianpingRatingSource:
      extra.dianpingRating != null ? extra.dianpingRatingSource : base.dianpingRatingSource,
    priceLevel: extra.priceLevel ?? base.priceLevel,
    priceCurrency: extra.priceCurrency ?? base.priceCurrency,
    priceContext: extra.priceContext ?? base.priceContext,
  };
}


const RestaurantSchema = z.object({
  id: z.string(),
  name: z.string(),
  localName: z.string(),
  cuisine: z.string(),
  address: z.string(),
  googleMapsUri: z.string(),
  websiteUri: z.string().nullable(),
  primaryType: z.string().nullable(),
  matchScore: z.number().min(0).max(100),
  matchTier: z.enum(["perfect", "high", "partial"]),
  openNow: z.boolean(),
  reservable: z.boolean(),
  needsReview: z.boolean(),
  verificationStatus: z.enum(["ok", "unknown", "fail"]).optional().default("unknown"),
  ratings: z.array(z.object({ platform: z.string(), score: z.string().nullable() })),
  aiSummary: z.string(),
  matchDetails: z.array(z.object({ label: z.string(), status: z.enum(["ok", "warn"]) })),
  pros: z.array(z.object({ text: z.string(), source: z.string().nullable().optional() })),
  cons: z.array(z.object({ text: z.string(), source: z.string().nullable().optional() })),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  photoUrls: z.array(z.string()),
  tabelog: z
    .object({
      rating: z.string().nullable(),
      reviewCount: z.number().nullable(),
      url: z.string().nullable(),
      priceRange: z.string().nullable(),
      summary: z.string().nullable(),
    })
    .nullable(),
  yelp: z
    .object({
      rating: z.string().nullable(),
      reviewCount: z.number().nullable(),
      url: z.string().nullable(),
      priceLevel: z.string().nullable(),
      summary: z.string().nullable(),
      confidence: z.enum(["high", "medium", "low"]).optional().default("high"),
    })
    .nullable()
    .optional()
    .default(null),
  weekdayDescriptions: z.array(z.string()).nullable().optional().default(null),
  visitTimeMatch: z.enum(["open", "unknown"]).nullable().optional().default(null),
});

const ResultsSchema = z.object({
  groups: z.array(
    z.object({
      cuisine: z.string(),
      restaurants: z.array(RestaurantSchema),
      partialRestaurants: z.array(RestaurantSchema).optional(),
      failedRestaurants: z.array(RestaurantSchema).optional(),
    }),
  ),
});

// AI 排序输出：每组 picks 用 placeId 引用真实候选
const readableStringFrom = (value: unknown, fallback = "") => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
};

const MatchDetailSchema = z.preprocess(
  (v) => {
    if (typeof v === "string") return { label: v, status: "warn" };
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const label =
        readableStringFrom(obj.label) ||
        readableStringFrom(obj.text) ||
        readableStringFrom(obj.filter) ||
        readableStringFrom(obj.condition) ||
        readableStringFrom(obj.requirement) ||
        readableStringFrom(obj.note) ||
        readableStringFrom(obj.reason) ||
        readableStringFrom(obj.evidence) ||
        readableStringFrom(obj.summary) ||
        "Verification detail";
      return { ...obj, label, status: obj.status ?? "warn" };
    }
    return { label: "Verification detail", status: "warn" };
  },
  z.object({
    label: z.string().catch("Verification detail"),
    // 保持旧版容错：模型偶发返回纯字符串、text/note 字段或非白名单状态时，不丢弃整批核验结果。
    status: z.enum(["ok", "warn", "unknown"]).catch("warn"),
  }),
);

const HardFilterCheckSchema = z.preprocess(
  (v) => {
    if (typeof v === "string") return { filter: v, status: "unknown", note: v };
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const filter =
        readableStringFrom(obj.filter) ||
        readableStringFrom(obj.condition) ||
        readableStringFrom(obj.requirement) ||
        readableStringFrom(obj.text) ||
        "";
      const note =
        readableStringFrom(obj.note) ||
        readableStringFrom(obj.reason) ||
        readableStringFrom(obj.evidence) ||
        readableStringFrom(obj.summary) ||
        undefined;
      return { ...obj, filter, note, status: obj.status ?? "unknown" };
    }
    return { filter: "", status: "unknown" };
  },
  z.object({
    // 部分模型只返回 status/note；下游会按数组位置重新对应原始硬条件。
    filter: z.string().catch("").default(""),
    status: z.enum(["ok", "unknown", "fail"]).catch("unknown"),
    note: z.string().optional(),
  }),
);

const AiPickSchema = z.object({
  placeId: z.string(),
  matchScore: z.number().min(0).max(100),
  matchTier: z.enum(["perfect", "high", "partial"]).catch("partial"),
  aiSummary: z.string(),
  pros: z.array(z.preprocess(
    (v) => (typeof v === "string" ? { text: v, source: null } : v),
    z.object({ text: z.string(), source: z.string().nullable().optional() }),
  )).default([]),
  cons: z.array(z.preprocess(
    (v) => (typeof v === "string" ? { text: v, source: null } : v),
    z.object({ text: z.string(), source: z.string().nullable().optional() }),
  )).default([]),
  matchDetails: z.array(MatchDetailSchema).catch([]).default([]),
  hardFilterChecks: z.array(HardFilterCheckSchema).catch([]).default([]),
});

const AiRankingSchema = z.object({
  groups: z.array(
    z.object({
      cuisine: z.string(),
      picks: z.array(AiPickSchema),
    }),
  ),
});

// 单 cuisine 分组的 AI 输出 schema：用于按 cuisine 分批并行调用，避免一次性输出过长触发截断。
const AiPickGroupSchema = z.object({
  picks: z.array(AiPickSchema),
});

function tierFromScore(score: number): "perfect" | "high" | "partial" {
  if (score >= 92) return "perfect";
  if (score >= 80) return "high";
  return "partial";
}

function verifyGoogleRatingFilter(
  filterText: string,
  rating: number | null,
  isEn: boolean,
): { status: "ok" | "unknown" | "fail"; note: string } | null {
  const text = filterText.toLowerCase();
  // 用户常写“谷歌 4.5 以上”，解析器也可能标准化成“评分 ≥ 4.5”而丢掉“谷歌”。
  const mentionsGoogle = /(google(?:\s+maps)?|谷歌(?:地图)?|グーグル)/i.test(text);
  const mentionsRating = /(评分|評分|评级|評級|星级|星級|rating|rated|stars?|score|分|星|\/\s*5)/i.test(text);
  if (!mentionsGoogle && !mentionsRating) {
    return null;
  }
  const thresholdMatch = text.match(/([1-5](?:\.\d+)?)\s*(?:分|星|\/\s*5)?/);
  if (!thresholdMatch) return null;
  const threshold = Number(thresholdMatch[1]);
  if (!Number.isFinite(threshold) || threshold < 1 || threshold > 5) return null;
  if (rating == null) {
    return { status: "unknown", note: isEn ? "Google Maps rating is unavailable" : "Google Maps 评分数据缺失" };
  }

  let passes: boolean;
  if (/(?:不超过|至多|最高|以下|不高于|at most|no more than|up to|<=|≤)/i.test(text)) {
    passes = rating <= threshold;
  } else if (/(?:低于|少于|小于|below|under|less than|<)/i.test(text)) {
    passes = rating < threshold;
  } else if (/(?:超过|高于|大于|above|over|greater than|more than|>)/i.test(text)) {
    passes = rating > threshold;
  } else {
    passes = rating >= threshold;
  }
  const comparator = /(?:不超过|至多|最高|以下|不高于|at most|no more than|up to|<=|≤)/i.test(text)
    ? "≤"
    : /(?:低于|少于|小于|below|under|less than|<)/i.test(text)
      ? "<"
      : /(?:超过|高于|大于|above|over|greater than|more than|>)/i.test(text)
        ? ">"
        : "≥";
  return {
    status: passes ? "ok" : "fail",
    note: isEn
      ? `Google Maps rating is ${rating.toFixed(1)} / 5; requirement: ${comparator} ${threshold}`
      : `Google Maps 实际评分 ${rating.toFixed(1)} / 5；要求 ${comparator} ${threshold} 分`,
  };
}

function priceLevelLabel(level: string | null): string | null {
  switch (level) {
    case "PRICE_LEVEL_FREE":
      return "免费";
    case "PRICE_LEVEL_INEXPENSIVE":
      return "$";
    case "PRICE_LEVEL_MODERATE":
      return "$$";
    case "PRICE_LEVEL_EXPENSIVE":
      return "$$$";
    case "PRICE_LEVEL_VERY_EXPENSIVE":
      return "$$$$";
    default:
      return null;
  }
}

function buildLinks(p: PlaceCandidate, city: string, country: string, isEn = false, yelpUrl: string | null = null) {
  const links: { label: string; url: string }[] = [];
  const q = encodeURIComponent(`${p.name} ${city}`);
  const qName = encodeURIComponent(p.name);
  const qCity = encodeURIComponent(city);

  const isCN = country === "CN" || country === "HK" || country === "MO" || country === "TW";
  const isJP = country === "JP";

  if (isCN) {
    // 大众点评 H5 搜索深链（手机会拉起 App）
    links.push({
      label: isEn ? "Dianping" : "大众点评",
      url: `https://m.dianping.com/searchshop?keyword=${qName}&regionname=${qCity}`,
    });
    // 小红书搜索（用户口碑）
    links.push({
      label: isEn ? "Xiaohongshu" : "小红书",
      url: `https://www.xiaohongshu.com/search_result?keyword=${q}&type=51`,
    });
  }

  if (isJP) {
    links.push({
      label: "Tabelog",
      url: `https://www.google.com/search?q=${encodeURIComponent(`site:tabelog.com ${p.name}`)}`,
    });
  }

  links.push({ label: "Google Maps", url: p.googleMapsUri });
  if (p.websiteUri) {
    const isDianpingShop = /dianping\.com\/shop\//i.test(p.websiteUri);
    links.push({
      label: isDianpingShop
        ? isEn ? "Dianping page" : "大众点评店铺页"
        : isEn ? "Website" : "官网",
      url: p.websiteUri,
    });
  }

  if (!isCN) {
    // 海外（含日本）：加 Yelp + TripAdvisor 链接，方便用户核验口碑来源
    // 若已有 Yelp 详情页 URL（来自 fetchYelpInfo），直接深链；否则回退到搜索
    links.push({
      label: "Yelp",
      url: yelpUrl ?? `https://www.yelp.com/search?find_desc=${qName}&find_loc=${qCity}`,
    });
    links.push({
      label: "TripAdvisor",
      url: `https://www.tripadvisor.com/Search?q=${q}`,
    });
  }

  links.push({ label: isEn ? "Google Search" : "Google 搜索", url: `https://www.google.com/search?q=${q}` });
  return links.slice(0, 6);
}

function formatPriceFromReview(review: ReviewSummary | null, isEn = false): string | null {
  if (!review || review.priceLevel == null) return null;
  const sym = review.priceCurrency ? CURRENCY_SYMBOL[review.priceCurrency] ?? "" : "";
  const amount = `${sym}${review.priceLevel}`;
  if (isEn) {
    const ctx = review.priceContext ? ` (${review.priceContext}, from reviews)` : " (from reviews)";
    return `${amount}${ctx}`;
  }
  const ctx = review.priceContext ? `（${review.priceContext}，来自网评）` : "（来自网评）";
  return `${amount}${ctx}`;
}

function candidateRatings(
  p: PlaceCandidate,
  review: ReviewSummary | null,
  tabelog: TabelogInfo | null,
  isEn = false,
  country = "",
  yelp: YelpInfo | null = null,
) {
  const isCN = country === "CN" || country === "HK" || country === "MO" || country === "TW";
  const isJP = country === "JP";
  const score =
    p.rating != null
      ? `${p.rating.toFixed(1)} / 5${p.userRatingCount ? ` (${p.userRatingCount})` : ""}`
      : null;
  const dpScore =
    review?.dianpingRating != null
      ? `${review.dianpingRating.toFixed(1)} / 5${isEn ? " (reviews)" : "（网评）"}`
      : null;
  const reviewPrice = formatPriceFromReview(review, isEn);
  const googleFallback = priceLevelLabel(p.priceLevel);
  const priceScore =
    reviewPrice ??
    (googleFallback ? `${googleFallback}${isEn ? " (Google)" : "（Google）"}` : null);
  const tabelogScore =
    tabelog?.rating != null
      ? `${tabelog.rating} / 5${tabelog.reviewCount ? ` (${tabelog.reviewCount})` : ""}`
      : null;
  const yelpScore =
    yelp?.rating != null
      ? `${yelp.rating} / 5${yelp.reviewCount ? ` (${yelp.reviewCount})` : ""}`
      : null;
  const rows: { platform: string; score: string | null }[] = [
    { platform: "Google Maps", score },
  ];
  if (isJP) rows.push({ platform: "Tabelog", score: tabelogScore });
  if (isCN) rows.push({ platform: isEn ? "Dianping" : "大众点评", score: dpScore });
  // Yelp 行：仅当有数据时插入（无数据不展示，符合用户期望）
  if (yelpScore) rows.push({ platform: "Yelp", score: yelpScore });
  rows.push({ platform: isEn ? "Avg. price" : "人均价格", score: priceScore });
  return rows;
}

const WarningSchema = z.object({
  stage: z.string(),
  cuisine: z.string().optional(),
  message: z.string(),
  retryable: z.boolean().optional(),
});

const SearchResponseSchema = z.object({
  groups: ResultsSchema.shape.groups,
  error: z.string().nullable(),
  suggestions: z.array(z.string()),
  warnings: z.array(WarningSchema).optional(),
});

export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// 流式搜索：handler 是 async generator，分阶段 yield 状态块，
// 最终结果包在 { type: "result", payload } 里。
// 客户端用 for-await 消费，持续 yield 让 Cloudflare 边缘不会判超时。
export type SearchStreamChunk =
  | { type: "stage"; stage: string; message?: string; count?: number; total?: number }
  | { type: "review-progress"; done: number; total: number }
  | { type: "tabelog-progress"; done: number; total: number }
  | { type: "yelp-progress"; done: number; total: number }
  | { type: "heartbeat"; stage: string }
  | { type: "result"; payload: SearchResponse };

// 把 Promise 数组按完成顺序流出。
async function* asCompleted<T>(promises: Promise<T>[]): AsyncGenerator<T, void, unknown> {
  const pending = new Map<number, Promise<{ i: number; v: T }>>();
  promises.forEach((p, i) => pending.set(i, p.then((v) => ({ i, v }))));
  while (pending.size > 0) {
    const { i, v } = await Promise.race(pending.values());
    pending.delete(i);
    yield v;
  }
}

// 在等待 promise 期间，每 intervalMs 毫秒 yield 一个心跳块，
// 防止长 phase（Tabelog 抓取、AI 排序）静默期超过边缘网关的响应墙。
async function* withHeartbeat<T>(
  p: Promise<T>,
  stage: string,
  intervalMs = 4000,
): AsyncGenerator<SearchStreamChunk, T, unknown> {
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  let isError = false;
  const tracked = p.then(
    (v) => {
      value = v;
      settled = true;
    },
    (e) => {
      error = e;
      isError = true;
      settled = true;
    },
  );
  while (!settled) {
    await Promise.race([
      tracked,
      new Promise<void>((r) => setTimeout(r, intervalMs)),
    ]);
    if (!settled) yield { type: "heartbeat", stage };
  }
  if (isError) throw error;
  return value as T;
}

// 客户端辅助：消费流并返回最终 SearchResponse，沿途回调进度。
export async function consumeSearchStream(
  iter: AsyncIterable<SearchStreamChunk>,
  onProgress?: (chunk: SearchStreamChunk) => void,
): Promise<SearchResponse> {
  let final: SearchResponse | null = null;
  for await (const chunk of iter) {
    if (chunk.type === "result") final = chunk.payload;
    onProgress?.(chunk);
  }
  if (!final) throw new Error("搜索流未返回结果");
  return final;
}

const FALLBACK_SUGGESTIONS_ZH = [
  "尝试更具体的料理类型（如把「日料」换成「寿司」或「居酒屋」）",
  "扩大或更换城市（用城市核心区域名）",
  "在「其它需求」里加上具体菜品或预算，让 AI 更聚焦",
  "减少同时搜索的料理类型数量",
];
const FALLBACK_SUGGESTIONS_EN = [
  "Try a more specific cuisine (e.g. swap \"Japanese\" for \"Sushi\" or \"Izakaya\")",
  "Widen the city or use a central district name",
  "Add a specific dish or budget in \"Other requirements\" to focus the AI",
  "Reduce the number of cuisines searched at once",
];
const fallbackSuggestions = (lang: "zh" | "en") =>
  lang === "en" ? FALLBACK_SUGGESTIONS_EN : FALLBACK_SUGGESTIONS_ZH;

// 判断某个店在指定周几+时间是否营业。
// periods 缺失 → unknown（保留）；命中区间 → open；都不命中 → closed。
// 处理跨日营业（close.day != open.day 或 close 时间小于 open 时间）。
function isOpenAt(
  periods: PlaceCandidate["openingPeriods"],
  weekday: number,
  hhmm: string,
): "open" | "closed" | "unknown" {
  if (!periods || periods.length === 0) return "unknown";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "unknown";
  const target = weekday * 1440 + h * 60 + m;
  const WEEK = 7 * 1440;
  for (const pd of periods) {
    const openMin = pd.open.day * 1440 + pd.open.hour * 60 + pd.open.minute;
    // close 缺失视作 24/7 营业
    if (!pd.close) return "open";
    let closeMin = pd.close.day * 1440 + pd.close.hour * 60 + pd.close.minute;
    // 跨周/跨日营业（如 周五 22:00 -> 周六 02:00）
    if (closeMin <= openMin) closeMin += WEEK;
    // 两种偏移分别比较（处理 target 落在跨日尾部的情况）
    const candidates = [target, target + WEEK];
    if (candidates.some((t) => t >= openMin && t < closeMin)) return "open";
  }
  return "closed";
}

export const searchRestaurants = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ParsedSchema.parse(input))
  .handler(async function* ({ data }): AsyncGenerator<SearchStreamChunk, void, unknown> {
    const uiLang: "zh" | "en" = data.uiLanguage ?? "zh";
    const isEn = uiLang === "en";
    const warnings: Array<{ stage: string; cuisine?: string; message: string; retryable?: boolean }> = [];
    const pushWarn = (w: { stage: string; cuisine?: string; message: string; retryable?: boolean }) => {
      if (warnings.length < 10) warnings.push(w);
    };
    try {
    const aiKey = process.env.LOVABLE_API_KEY;
    if (!aiKey) {
      yield {
        type: "result",
        payload: {
          groups: [],
          error: isEn ? "AI credentials are not configured" : "服务未配置 AI 凭据",
          suggestions: [],
        },
      };
      return;
    }
    // country/language 优先取 AI parse 结果，正则只做 fallback
    const country =
      (data.country && data.country.toUpperCase()) ||
      guessRegionCode(data.city) ||
      (isMainlandChinaCity(data.city) ? "CN" : "");
    const useDianping = country === "CN";

    // cuisines 兜底：用户跳过且 AI 也没推断出来时，按通用「餐厅」搜索
    const cuisinesAutoFilled = data.cuisines.length === 0;
    if (cuisinesAutoFilled) {
      const lang = (data.language || guessLanguageCode(data.city)).toLowerCase();
      const fallback =
        lang === "ja"
          ? "レストラン"
          : lang === "ko"
            ? "음식점"
            : lang.startsWith("zh")
              ? "餐厅"
              : "restaurants";
      data = { ...data, cuisines: [fallback] };
    }
    const pplxKey = process.env.PERPLEXITY_API_KEY;

    if (!useDianping && !process.env.GOOGLE_PLACES_API_KEY) {
      yield {
        type: "result",
        payload: {
          groups: [],
          error: isEn
            ? "Google Places API key (GOOGLE_PLACES_API_KEY) is not configured"
            : "服务未配置 Google Places API Key（GOOGLE_PLACES_API_KEY）",
          suggestions: [],
        },
      };
      return;
    }
    if (useDianping && !pplxKey) {
      yield {
        type: "result",
        payload: {
          groups: [],
          error: isEn
            ? "Mainland China cities require a Perplexity API key to fetch Dianping data, but none is configured"
            : "国内城市需要 Perplexity API Key 抓取大众点评数据，但未配置",
          suggestions: [],
        },
      };
      return;
    }

    yield {
      type: "stage",
      stage: "places",
      message: isEn ? `Searching candidates in ${data.city}…` : `搜索 ${data.city} 候选餐厅…`,
    };

    const reviewById = new Map<string, ReviewSummary>();
    const cuisineExpansions = new Map<string, CuisineExpansion>();
    let placeResults: Array<{
      cuisine: string;
      places: PlaceCandidate[];
      error: string | null;
    }>;

    if (useDianping) {
      // 国内城市：大众点评一手数据流（候选 + 网评一次拿到）
      const firecrawlKey = process.env.FIRECRAWL_API_KEY ?? null;
      const settled = await Promise.all(
        data.cuisines.map(async (cuisine) => {
          try {
            const expansion = await expandCuisineQueries({
              cuisine,
              city: data.city,
              language: "zh-CN",
              apiKey: aiKey,
            });
            cuisineExpansions.set(cuisine, expansion);
            const items = await searchDianpingCuisine({
              city: data.city,
              cuisine,
              cuisineSynonyms: expansion.synonyms,
              hardFilters: data.hardFilters.map((c) => c.text),
              perplexityKey: pplxKey!,
              firecrawlKey,
            });
            const places: PlaceCandidate[] = [];
            for (const it of items) {
              places.push(it.candidate);
              if (it.review) {
                reviewById.set(it.candidate.placeId, it.review as ReviewSummary);
              }
            }
            return {
              cuisine,
              places,
              error: places.length ? null : isEn ? "Dianping returned no candidates" : "大众点评未返回候选",
            };
          } catch (e) {
            return {
              cuisine,
              places: [] as PlaceCandidate[],
              error: e instanceof Error ? e.message : String(e),
            };
          }
        }),
      );
      placeResults = settled;
    } else {
      // 海外城市：Google Places + Google 一手 reviews（基线）
      const language = data.language || guessLanguageCode(data.city);
      const region = country || guessRegionCode(data.city);

      const semanticSuffix = (() => {
        if (language === "ja") return "おすすめ";
        if (language === "zh-CN" || language === "zh-TW") return "推荐";
        return "best";
      })();
      placeResults = await Promise.all(
        data.cuisines.map(async (cuisine) => {
          const expansion = await expandCuisineQueries({
            cuisine,
            city: data.city,
            language,
            apiKey: aiKey,
          });
          cuisineExpansions.set(cuisine, expansion);
          const synQueries = expansion.synonyms
            .slice(0, 2)
            .map((s) => `${s} ${data.city}`);
          const queries = data.mode === "quick"
            ? [`${expansion.primary} ${data.city}`]
            : Array.from(
                new Set([
                  `${expansion.primary} ${data.city}`,
                  ...synQueries,
                  `${expansion.primary} ${data.city} ${semanticSuffix}`,
                ]),
              );
          const settled = await Promise.allSettled(
            queries.map((query) =>
              searchPlaces({ query, language, region, maxResults: 20 }),
            ),
          );
          const merged = new Map<string, PlaceCandidate>();
          let firstError: string | null = null;
          for (const s of settled) {
            if (s.status === "fulfilled") {
              for (const p of s.value) if (!merged.has(p.placeId)) merged.set(p.placeId, p);
            } else if (!firstError) {
              firstError = s.reason instanceof Error ? s.reason.message : String(s.reason);
            }
          }
          const allPlaces = Array.from(merged.values());
          const places = filterByCuisineRelevance(allPlaces, expansion);
          return { cuisine, places, error: places.length ? null : firstError };
        }),
      );
    }

    const totalCandidates = placeResults.reduce((s, r) => s + r.places.length, 0);
    yield { type: "stage", stage: "places-done", count: totalCandidates };
    for (const r of placeResults) {
      if (!r.places.length && r.error) {
        pushWarn({
          stage: useDianping ? "dianping" : "places",
          cuisine: r.cuisine,
          message: isEn
            ? `No candidates returned for "${r.cuisine}". Other cuisines are still shown.`
            : `「${r.cuisine}」本次没有返回候选，其它品类照常展示。`,
          retryable: true,
        });
      }
    }

    const placesError = placeResults.find((r) => r.error)?.error;
    if (placesError && placeResults.every((r) => !r.places.length)) {
      yield {
        type: "result",
        payload: {
          groups: [],
          error: useDianping
            ? isEn
              ? `Dianping lookup failed: ${placesError}`
              : `大众点评检索失败：${placesError}`
            : isEn
              ? `Google Places call failed: ${placesError}`
              : `Google Places 调用失败：${placesError}`,
          suggestions: fallbackSuggestions(uiLang),
        },
      };
      return;
    }

    const allHaveZero = placeResults.every((r) => r.places.length === 0);
    if (allHaveZero) {
      yield {
        type: "result",
        payload: {
          groups: [],
          error: useDianping
            ? isEn
              ? `Dianping found no matching candidates in "${data.city}"`
              : `大众点评在「${data.city}」没找到符合的餐厅候选`
            : isEn
              ? `Google Places found no matching candidates in "${data.city}"`
              : `Google Places 在「${data.city}」没有找到任何符合的餐厅候选`,
          suggestions: fallbackSuggestions(uiLang),
        },
      };
      return;
    }

    // 日期/时间硬筛：明确 closed 的候选属于不可用基础淘汰项，不参与后续补足。
    const visitMatchById = new Map<string, "open" | "unknown">();
    if (data.visitTime && data.visitTime.weekday != null && data.visitTime.hhmm) {
      const w = data.visitTime.weekday;
      const t = data.visitTime.hhmm;
      let totalRemoved = 0;
      placeResults = placeResults.map((r) => {
        if (!r.places.length) return r;
        const kept: PlaceCandidate[] = [];
        for (const p of r.places) {
          const m = isOpenAt(p.openingPeriods, w, t);
          if (m === "closed") {
            totalRemoved++;
          } else {
            kept.push(p);
            visitMatchById.set(p.placeId, m);
          }
        }
        return { ...r, places: kept };
      });
      console.log(`[visitTime] weekday=${w} hhmm=${t} removed=${totalRemoved}`);
    }

    // 海外城市：把 Google Places 一手 reviews 作为基线证据塞入（零幻觉）。
    if (!useDianping) {
      for (const r of placeResults) {
        for (const p of r.places) {
          const baseline = googleReviewsToSummary(p);
          if (baseline) reviewById.set(p.placeId, baseline);
        }
      }
    }


    // JP 分支补充：用 Perplexity 代抓 Tabelog 评分+摘要+价位，作为 Google 之外的独立信号。
    // 覆盖所有候选（已经过料理保真过滤），并发上限 8 防止 Perplexity 限流。
    const tabelogById = new Map<string, TabelogInfo>();
    if (!useDianping && pplxKey && country === "JP" && data.mode !== "quick") {
      const allTargets: PlaceCandidate[] = [];
      for (const r of placeResults) {
        for (const p of r.places) allTargets.push(p);
      }
      yield { type: "stage", stage: "tabelog", total: allTargets.length };
      const CONCURRENCY = 8;
      let cursor = 0;
      const runWorker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= allTargets.length) return;
          const p = allTargets[i];
          try {
            const info = await fetchTabelogInfo(p.name, p.address, data.city);
            if (info) tabelogById.set(p.placeId, info);
          } catch (e) {
            console.warn(`[Tabelog] ${p.name} task error:`, e instanceof Error ? e.message : e);
          }
        }
      };
      // 心跳包裹：抓取期间每 4s yield 一次，避免边缘网关因为长时间静默切断响应。
      yield* withHeartbeat(
        Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, allTargets.length) }, runWorker),
        ),
        "tabelog",
      );
      console.log(`[Tabelog] hit ${tabelogById.size}/${allTargets.length}`);
      if (allTargets.length > 0 && tabelogById.size === 0) {
        pushWarn({
          stage: "tabelog",
          message: isEn
            ? "Tabelog data is unavailable for this search. Other sources are still shown."
            : "本次未能取到 Tabelog 数据，其它来源照常展示。",
          retryable: true,
        });
      }
    }

    // US/CA/西欧 分支补充：用 Perplexity 代抓 Yelp 评分+评论数+价位+摘要，与 Tabelog 同构。
    // 仅展示用、不参与硬过滤；无数据则前端不展示名片行。
    const yelpById = new Map<string, YelpInfo>();
    if (!useDianping && pplxKey && YELP_COUNTRIES.has(country) && data.mode !== "quick") {
      const allTargets: PlaceCandidate[] = [];
      for (const r of placeResults) {
        for (const p of r.places) allTargets.push(p);
      }
      yield { type: "stage", stage: "yelp", total: allTargets.length };
      const CONCURRENCY = 8;
      let cursor = 0;
      const runWorker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= allTargets.length) return;
          const p = allTargets[i];
          try {
            const info = await fetchYelpInfo(p.name, p.address, data.city, isEn);
            if (info) yelpById.set(p.placeId, info);
          } catch (e) {
            console.warn(`[Yelp] ${p.name} task error:`, e instanceof Error ? e.message : e);
          }
        }
      };
      yield* withHeartbeat(
        Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, allTargets.length) }, runWorker),
        ),
        "yelp",
      );
      console.log(`[Yelp] hit ${yelpById.size}/${allTargets.length}`);
      if (allTargets.length > 0 && yelpById.size === 0) {
        pushWarn({
          stage: "yelp",
          message: isEn
            ? "Yelp data is unavailable for this search. Other sources are still shown."
            : "本次未能取到 Yelp 数据，其它来源照常展示。",
          retryable: true,
        });
      }
    }

    // 全量候选按每批 8 家核验，避免固定前 25 截断，同时控制单次模型输入输出体积。
    const AI_BATCH_SIZE = 8;
    const candidateGroups = placeResults
      .filter((r) => r.places.length)
      .map((r) => {
        const ranked = [...r.places].sort((a, b) => {
          const sa = (a.rating ?? 0) * Math.log10((a.userRatingCount ?? 0) + 10);
          const sb = (b.rating ?? 0) * Math.log10((b.userRatingCount ?? 0) + 10);
          return sb - sa;
        });
        return {
          cuisine: r.cuisine,
          candidates: ranked.map((p) => {
            const review = reviewById.get(p.placeId) ?? null;
            const tabelog = tabelogById.get(p.placeId) ?? null;
            const yelp = yelpById.get(p.placeId) ?? null;
            return {
              placeId: p.placeId,
              name: p.name,
              address: p.address,
              rating: p.rating,
              googleRating: p.rating,
              userRatingCount: p.userRatingCount,
              priceLevel: priceLevelLabel(p.priceLevel),
              priceFromReviews:
                review?.priceLevel != null
                  ? {
                      amount: review.priceLevel,
                      currency: review.priceCurrency,
                      context: review.priceContext,
                    }
                  : null,
              openNow: p.openNow,
              primaryType: p.primaryType,
              editorialSummary: p.editorialSummary,
              realWorldReviews: review,
              tabelog: tabelog
                ? {
                    rating: tabelog.rating,
                    reviewCount: tabelog.reviewCount,
                    priceRange: tabelog.priceRange,
                    priceJPY: tabelog.priceJPY,
                    summary: tabelog.summary,
                  }
                : null,
              yelp: yelp
                ? {
                    rating: yelp.rating,
                    reviewCount: yelp.reviewCount,
                    priceLevel: yelp.priceLevel,
                    summary: yelp.summary,
                  }
                : null,
            };
          }),
        };
      });
    const candidatesForPrompt = candidateGroups.flatMap((group) => {
      const batches: typeof candidateGroups = [];
      for (let i = 0; i < group.candidates.length; i += AI_BATCH_SIZE) {
        batches.push({ cuisine: group.cuisine, candidates: group.candidates.slice(i, i + AI_BATCH_SIZE) });
      }
      return batches;
    });
    const totalCandidatesForPrompt = candidatesForPrompt.reduce(
      (n, g) => n + g.candidates.length,
      0,
    );
    console.log(
      `[Echo/AI-rank] sending ${totalCandidatesForPrompt} candidates across ${candidatesForPrompt.length} cuisine(s) to model`,
    );

    const gateway = createLovableAiGatewayProvider(aiKey);
    // gemini-3-flash-preview 在当前 AI Gateway 下不支持 responseFormat JSON Schema
    // （会触发 "Output.object failed: No output generated."），换回稳定的 2.5-flash。
    const model = gateway("google/gemini-2.5-flash");


    const hardFiltersList = data.hardFilters.map((h) => h.text);
    const hardFiltersJson = JSON.stringify(
      data.hardFilters.map((h) => ({ text: h.text, weight: h.weight })),
    );
    const softJson = JSON.stringify(
      data.softPreferences.map((s) => ({ text: s.text, weight: s.weight })),
    );
    const negJson = JSON.stringify(
      data.negativeFilters.map((n) => ({ text: n.text, weight: n.weight })),
    );

    const langDirective = isEn
      ? `\n## OUTPUT LANGUAGE (MANDATORY, ZERO TOLERANCE)\nALL human-readable string fields you produce — aiSummary, pros, cons, matchDetails[].label, hardFilterChecks[].note — MUST be written in **English only**. **No CJK characters are allowed in any of those fields**, not even as quoted source snippets. If the source review is in Chinese, paraphrase it into concise English and DROP the original Chinese — do NOT include the Chinese phrase in quotes followed by a translation.\n\nBad (forbidden):\n  - "Reviews mention '氛围复古有特色' (retro and unique atmosphere)"\n  - "高峰期可能要等位 (may have to wait during peak hours)"\nGood:\n  - "Diners praise the retro, characterful atmosphere"\n  - "May involve a wait during peak hours"\n\nRule of thumb: if any character matches /[\\u4e00-\\u9fff]/ in those fields, the output is invalid — rewrite it in pure English. Keep \`placeId\` and any enum/status values exactly as specified.\n`
      : `\n## 输出语言（强制）\n你产出的所有人类可读字符串字段（aiSummary、pros、cons、matchDetails[].label、hardFilterChecks[].note）必须用**简体中文**撰写。\n`;

    type GroupForPrompt = (typeof candidatesForPrompt)[number];

    // 单 cuisine 的 prompt：只塞当前 cuisine 的候选 + 该 cuisine 的扩展词，输出体量约为
    // 原来的 1/N（N = cuisine 数），从根本上避免触发 maxOutputTokens 截断。
    const buildPromptForGroup = (group: GroupForPrompt) => {
  const exp = cuisineExpansions.get(group.cuisine);
  const syn = exp && exp.synonyms.length ? exp.synonyms.join("、") : "（无）";
  const neg =
    exp && exp.negativeKeywords.length ? exp.negativeKeywords.join("、") : "（无）";
  const fidelity = exp
    ? `- 「${group.cuisine}」：本地化主词 = "${exp.primary}"；同义词 = ${syn}；反例（明显不是该料理）= ${neg}`
    : `- 「${group.cuisine}」：（无额外扩展）`;

  return `你是 Echo Eats 的餐厅匹配分析师。下面是 Google Places 返回的真实候选餐厅（针对料理：「${group.cuisine}」）。请对提供的所有候选餐厅进行深度核验与分类。

用户需求：
- 城市：${data.city}
- 日期/时间：${data.dateTime}
- 硬条件（带 weight 0-1）：${hardFiltersJson}
- 偏好（带 weight）：${softJson === "[]" ? "无" : softJson}
- 避雷（带 weight）：${negJson === "[]" ? "无" : negJson}
- 菜品偏好：${data.dishPreferences.join("、") || "无"}

## 验证与分类任务
请核验列表中的**每一个**餐厅，并将其归入以下三个桶（Buckets）之一：
1. **ok**：满足所有 weight >= 0.85 的硬条件，且没有明显的负面网评冲突。
2. **unknown**：没有任何 weight >= 0.85 的条件明确判定为 "fail"，但至少有一个重要条件因为信息不足被标记为 "unknown"。
3. **fail**：至少有一个 weight >= 0.85 的硬条件被明确判定为 "fail"（不满足）。

## 料理保真（最高优先级）
${fidelity}
判定方法：检查候选的 name / primaryType / editorialSummary / realWorldReviews。
- 命中反例关键词且未命中主词/同义词 → **判定为 fail**。

候选数据（JSON）：
${JSON.stringify(group.candidates, null, 2)}

## 铁律
- **核验所有候选**：必须对提供的列表中的每一家店给出核验结果。
- **hardFilterChecks 长度一致**：对每个餐厅，hardFilterChecks 数组长度必须严格等于 ${hardFiltersList.length}。
- **状态判定依据**：
  - "ok": 明确证据支持。
  - "fail": 明确证据证实不满足。
  - "unknown": 无法确认。
- **Google 评分是确定性事实**：候选中的 googleRating/rating 来自 Google Places。遇到 Google/谷歌评分阈值条件时必须直接做数值比较；有数值时禁止标为 unknown，也不要用评论文本推断评分。
- **禁止幻觉**：如果 realWorldReviews 为空，严禁编造评价。

输出 JSON 格式：{ "picks": [{ "placeId": "...", "verificationStatus": "ok", "matchScore": 88, ... }] }
（注：此处 picks 数组应包含所有核验过的餐厅，不仅仅是推荐的）`;
};


    // 每个 cuisine 独立调用 AI（主调用 + raw 文本兜底）。失败时返回空 picks，不抛出，
    // 这样单个 cuisine 失败不会拖垮整次搜索。
    const rankOneGroup = async (
      group: GroupForPrompt,
    ): Promise<{ cuisine: string; picks: z.infer<typeof AiPickSchema>[] }> => {
      const prompt = buildPromptForGroup(group);
      const startedAt = Date.now();

      const RAW_FORMAT_HARD_RULES = `\n\n**输出格式硬约束**：
- 第一个字符必须是 "{"，最后一个字符必须是 "}"。
- 不要任何前置说明、不要 markdown、不要 \`\`\`json 包裹、不要"以下是"之类的开场。
- picks 数组必须逐一覆盖本批所有候选（本批最多 8 条）；每条 aiSummary ≤ 80 字、pros/cons 各 ≤ 3 条、matchDetails ≤ 5 条。`;

      const extractJson = (text: string): string => {
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) return fenced[1].trim();
        const m = text.match(/\{[\s\S]*\}/);
        return m ? m[0] : text;
      };

      // 极简兜底：砍掉占 token 大头的 realWorldReviews + 截短 tabelog/yelp summary。
      const buildSlimPrompt = (): string => {
        const slim: GroupForPrompt = {
          cuisine: group.cuisine,
          candidates: group.candidates.map((c) => ({
            ...c,
            realWorldReviews: null,
            editorialSummary: typeof c.editorialSummary === "string"
              ? c.editorialSummary.slice(0, 60)
              : c.editorialSummary,
            tabelog: c.tabelog
              ? { ...c.tabelog, summary: c.tabelog.summary ? c.tabelog.summary.slice(0, 30) : null }
              : c.tabelog,
            yelp: c.yelp
              ? { ...c.yelp, summary: c.yelp.summary ? c.yelp.summary.slice(0, 30) : null }
              : c.yelp,
          })),
        } as GroupForPrompt;
        return buildPromptForGroup(slim) + RAW_FORMAT_HARD_RULES;
      };

      try {
        const result = await generateText({
          model,
          prompt,
          maxOutputTokens: 12000,
          output: Output.object({
            schema: AiPickGroupSchema,
            name: "echo_eats_picks",
            description: `AI ranking of real candidates for cuisine "${group.cuisine}"`,
          }),
        });
        console.log(
          `[Echo/AI-rank] "${group.cuisine}" Output.object ok in ${Date.now() - startedAt}ms, picks=${result.output.picks.length}`,
        );
        return { cuisine: group.cuisine, picks: result.output.picks };
      } catch (e1) {
        const m1 = e1 instanceof Error ? e1.message : String(e1);
        console.warn(
          `[Echo/AI-rank] "${group.cuisine}" Output.object failed (${m1}), retrying raw…`,
        );
        try {
          const fb = await generateText({
            model,
            prompt:
              prompt +
              `\n\n再次强调：你的回复必须是**纯 JSON**，不要 markdown 代码块、不要前后说明文字、不要 \`\`\`json 包裹。直接以 { 开头、以 } 结尾。` +
              RAW_FORMAT_HARD_RULES,
            maxOutputTokens: 20000,
          });
          const finishReason = (fb as { finishReason?: string }).finishReason;
          if (finishReason === "length" || finishReason === "max-tokens") {
            throw new Error(`truncated (finishReason=${finishReason})`);
          }
          const parsed = AiPickGroupSchema.parse(JSON.parse(extractJson(fb.text || "")));
          console.log(
            `[Echo/AI-rank] "${group.cuisine}" fallback ok in ${Date.now() - startedAt}ms, picks=${parsed.picks.length}`,
          );
          return { cuisine: group.cuisine, picks: parsed.picks };
        } catch (e2) {
          const m2 = e2 instanceof Error ? e2.message : String(e2);
          console.warn(
            `[Echo/AI-rank] "${group.cuisine}" raw fallback failed (${m2}), retrying slim…`,
          );
          // 最后兜底：剥光大字段再跑一次，给足 token，避免空 picks 害死整组。
          try {
            const slimFb = await generateText({
              model,
              prompt: buildSlimPrompt(),
              maxOutputTokens: 20000,
            });
            const slimFinish = (slimFb as { finishReason?: string }).finishReason;
            if (slimFinish === "length" || slimFinish === "max-tokens") {
              throw new Error(`slim truncated (finishReason=${slimFinish})`);
            }
            const parsed = AiPickGroupSchema.parse(JSON.parse(extractJson(slimFb.text || "")));
            console.log(
              `[Echo/AI-rank] "${group.cuisine}" slim fallback ok in ${Date.now() - startedAt}ms, picks=${parsed.picks.length}`,
            );
            return { cuisine: group.cuisine, picks: parsed.picks };
          } catch (e3) {
            const m3 = e3 instanceof Error ? e3.message : String(e3);
            console.error(`[Echo/AI-rank] "${group.cuisine}" failed: ${m3}`);
            return { cuisine: group.cuisine, picks: [] };
          }
        }
      }
    };

    yield { type: "stage", stage: "rank" };
    const rankStartedAt = Date.now();
    // 用心跳包裹整个并行排序，避免边缘网关因为长时间静默切流。
    const groupResults = yield* withHeartbeat(
      Promise.all(candidatesForPrompt.map(async (group) => {
        const BATCH_SIZE = 12;
        const batches = [];
        for (let i = 0; i < group.candidates.length; i += BATCH_SIZE) {
          batches.push(group.candidates.slice(i, i + BATCH_SIZE));
        }
        const batchPicks = await Promise.all(batches.map(async (batch) => {
          const res = await rankOneGroup({ ...group, candidates: batch });
          return res.picks;
        }));
        return { cuisine: group.cuisine, picks: batchPicks.flat() };
      })),
      "rank",
    );
    console.log(
      `[Echo/AI-rank] all ${groupResults.length} group(s) done in ${Date.now() - rankStartedAt}ms`,
    );
    const mergedGroups = new Map<string, z.infer<typeof AiPickSchema>[]>();
    for (const result of groupResults) {
      const existing = mergedGroups.get(result.cuisine) ?? [];
      const byId = new Map(existing.map((pick) => [pick.placeId, pick]));
      for (const pick of result.picks) byId.set(pick.placeId, pick);
      mergedGroups.set(result.cuisine, Array.from(byId.values()));
    }
    const ranking: z.infer<typeof AiRankingSchema> = {
      groups: Array.from(mergedGroups, ([cuisine, picks]) => ({ cuisine, picks })),
    };

    // 3. 全量候选按 ok → unknown → fail 分级，再依次补足至 5 家。
    const placeByRestaurantId = new Map<string, PlaceCandidate>();
    const groups = data.cuisines.map((cuisine) => {
      const pool = placeResults.find((r) => r.cuisine === cuisine)?.places ?? [];
      const aiGroup = ranking.groups.find((g) => g.cuisine.toLowerCase() === cuisine.toLowerCase());
      const pickById = new Map((aiGroup?.picks ?? []).map((pick) => [pick.placeId, pick]));
      type Built = { restaurant: z.infer<typeof RestaurantSchema>; failedWeight: number; failedCount: number };
      const buckets: Record<"ok" | "unknown" | "fail", Built[]> = { ok: [], unknown: [], fail: [] };

      for (const [idx, p] of pool.entries()) {
        const pick = pickById.get(p.placeId);
        const checksByFilter = new Map((pick?.hardFilterChecks ?? []).map((check) => [check.filter, check]));
        const aiChecks = pick?.hardFilterChecks ?? [];
        const checks = data.hardFilters.map((filter, filterIndex) => {
          const deterministicRatingCheck = verifyGoogleRatingFilter(filter.text, p.rating, isEn);
          const aiCheck = checksByFilter.get(filter.text) ??
            (aiChecks.length === data.hardFilters.length ? aiChecks[filterIndex] : undefined);
          return {
            filter,
            check: deterministicRatingCheck
              ? { filter: filter.text, ...deterministicRatingCheck }
              : aiCheck ?? {
                  filter: filter.text,
                  status: "unknown" as const,
                  note: isEn ? "Verification incomplete" : "核验未完成",
                },
          };
        });
        const hasFail = checks.some(({ check }) => check.status === "fail");
        const hasUnknown = checks.some(({ check }) => check.status === "unknown");
        const verificationStatus = hasFail ? "fail" : hasUnknown ? "unknown" : "ok";
        const failedWeight = checks.reduce((sum, { filter, check }) => sum + (check.status === "fail" ? filter.weight : 0), 0);
        const failedCount = checks.filter(({ check }) => check.status === "fail").length;
        const unknownWeight = checks.reduce((sum, { filter, check }) => sum + (check.status === "unknown" ? filter.weight : 0), 0);
        const baseScore = pick?.matchScore ?? (p.rating != null ? p.rating * 14 : 50);
        const score = Math.max(0, Math.min(100, Math.round(baseScore - failedWeight * 25 - unknownWeight * 4)));
        const hardDetails = checks.map(({ filter, check }) => ({
          label: check.status === "ok"
            ? (isEn ? `✓ Constraint: ${filter.text}` : `✓ 硬条件：${filter.text}`)
            : check.status === "fail"
              ? (isEn ? `✗ Constraint not met: ${filter.text}${check.note ? ` — ${check.note}` : ""}` : `✗ 硬条件未满足：${filter.text}${check.note ? ` — ${check.note}` : ""}`)
              : (isEn ? `? Constraint to verify: ${filter.text}${check.note ? ` — ${check.note}` : ""}` : `？ 硬条件待核实：${filter.text}${check.note ? ` — ${check.note}` : ""}`),
          status: (check.status === "ok" ? "ok" : "warn") as "ok" | "warn",
        }));
        const aiDetails = (pick?.matchDetails ?? []).slice(0, 5).map((detail) => ({
          label: detail.label,
          status: (detail.status === "ok" ? "ok" : "warn") as "ok" | "warn",
        }));
        const review = reviewById.get(p.placeId) ?? null;
        const tabelogInfo = tabelogById.get(p.placeId) ?? null;
        const yelpInfo = yelpById.get(p.placeId) ?? null;
        const restaurant: z.infer<typeof RestaurantSchema> = {
          id: `${cuisine}-${idx}-${p.placeId}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80),
          name: p.name,
          localName: p.name,
          cuisine,
          address: p.address,
          googleMapsUri: p.googleMapsUri,
          websiteUri: p.websiteUri,
          primaryType: p.primaryType,
          matchScore: score,
          matchTier: verificationStatus === "ok" ? tierFromScore(score) : "partial",
          openNow: p.openNow ?? true,
          reservable: false,
          needsReview: verificationStatus !== "ok" || p.rating == null,
          verificationStatus,
          ratings: candidateRatings(p, review, tabelogInfo, isEn, country, yelpInfo),
          aiSummary: pick?.aiSummary?.trim() || (isEn
            ? `${p.name} was retained because its detailed conditions could not be fully verified.`
            : `${p.name} 因资料不足暂时保留，具体条件尚未完全核实。`),
          matchDetails: [...hardDetails, ...aiDetails].slice(0, 8),
          pros: pick?.pros ?? [],
          cons: pick?.cons ?? [],
          links: buildLinks(p, data.city, country, isEn, yelpInfo?.url ?? null),
          photoUrls: [],
          tabelog: tabelogInfo,
          yelp: yelpInfo,
          weekdayDescriptions: p.weekdayDescriptions ?? null,
          visitTimeMatch: visitMatchById.get(p.placeId) ?? null,
        };
        placeByRestaurantId.set(restaurant.id, p);
        buckets[verificationStatus].push({ restaurant, failedWeight, failedCount });
      }

      buckets.ok.sort((a, b) => b.restaurant.matchScore - a.restaurant.matchScore);
      buckets.unknown.sort((a, b) => b.restaurant.matchScore - a.restaurant.matchScore);
      buckets.fail.sort((a, b) => a.failedWeight - b.failedWeight || a.failedCount - b.failedCount || b.restaurant.matchScore - a.restaurant.matchScore);
      let remaining = 5;
      const restaurants = buckets.ok.slice(0, remaining).map(({ restaurant }) => restaurant);
      remaining -= restaurants.length;
      const partialRestaurants = buckets.unknown.slice(0, remaining).map(({ restaurant }) => restaurant);
      remaining -= partialRestaurants.length;
      const failedRestaurants = buckets.fail.slice(0, remaining).map(({ restaurant }) => restaurant);
      return {
        cuisine: cuisinesAutoFilled ? (isEn ? "Recommended for you" : "为你推荐") : cuisine,
        restaurants,
        ...(partialRestaurants.length ? { partialRestaurants } : {}),
        ...(failedRestaurants.length ? { failedRestaurants } : {}),
      };
    }).filter((group) => group.restaurants.length + (group.partialRestaurants?.length ?? 0) + (group.failedRestaurants?.length ?? 0) > 0);

    yield { type: "stage", stage: "photos" };
    const allRestaurants = groups.flatMap((group) => [
      ...group.restaurants,
      ...(group.partialRestaurants ?? []),
      ...(group.failedRestaurants ?? []),
    ]);
    yield* withHeartbeat(Promise.all(allRestaurants.map(async (restaurant) => {
      const place = placeByRestaurantId.get(restaurant.id);
      const urls = await Promise.all((place?.photoNames ?? []).slice(0, 6).map((name) => resolvePhotoUrl(name, 800)));
      restaurant.photoUrls = urls.filter((url): url is string => Boolean(url));
    })), "photos");

    const missing = data.cuisines.filter((cuisine) =>
      !placeResults.some((group) => group.cuisine.toLowerCase() === cuisine.toLowerCase() && group.places.length),
    );
    yield {
      type: "result",
      payload: {
        groups: ResultsSchema.parse({ groups }).groups,
        error: missing.length
          ? (isEn ? `No candidates found for "${missing.join(", ")}"` : `没有找到「${missing.join("、")}」的候选`)
          : null,
        suggestions: missing.length ? fallbackSuggestions(uiLang) : [],
        warnings: warnings.length ? warnings : undefined,
      },
    };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[searchRestaurants] uncaught:", msg);
      yield {
        type: "result",
        payload: {
          groups: [],
          error: isEn
            ? `Search failed unexpectedly: ${msg.slice(0, 200)}`
            : `搜索意外失败：${msg.slice(0, 200)}`,
          suggestions: fallbackSuggestions(uiLang),
          warnings: warnings.length ? warnings : undefined,
        },
      };
    }
  });

