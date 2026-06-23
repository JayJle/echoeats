import { createServerFn } from "@tanstack/react-start";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway";

const PLATFORMS = ["Google Maps", "Tabelog", "Yelp"];

// ---- 节点级日志小工具：统一 [Echo/<stage>] start / ok / fail 前缀 ----
function _echoFmt(extra?: Record<string, unknown>): string {
  if (!extra) return "";
  return Object.entries(extra)
    .map(([k, v]) => {
      if (v === null || v === undefined) return `${k}=null`;
      if (typeof v === "string") return `${k}="${v}"`;
      if (typeof v === "number" || typeof v === "boolean") return `${k}=${v}`;
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(" ");
}
const echoLog = {
  start: (stage: string, extra?: Record<string, unknown>) => {
    console.log(`[Echo/${stage}] start ${_echoFmt(extra)}`.trim());
  },
  ok: (stage: string, ms: number, extra?: Record<string, unknown>) => {
    console.log(`[Echo/${stage}] ok in ${ms}ms ${_echoFmt(extra)}`.trim());
  },
  fail: (
    stage: string,
    ms: number,
    err: unknown,
    extra?: Record<string, unknown>,
  ) => {
    const m = err instanceof Error ? err.message : String(err);
    console.error(
      `[Echo/${stage}] failed in ${ms}ms reason="${m}" ${_echoFmt(extra)}`.trim(),
    );
  },
};

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

type WeightedCondition = z.infer<typeof WeightedConditionSchema>;

function conditionKey(text: string): string {
  const source = text.split(/\s*(?:→|->|=>)\s*/, 1)[0] || text;
  return source
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function uniqueConditions(items: WeightedCondition[]): WeightedCondition[] {
  const unique = new Map<string, WeightedCondition>();
  for (const item of items) {
    const key = conditionKey(item.text);
    if (!key) continue;
    const existing = unique.get(key);
    if (!existing) unique.set(key, item);
    else if (item.weight > existing.weight) unique.set(key, { ...existing, weight: item.weight });
  }
  return [...unique.values()];
}

function uniqueStrings(items: string[]): string[] {
  const unique = new Map<string, string>();
  for (const item of items) {
    const value = item.normalize("NFKC").trim();
    const key = value.toLocaleLowerCase();
    if (key && !unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()];
}

function dedupeParsedConditions(parsed: z.infer<typeof ParsedSchema>): z.infer<typeof ParsedSchema> {
  const negativeFilters = uniqueConditions(parsed.negativeFilters);
  const negativeKeys = new Set(negativeFilters.map((item) => conditionKey(item.text)));
  const hardFilters = uniqueConditions(parsed.hardFilters).filter(
    (item) => !negativeKeys.has(conditionKey(item.text)),
  );
  const hardKeys = new Set(hardFilters.map((item) => conditionKey(item.text)));
  const softPreferences = uniqueConditions(parsed.softPreferences).filter((item) => {
    const key = conditionKey(item.text);
    return !negativeKeys.has(key) && !hardKeys.has(key);
  });
  const dishPreferences = [...new Map(
    parsed.dishPreferences
      .map((dish) => [conditionKey(dish), dish.trim()] as const)
      .filter(([key, dish]) => key && dish),
  ).values()];

  return {
    ...parsed,
    cuisines: uniqueStrings(parsed.cuisines),
    negativeFilters,
    hardFilters,
    softPreferences,
    dishPreferences,
  };
}

const MEAL_PERIOD_ANCHORS: Array<{ pattern: RegExp; hhmm: string }> = [
  { pattern: /afternoon\s+tea|下午茶/i, hhmm: "15:00" },
  { pattern: /late[-\s]?night(?:\s+(?:meal|food|dining))?|夜宵|宵夜/i, hhmm: "22:00" },
  { pattern: /brunch|早午餐/i, hhmm: "10:30" },
  { pattern: /breakfast|早餐|早饭|早飯/i, hhmm: "08:30" },
  { pattern: /lunch|午餐|午饭|午飯|中午饭|中午飯/i, hhmm: "12:30" },
  { pattern: /dinner|supper|晚餐|晚饭|晚飯/i, hhmm: "19:00" },
];

function inferWeekdayFromText(text: string, today: number): number | null {
  if (/后天/.test(text)) return (today + 2) % 7;
  if (/明天|tomorrow/i.test(text)) return (today + 1) % 7;
  if (/今天|今晚|today|tonight/i.test(text)) return today;

  const weekdayPatterns: Array<[RegExp, number]> = [
    [/(?:周|星期|礼拜)[日天]|sunday/i, 0],
    [/(?:周|星期|礼拜)一|monday/i, 1],
    [/(?:周|星期|礼拜)二|tuesday/i, 2],
    [/(?:周|星期|礼拜)三|wednesday/i, 3],
    [/(?:周|星期|礼拜)四|thursday/i, 4],
    [/(?:周|星期|礼拜)五|friday/i, 5],
    [/(?:周|星期|礼拜)六|saturday/i, 6],
  ];
  return weekdayPatterns.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function inferMealPeriod(text: string): { evidence: string; hhmm: string } | null {
  for (const { pattern, hhmm } of MEAL_PERIOD_ANCHORS) {
    const match = text.match(pattern);
    if (match?.[0]) return { evidence: match[0], hhmm };
  }
  return null;
}

function inferExplicitClock(text: string): string | null {
  const clock24 = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (clock24) {
    return `${clock24[1].padStart(2, "0")}:${clock24[2]}`;
  }
  const clock12 = text.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i);
  if (!clock12) return null;
  const period = clock12[3].toLowerCase();
  const hour = (Number(clock12[1]) % 12) + (period === "pm" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${clock12[2] ?? "00"}`;
}

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
  - 上海/北京/成都/苏州/杭州/重庆/西安/广州/深圳等大陆城市 → "CN"
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
- \`hhmm\`：24 小时制 "HH:MM"。用户提到餐段就是明确的时间信号，必须推断对应锚点，不得因为没有钟表数字而遗漏。
  - 具体钟点："7 点"→"19:00"（晚上语境）/"07:00"（早上语境）；"7pm"→"19:00"；"12:30"→"12:30"；"下午 2 点半"→"14:30"
  - 餐段锚点：早餐/breakfast→"08:30"，早午餐/brunch→"10:30"，午餐/午饭/lunch→"12:30"，下午茶/afternoon tea→"15:00"，晚餐/晚饭/dinner/supper→"19:00"，夜宵/宵夜/late-night meal→"22:00"
  - 其它模糊时段锚点：早上/morning→"08:30"，中午/noon→"12:30"，下午/afternoon→"14:30"，傍晚/evening→"18:30"，晚上/night→"19:00"，深夜/late night→"22:00"
  - 同时出现餐段和具体钟点时，始终以用户的具体钟点为准，例如 "brunch at 11:30"→"11:30"
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
- 输入「明天 12:30」→ \`{"mentioned":true,"evidence":"明天 12:30","weekday":${(new Date().getDay() + 1) % 7},"hhmm":"12:30","raw":"明天 12:30"}\`
- 输入「Saturday brunch」→ \`{"mentioned":true,"evidence":"Saturday brunch","weekday":6,"hhmm":"10:30","raw":"Saturday brunch"}\`
- 输入「dinner tomorrow」→ \`{"mentioned":true,"evidence":"dinner tomorrow","weekday":${(new Date().getDay() + 1) % 7},"hhmm":"19:00","raw":"dinner tomorrow"}\`
- 输入「周日早午餐」→ \`{"mentioned":true,"evidence":"周日早午餐","weekday":0,"hhmm":"10:30","raw":"周日早午餐"}\`
- 输入「brunch place」→ \`{"mentioned":true,"evidence":"brunch","weekday":null,"hhmm":"10:30","raw":"brunch"}\`（保留餐段意图，但不虚构日期、不做指定星期硬过滤）`;

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
      return dedupeParsedConditions(parsed);
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
      const mealPeriod = inferMealPeriod(data.freeText ?? "");
      const explicitClock = inferExplicitClock(data.freeText ?? "");
      const inferredWeekday = inferWeekdayFromText(data.freeText ?? "", new Date().getDay());
      if ((!vt || !vt.mentioned) && mealPeriod) {
        return {
          ...parsed,
          visitTime: {
            mentioned: true,
            evidence: mealPeriod.evidence,
            weekday: inferredWeekday,
            hhmm: explicitClock ?? mealPeriod.hhmm,
            raw: mealPeriod.evidence,
          },
        };
      }
      if (!vt || !vt.mentioned) return { ...parsed, visitTime: null };
      // evidence 必须真实出现在原文里（大小写/空格归一化），防 AI 幻觉
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
      const ev = norm(vt.evidence ?? "");
      const src = norm(data.freeText ?? "");
      if (!ev || !src.includes(ev)) {
        if (mealPeriod) {
          return {
            ...parsed,
            visitTime: {
              mentioned: true,
              evidence: mealPeriod.evidence,
              weekday: inferredWeekday,
              hhmm: explicitClock ?? vt.hhmm ?? mealPeriod.hhmm,
              raw: mealPeriod.evidence,
            },
          };
        }
        return { ...parsed, visitTime: null };
      }
      if (mealPeriod) {
        return {
          ...parsed,
          visitTime: {
            ...vt,
            weekday: vt.weekday ?? inferredWeekday,
            hhmm: explicitClock ?? vt.hhmm ?? mealPeriod.hhmm,
          },
        };
      }
      // 非餐段时间仍要求 weekday + hhmm 都齐才用于过滤
      if (vt.weekday == null || !vt.hhmm) {
        return { ...parsed, visitTime: null };
      }
      return parsed;
    };

    const _parseT0 = Date.now();
    echoLog.start("parseRequirements", {
      city: data.city,
      cuisines: data.cuisines.length,
      autoInfer: data.autoInferCuisines,
      freeTextLen: (data.freeText ?? "").length,
      uiLang: data.uiLanguage,
    });
    try {
      let parsed: z.infer<typeof ParsedSchema>;
      try {
        const first = await runOnce("google/gemini-2.5-flash");
        parsed = sanitizeVisitTime(await enforceInferIfRequested(first));
      } catch (e1) {
        console.warn("[parseRequirements] 第一次解析失败：", e1 instanceof Error ? e1.message : e1);
        // 跨供应商重试，避免同模型以同样方式再次失败
        const second = await runOnce("openai/gpt-5-mini");
        parsed = sanitizeVisitTime(await enforceInferIfRequested(second));
      }
      echoLog.ok("parseRequirements", Date.now() - _parseT0, {
        cuisines: parsed.cuisines.length,
        hard: parsed.hardFilters.length,
        soft: parsed.softPreferences.length,
        neg: parsed.negativeFilters.length,
        dishes: parsed.dishPreferences.length,
        visitTime: parsed.visitTime ? "yes" : "no",
        mode: parsed.mode,
      });
      return parsed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 兜底：返回最小可用结构，避免整页崩溃
      echoLog.fail("parseRequirements", Date.now() - _parseT0, e, { fallback: "yes" });
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
  isPlaceClearlyOutsideTargetRegion,
  resolvePhotoUrl,
  searchPlaces,
  type PlaceCandidate,
} from "./google-places.server";
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

const SOURCE_ENUM = ["Tabelog", "Google Reviews", "Yelp", "TripAdvisor", "其它"] as const;


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
  matchDetails: z.array(z.object({ label: z.string(), status: z.enum(["ok", "unknown", "fail"]) })),
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
  scoreBreakdown: z.array(z.object({ label: z.string(), delta: z.number() })).optional().default([]),
  recallSources: z.array(z.string()).optional().default([]),
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
    if (typeof v === "string") return { label: v, status: "unknown", confidence: 50 };
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
      return { ...obj, label, status: obj.status ?? "unknown", confidence: obj.confidence ?? 50 };
    }
    return { label: "", status: "unknown", confidence: 50 };
  },
  z.object({
    label: z.string().catch(""),
    status: z.enum(["ok", "unknown", "fail"]).catch("unknown"),
    confidence: z.coerce.number().min(0).max(100).catch(50).default(50),
  }),
);

const HardFilterCheckSchema = z.preprocess(
  (v) => {
    if (typeof v === "string") return { filter: v, status: "unknown", note: v, confidence: 50 };
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
      return { ...obj, filter, note, status: obj.status ?? "unknown", confidence: obj.confidence ?? 50 };
    }
    return { filter: "", status: "unknown", confidence: 50 };
  },
  z.object({
    filter: z.string().catch("").default(""),
    status: z.enum(["ok", "unknown", "fail"]).catch("unknown"),
    note: z.string().optional(),
    confidence: z.coerce.number().min(0).max(100).catch(50).default(50),
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

// Pass 1 (核验) 输出 schema：只产 verificationStatus + hardFilterChecks + matchDetails；不含 matchScore，也不含文案
const AiVerifyPickSchema = z.object({
  placeId: z.string(),
  verificationStatus: z.enum(["ok", "unknown", "fail"]).optional(),
  hardFilterChecks: z.array(HardFilterCheckSchema).catch([]).default([]),
  matchDetails: z.array(MatchDetailSchema).catch([]).default([]),
});
const AiVerifyGroupSchema = z.object({
  picks: z.array(AiVerifyPickSchema),
});

// Pass 2 (仅打分) 输出 schema：极简两字段，最大化模型遵循率
const AiScorePickSchema = z.object({
  placeId: z.string(),
  matchScore: z.coerce.number().min(0).max(100),
});
const AiScoreGroupSchema = z.object({
  scores: z.array(AiScorePickSchema),
});

// Pass 3 (文案) 输出 schema：只产 aiSummary + pros + cons
const AiCopyPickSchema = z.object({
  placeId: z.string(),
  aiSummary: z.string().default(""),
  pros: z.array(z.preprocess(
    (v) => (typeof v === "string" ? { text: v, source: null } : v),
    z.object({ text: z.string(), source: z.string().nullable().optional() }),
  )).default([]),
  cons: z.array(z.preprocess(
    (v) => (typeof v === "string" ? { text: v, source: null } : v),
    z.object({ text: z.string(), source: z.string().nullable().optional() }),
  )).default([]),
});
const AiCopyGroupSchema = z.object({
  picks: z.array(AiCopyPickSchema),
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
  } else if (/(?:超过|高于|大于|above|over|greater than|more than|>|》|〉)/i.test(text)) {
    passes = rating > threshold;
  } else {
    passes = rating >= threshold;
  }
  const comparator = /(?:不超过|至多|最高|以下|不高于|at most|no more than|up to|<=|≤)/i.test(text)
    ? "≤"
    : /(?:低于|少于|小于|below|under|less than|<)/i.test(text)
      ? "<"
      : /(?:超过|高于|大于|above|over|greater than|more than|>|》|〉)/i.test(text)
        ? ">"
        : "≥";
  return {
    status: passes ? "ok" : "fail",
    note: isEn
      ? `Google Maps rating is ${rating.toFixed(1)} / 5; requirement: ${comparator} ${threshold}`
      : `Google Maps 实际评分 ${rating.toFixed(1)} / 5；要求 ${comparator} ${threshold} 分`,
  };
}

function cleanMatchLabel(text: string): string {
  return text
    .trim()
    .replace(/^[✓✔✗✘?？⚠!！]+\s*/g, "")
    .replace(/^(?:constraint(?: not met| to verify)?|硬条件(?:未满足|待核实)?)\s*[:：-]?\s*/i, "")
    .trim();
}

function conciseCondition(text: string): string {
  const cleaned = cleanMatchLabel(text);
  const [original] = cleaned.split(/\s*(?:→|->|=>)\s*/, 1);
  return (original || cleaned).replace(/[：:—-]+\s*$/, "").trim();
}

function conciseEvidence(text: string | undefined, condition: string, isEn: boolean): string {
  if (!text?.trim()) return isEn ? "No supporting information found" : "暂无相关资料";

  let cleaned = cleanMatchLabel(text)
    .replace(
      new RegExp(
        `^${condition.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:→|->|=>|[-—:：])\\s*`,
        "i",
      ),
      "",
    )
    .replace(/\bPrimaryType\b/gi, isEn ? "restaurant type" : "餐厅类型")
    .replace(/\breviewHighlights?\b/gi, isEn ? "reviews" : "评论")
    .replace(/\beditorialSummary\b/gi, isEn ? "editorial summary" : "商家摘要")
    .replace(/\brealWorldReviews\b/gi, isEn ? "customer reviews" : "用户评论")
    .replace(/(?:菜系|餐厅档次|包含菜品)\s*=\s*/g, "")
    .replace(/\s*(?:→|->|=>)\s*/g, isEn ? ": " : "：")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 90) {
    const sentence = cleaned.match(/^.{1,90}?[。！？.!?](?:\s|$)/)?.[0];
    cleaned = sentence?.trim() || `${cleaned.slice(0, 88).trim()}…`;
  }
  return cleaned || (isEn ? "No supporting information found" : "暂无相关资料");
}

function reconcileEvidenceStatus(
  status: "ok" | "unknown" | "fail",
  evidence: string | undefined,
): "ok" | "unknown" | "fail" {
  if (!evidence?.trim()) return status;
  const text = evidence.trim();

  // 否定/未提及（中英文双语）
  const saysNegated =
    /(未(?:明确|具体|直接|特别)?(?:提及|说明|提到|强调|确认|涉及|涵盖|体现)|没(?:有)?(?:具体|明确|特别|直接)?(?:提及|说明|提到|涉及|体现)|暂无(?:相关)?(?:资料|信息|证据|提及|评论|描述)|未?找到(?:相关|具体|明确)?(?:资料|信息|证据|描述)|缺(?:乏|少)(?:相关|具体|明确)?(?:资料|信息|证据|描述)|但(?:是)?\s*[^。.!?]{0,20}(?:没|未|不|无)\s*(?:有|能|够|到|明确)?(?:提及|说明|提到|涉及|强调)?|do(?:es)?(?:n't|\s+not)\s+(?:specifically|directly|clearly|explicitly|particularly|really)?\s*(?:mention|state|confirm|note|reference|address|discuss|cover|highlight|specify)|no\s+(?:specific|direct|clear|explicit|particular)\s+(?:mention|reference|evidence|information|confirmation)|but\s+[^.!?]{0,40}\b(?:do(?:es)?\s+not|don't|doesn't|did(?:n't| not)|no(?:t)?)\b|however[^.!?]{0,40}\b(?:do(?:es)?\s+not|don't|doesn't|not|no)\b|fails?\s+to\s+(?:mention|specify|address|confirm)|without\s+(?:specific|clear|direct|explicit)\s+(?:mention|reference)|nothing\s+(?:specifically|directly)?\s*(?:mentions?|states?|confirms?))/i.test(
      text,
    );

  // 不确定（中英文双语）
  const saysUncertain =
    /(可能|很可能|大概|推测|或许|似乎|貌似|疑似|资料不足|信息不足|待核实|无法(?:确认|核实|判断)|不(?:能|足以)(?:确认|核实|判断)|unknown|unclear|unavailable|insufficient|possibly|probably|likely|presumably|maybe|may\b|might\b|could\s+be|appears?\s+to|seems?\s+to|cannot\s+(?:confirm|verify|determine|tell)|hard\s+to\s+(?:tell|confirm))/i.test(
      text,
    );

  // 明确反例 / 不符合
  const saysContradicts =
    /(明显不符合|明确不符合|不符合(?:要求|条件|标准|定位)|与.{0,10}不符|与.{0,10}相悖|与.{0,10}冲突|与.{0,10}矛盾|与要求相反|命中反例|属于反例|does\s+not\s+match|doesn'?t\s+match|contradict(?:s|ed)?|conflicts?\s+with|opposite\s+of|fails?\s+(?:the\s+)?requirement|violates?\s+the\s+(?:requirement|criteria))/i.test(
      text,
    );

  // 明确正向
  const citesPositiveEvidence =
    /(明确(?:指出|提到|显示|表明|支持|强调|符合)|评论(?:指出|提到|显示|表明|称|强调|赞扬|盛赞|好评)|证据(?:显示|表明|支持)|资料(?:显示|表明|支持)|实际(?:为|有|达到)|符合(?:.{0,16})?(?:定位|要求|条件)?|满足(?:要求|条件)?|达标|支持该条件|命中(?:主词|同义词|正向)|(?:没有|未)(?:命中|发现)(?:任何)?(?:反例|负面)(?:关键词)?|explicitly\s+(?:states?|mentions?|shows?|supports?|confirms?|matches?)|reviews?\s+(?:state|mention|note|say|show|confirm|praise|highlight|emphasi[sz]e)|evidence\s+(?:shows?|supports?|confirms?)|is\s+confirmed|requirements?\s+(?:is\s+|are\s+)?met|clearly\s+(?:matches?|satisf(?:y|ies|ied)))/i.test(
      text,
    );

  // 反例优先级最高
  if (saysContradicts) return "fail";

  if (status === "ok") {
    // ok 但文案否定/不确定 → 降级
    if (saysNegated || saysUncertain) return "unknown";
    return "ok";
  }
  if (status === "unknown") {
    if (saysNegated || saysUncertain) return "unknown";
    if (citesPositiveEvidence) return "ok";
    return "unknown";
  }
  // status === "fail": 保留 AI 的负面判断（除非文案完全正向，且无任何否定信号 — 罕见，留作保险）
  if (citesPositiveEvidence && !saysNegated && !saysUncertain) return "unknown";
  return "fail";
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

  const isJP = country === "JP";

  if (isJP) {
    links.push({
      label: "Tabelog",
      url: `https://www.google.com/search?q=${encodeURIComponent(`site:tabelog.com ${p.name}`)}`,
    });
  }

  links.push({ label: "Google Maps", url: p.googleMapsUri });
  if (p.websiteUri) {
    links.push({
      label: isEn ? "Website" : "官网",
      url: p.websiteUri,
    });
  }

  // 海外（含日本/港澳台）：加 Yelp + TripAdvisor 链接
  links.push({
    label: "Yelp",
    url: yelpUrl ?? `https://www.yelp.com/search?find_desc=${qName}&find_loc=${qCity}`,
  });
  links.push({
    label: "TripAdvisor",
    url: `https://www.tripadvisor.com/Search?q=${q}`,
  });

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
  const isJP = country === "JP";
  const score =
    p.rating != null
      ? `${p.rating.toFixed(1)} / 5${p.userRatingCount ? ` (${p.userRatingCount})` : ""}`
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
  .inputValidator((input: unknown) => dedupeParsedConditions(ParsedSchema.parse(input)))
  .handler(async function* ({ data }): AsyncGenerator<SearchStreamChunk, void, unknown> {
    const uiLang: "zh" | "en" = data.uiLanguage ?? "zh";
    const isEn = uiLang === "en";
    const warnings: Array<{ stage: string; cuisine?: string; message: string; retryable?: boolean }> = [];
    const pushWarn = (w: { stage: string; cuisine?: string; message: string; retryable?: boolean }) => {
      if (warnings.length < 10) warnings.push(w);
    };
    const _pipelineT0 = Date.now();
    let _currentStage = "init";
    echoLog.start("pipeline", {
      city: data.city,
      cuisines: data.cuisines.length,
      mode: data.mode,
      hard: data.hardFilters.length,
      soft: data.softPreferences.length,
      neg: data.negativeFilters.length,
      dishes: data.dishPreferences.length,
      visitTime: data.visitTime ? "yes" : "no",
      lang: uiLang,
    });
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
    // 已知城市优先使用确定性国家映射，避免 AI 偶发把东京解析成香港等错误地区。
    const country =
      guessRegionCode(data.city) ||
      (data.country && data.country.toUpperCase()) ||
      "";

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

    if (!process.env.GOOGLE_PLACES_API_KEY) {
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

    yield {
      type: "stage",
      stage: "places",
      message: isEn ? `Searching candidates in ${data.city}…` : `搜索 ${data.city} 候选餐厅…`,
    };
    _currentStage = "places";
    const _placesT0 = Date.now();
    echoLog.start("places", { cuisines: data.cuisines.length, country });

    const reviewById = new Map<string, ReviewSummary>();
    const cuisineExpansions = new Map<string, CuisineExpansion>();
    const recallSourcesById = new Map<string, string[]>();
    let placeResults: Array<{
      cuisine: string;
      places: PlaceCandidate[];
      error: string | null;
    }>;

    {
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

          // Build up to 8 recall routes per cuisine; each route is { tag, query }.
          // tag is stored on each candidate as recallSources for downstream scoring.
          const routes: { tag: string; query: string }[] = [];
          const pushRoute = (tag: string, query: string) => {
            if (routes.length >= 8) return;
            if (routes.some((r) => r.query === query)) return;
            routes.push({ tag, query });
          };
          pushRoute("primary", `${expansion.primary} ${data.city}`);
          pushRoute("recommend", `${expansion.primary} ${data.city} ${semanticSuffix}`);
          for (const syn of expansion.synonyms.slice(0, 2)) {
            pushRoute(`synonym:${syn}`, `${syn} ${data.city}`);
          }

          if (data.mode !== "quick") {
            // dish routes (one per dish, capped by remaining slots)
            for (const dish of data.dishPreferences) {
              pushRoute(`dish:${dish}`, `${dish} ${data.city}`);
            }

            // scene route (detect scene keywords across hard/soft)
            const allCondText = [...data.hardFilters, ...data.softPreferences]
              .map((c) => c.text).join(" ");
            const sceneMatches: Array<[RegExp, string, Record<string, string>]> = [
              [/包间|个室|個室|private\s*room/i, "private-room", { ja: "個室", "zh-CN": "包间", "zh-TW": "包廂", en: "private room" }],
              [/一个人|一人|独自|一人飯|solo|alone/i, "solo", { ja: "一人飯", "zh-CN": "一个人", "zh-TW": "一人", en: "solo dining" }],
              [/约会|約會|date\s*night|romantic/i, "date", { ja: "デート", "zh-CN": "约会", "zh-TW": "約會", en: "date night" }],
              [/家庭|带(?:小孩|宝宝|娃|孩子)|family|kid/i, "family", { ja: "ファミリー", "zh-CN": "家庭", "zh-TW": "家庭", en: "family friendly" }],
              [/聚会|聚餐|group|party/i, "group", { ja: "宴会", "zh-CN": "聚会", "zh-TW": "聚會", en: "group dining" }],
              [/安静|安靜|quiet/i, "quiet", { ja: "静かな", "zh-CN": "安静", "zh-TW": "安靜", en: "quiet" }],
            ];
            for (const [pattern, tagSuffix, words] of sceneMatches) {
              if (pattern.test(allCondText)) {
                const word = words[language] ?? words.en;
                pushRoute(`scene:${tagSuffix}`, `${expansion.primary} ${data.city} ${word}`);
              }
            }

            // time route (brunch / late-night) when visitTime hhmm is at edge hours
            const hh = data.visitTime?.hhmm ? parseInt(data.visitTime.hhmm.split(":")[0], 10) : null;
            if (hh != null) {
              if (hh >= 22 || hh < 5) {
                const word = language === "ja" ? "深夜営業" : language.startsWith("zh") ? "深夜营业" : "late night";
                pushRoute("time:late-night", `${expansion.primary} ${data.city} ${word}`);
              } else if (hh >= 10 && hh <= 11) {
                const word = language === "ja" ? "ブランチ" : language.startsWith("zh") ? "早午餐" : "brunch";
                pushRoute("time:brunch", `${expansion.primary} ${data.city} ${word}`);
              }
            }

            // budget route (high / low) — detect from hard filters
            const hardText = data.hardFilters.map((c) => c.text).join(" ").toLowerCase();
            const highBudget = /(高级|高端|高級|奢华|fine\s*dining|expensive|高档|高檔|米其林|michelin|omakase)/i.test(hardText)
              || /(?:>=|≥|>|超过|以上|至少)\s*(?:\$|¥|€|hk\$|nt\$|s\$|£)?\s*(\d{4,})/.test(hardText);
            const lowBudget = /(便宜|平价|平價|学生价|cheap|budget|inexpensive|安い|安価|gasa)/i.test(hardText)
              || /(?:<=|≤|<|不超过|以内|至多)\s*(?:\$|¥|€|hk\$|nt\$|s\$|£)?\s*([1-9]\d{0,3})\b/.test(hardText);
            if (highBudget) {
              const word = language === "ja" ? "高級" : language.startsWith("zh") ? "高级" : "fine dining";
              pushRoute("budget:high", `${expansion.primary} ${data.city} ${word}`);
            } else if (lowBudget) {
              const word = language === "ja" ? "安い" : language.startsWith("zh") ? "便宜" : "cheap eats";
              pushRoute("budget:low", `${expansion.primary} ${data.city} ${word}`);
            }
          }

          const queries = data.mode === "quick"
            ? [{ tag: "primary", query: `${expansion.primary} ${data.city}` }]
            : routes;

          console.log(`[recall] cuisine="${cuisine}" routes=${queries.length} tags=[${queries.map((q) => q.tag).join(", ")}]`);

          const settled = await Promise.allSettled(
            queries.map((q) =>
              searchPlaces({ query: q.query, language, region, maxResults: 20 }),
            ),
          );
          // recallSourcesMap: placeId -> set of route tags that returned it
          const recallSourcesMap = new Map<string, Set<string>>();
          const merged = new Map<string, PlaceCandidate>();
          let firstError: string | null = null;
          for (let i = 0; i < settled.length; i++) {
            const s = settled[i];
            const tag = queries[i].tag;
            if (s.status === "fulfilled") {
              for (const p of s.value) {
                if (!merged.has(p.placeId)) merged.set(p.placeId, p);
                if (!recallSourcesMap.has(p.placeId)) recallSourcesMap.set(p.placeId, new Set());
                recallSourcesMap.get(p.placeId)!.add(tag);
              }
            } else if (!firstError) {
              firstError = s.reason instanceof Error ? s.reason.message : String(s.reason);
            }
          }
          // attach recallSources to each PlaceCandidate via a side-map (kept on outer scope)
          for (const [pid, tags] of recallSourcesMap) {
            recallSourcesById.set(pid, Array.from(tags));
          }
          const allPlaces = Array.from(merged.values());
          const inRegionPlaces = allPlaces.filter((place) => {
            const outside = isPlaceClearlyOutsideTargetRegion(place, region, data.city);
            if (outside) {
              console.warn(
                `[places/location] removed outside target region=${region || "unknown"} city="${data.city}" place="${place.name}" address="${place.address}"`,
              );
            }
            return !outside;
          });
          const places = filterByCuisineRelevance(inRegionPlaces, expansion);
          return { cuisine, places, error: places.length ? null : firstError };
        }),
      );
    }


    const totalCandidates = placeResults.reduce((s, r) => s + r.places.length, 0);
    echoLog.ok("places", Date.now() - _placesT0, {
      total: totalCandidates,
      perCuisine: Object.fromEntries(placeResults.map((r) => [r.cuisine, r.places.length])),
      errors: placeResults.filter((r) => r.error).length,
    });
    yield { type: "stage", stage: "places-done", count: totalCandidates };
    for (const r of placeResults) {
      if (!r.places.length && r.error) {
        pushWarn({
          stage: "places",
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
          error: isEn
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
          error: isEn
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
      _currentStage = "visitTime";
      const _vtT0 = Date.now();
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
      const _vtRemaining = placeResults.reduce((s, r) => s + r.places.length, 0);
      console.log(`[visitTime] weekday=${w} hhmm=${t} removed=${totalRemoved}`);
      echoLog.ok("visitTime", Date.now() - _vtT0, {
        weekday: w,
        hhmm: t,
        removed: totalRemoved,
        remaining: _vtRemaining,
      });
    }

    // 规则初筛：只用 Google Places 直接返回的字段
    // 1) businessStatus 非 OPERATIONAL → 剔除
    // 2) 高/低预算明显 → 用 priceLevel 剔除 mismatch（无数据不剔除）
    // 3) 评分硬门槛 (weight >= 0.85 且评论数 >= 30) → 剔除明显不达标
    const PRICE_RANK: Record<string, number> = {
      PRICE_LEVEL_FREE: 0,
      PRICE_LEVEL_INEXPENSIVE: 1,
      PRICE_LEVEL_MODERATE: 2,
      PRICE_LEVEL_EXPENSIVE: 3,
      PRICE_LEVEL_VERY_EXPENSIVE: 4,
    };
    const hardTextLower = data.hardFilters.map((c) => c.text).join(" ").toLowerCase();
    const wantsHighEnd = /(高级|高端|高級|奢华|fine\s*dining|expensive|高档|高檔|米其林|michelin|omakase|高価)/i.test(hardTextLower);
    const wantsLowBudget = /(便宜|平价|平價|学生价|cheap|budget|inexpensive|安い|安価)/i.test(hardTextLower);
    const ratingThresholdFilter = data.hardFilters.find(
      (f) => f.weight >= 0.85 && verifyGoogleRatingFilter(f.text, 5, isEn) !== null,
    );

    _currentStage = "rules-prefilter";
    const _rulesT0 = Date.now();
    let rulesRemoved = { businessStatus: 0, price: 0, rating: 0 };
    placeResults = placeResults.map((r) => {
      if (!r.places.length) return r;
      const kept: PlaceCandidate[] = [];
      for (const p of r.places) {
        if (p.businessStatus && p.businessStatus !== "OPERATIONAL") {
          rulesRemoved.businessStatus++;
          continue;
        }
        if (p.priceLevel && p.priceLevel in PRICE_RANK) {
          const rank = PRICE_RANK[p.priceLevel];
          if (wantsHighEnd && rank <= 1) { rulesRemoved.price++; continue; }
          if (wantsLowBudget && rank >= 4) { rulesRemoved.price++; continue; }
        }
        if (ratingThresholdFilter && p.rating != null && (p.userRatingCount ?? 0) >= 30) {
          const check = verifyGoogleRatingFilter(ratingThresholdFilter.text, p.rating, isEn);
          if (check?.status === "fail") { rulesRemoved.rating++; continue; }
        }
        kept.push(p);
      }
      return { ...r, places: kept };
    });
    console.log(`[rules-prefilter] removed businessStatus=${rulesRemoved.businessStatus} price=${rulesRemoved.price} rating=${rulesRemoved.rating}; candidate-pool=${placeResults.reduce((s, r) => s + r.places.length, 0)}`);
    echoLog.ok("rules-prefilter", Date.now() - _rulesT0, {
      businessStatus: rulesRemoved.businessStatus,
      price: rulesRemoved.price,
      rating: rulesRemoved.rating,
      remaining: placeResults.reduce((s, r) => s + r.places.length, 0),
    });

    // 把 Google Places 一手 reviews 作为基线证据塞入（零幻觉）。
    for (const r of placeResults) {
      for (const p of r.places) {
        const baseline = googleReviewsToSummary(p);
        if (baseline) reviewById.set(p.placeId, baseline);
      }
    }


    // JP 分支补充：用 Perplexity 代抓 Tabelog 评分+摘要+价位，作为 Google 之外的独立信号。
    // 覆盖所有候选（已经过料理保真过滤），并发上限 8 防止 Perplexity 限流。
    const tabelogById = new Map<string, TabelogInfo>();
    if (pplxKey && country === "JP" && data.mode !== "quick") {
      const allTargets: { p: PlaceCandidate; cuisine: string }[] = [];
      for (const r of placeResults) {
        for (const p of r.places) allTargets.push({ p, cuisine: r.cuisine });
      }
      yield { type: "stage", stage: "tabelog", total: allTargets.length };
      _currentStage = "tabelog";
      const _tabT0 = Date.now();
      echoLog.start("tabelog", { total: allTargets.length, concurrency: 8 });
      const CONCURRENCY = 8;
      let cursor = 0;
      const runWorker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= allTargets.length) return;
          const { p, cuisine } = allTargets[i];
          try {
            const info = await fetchTabelogInfo(p.name, p.address, data.city, cuisine);
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
      echoLog.ok("tabelog", Date.now() - _tabT0, {
        hit: tabelogById.size,
        total: allTargets.length,
        miss: allTargets.length - tabelogById.size,
      });
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
    if (pplxKey && YELP_COUNTRIES.has(country) && data.mode !== "quick") {
      const allTargets: { p: PlaceCandidate; cuisine: string }[] = [];
      for (const r of placeResults) {
        for (const p of r.places) allTargets.push({ p, cuisine: r.cuisine });
      }
      yield { type: "stage", stage: "yelp", total: allTargets.length };
      _currentStage = "yelp";
      const _yelpT0 = Date.now();
      echoLog.start("yelp", { total: allTargets.length, concurrency: 8 });
      const CONCURRENCY = 8;
      let cursor = 0;
      const runWorker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= allTargets.length) return;
          const { p, cuisine } = allTargets[i];
          try {
            const info = await fetchYelpInfo(p.name, p.address, data.city, isEn, cuisine);
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
      echoLog.ok("yelp", Date.now() - _yelpT0, {
        hit: yelpById.size,
        total: allTargets.length,
        miss: allTargets.length - yelpById.size,
      });
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
    const nonHardFilters = [
      ...data.softPreferences.map((item) => ({ kind: "preference", text: item.text })),
      ...data.negativeFilters.map((item) => ({ kind: "avoidance", text: item.text })),
      ...data.dishPreferences
        .filter((dish) => !data.hardFilters.some((filter) => filter.text.includes(dish)))
        .map((text) => ({ kind: "dish", text })),
    ];

    const langDirective = isEn
      ? `\n## OUTPUT LANGUAGE (MANDATORY, ZERO TOLERANCE)\nALL human-readable string fields you produce — aiSummary, pros, cons, matchDetails[].label, hardFilterChecks[].note — MUST be written in **English only**. **No CJK characters are allowed in any of those fields**, not even as quoted source snippets. If the source review is in Chinese, paraphrase it into concise English and DROP the original Chinese — do NOT include the Chinese phrase in quotes followed by a translation.\n\nBad (forbidden):\n  - "Reviews mention '氛围复古有特色' (retro and unique atmosphere)"\n  - "高峰期可能要等位 (may have to wait during peak hours)"\nGood:\n  - "Diners praise the retro, characterful atmosphere"\n  - "May involve a wait during peak hours"\n\nRule of thumb: if any character matches /[\\u4e00-\\u9fff]/ in those fields, the output is invalid — rewrite it in pure English. Keep \`placeId\` and any enum/status values exactly as specified.\n`
      : `\n## 输出语言（强制，零容忍）\n你产出的**所有人类可读字符串字段** — aiSummary、pros、cons、matchDetails[].label、hardFilterChecks[].note — **必须用简体中文撰写**。**这些字段里禁止整句堆砌英文/日文/拉丁字符**，即使候选数据里的评论是英文或日文，也必须**转写为简体中文**，不要原文照搬，也不要"原文 + 括号翻译"的写法。\n\n禁止（错误示例）：\n  - "Reviews emphasize the deliciousness and 'obsession with meat' by the chef"\n  - "The address in Chuo Ward, Sapporo, is a central location."\n  - "肉への こだわり (chef's obsession with meat) is highly praised"\n正确：\n  - "评论强调食材新鲜，盛赞主厨对肉品质的执着"\n  - "地址位于札幌中央区，属于市中心区域"\n  - "多条评论提到主厨对肉品质的执着"\n\n判定铁律：matchDetails[].label 与 hardFilterChecks[].note 任意一条若整句不含任何 CJK 汉字（即整段都是拉丁字母/英文单词），即视为违规输出，必须重写为简体中文。专有名词（店名、地铁站名、人名）可保留原文，但句子主体必须是中文。\\\`placeId\\\` 和 enum/status 值按规范原样保留。\n`;


    type GroupForPrompt = (typeof candidatesForPrompt)[number];

    // ===== Pass 1：核验（不出 matchScore，也不出文案）=====
    const buildVerifyPromptForGroup = (group: GroupForPrompt) => {
      const exp = cuisineExpansions.get(group.cuisine);
      const syn = exp && exp.synonyms.length ? exp.synonyms.join("、") : "（无）";
      const neg = exp && exp.negativeKeywords.length ? exp.negativeKeywords.join("、") : "（无）";
      const fidelity = exp
        ? `- 「${group.cuisine}」：本地化主词 = "${exp.primary}"；同义词 = ${syn}；反例（明显不是该料理）= ${neg}`
        : `- 「${group.cuisine}」：（无额外扩展）`;

      return `# 角色

你是 Echo Eats 的**餐厅核验分析师**。你的任务是把一批 Google Places 候选餐厅，按用户的硬条件 / 软偏好 / 避雷 / 菜品偏好逐家做"匹配核验"。
你**不是**导购文案写手，**也不打分** —— 这一步只产核验结论；matchScore 由下一步专门处理，**绝对不要**在本步输出里写 matchScore / score / rating 等字段。
${langDirective}

---

# 上下文
- 城市：${data.city}
- 日期/时间：${data.dateTime}
- 料理：${group.cuisine}
- 硬条件（带 weight 0–1）：${hardFiltersJson}
- 软偏好（带 weight）：${softJson === "[]" ? "无" : softJson}
- 避雷（带 weight）：${negJson === "[]" ? "无" : negJson}
- 菜品偏好：${data.dishPreferences.join("、") || "无"}

## 料理保真信息
${fidelity}

## 候选数据（JSON，本批共 ${group.candidates.length} 家）
${JSON.stringify(group.candidates, null, 2)}

---

# 规则约束

## 必须做（DO）
1. **逐家独立核验**：本批 ${group.candidates.length} 家，一家一家独立判定，**绝不在候选之间做横向比较**。
2. **核验所有候选**：必须对列表中的**每一家**给出 picks 条目，一家都不能漏。
3. **\`hardFilterChecks\` 长度必须严格等于 ${hardFiltersList.length}**，顺序与硬条件数组一致。
4. **\`matchDetails\` 长度必须严格等于 ${nonHardFilters.length}**，顺序为：${JSON.stringify(nonHardFilters)}。
5. **每条判定都给 confidence（0–100 整数）**：
   - 85–100：证据非常明确、直接、充分
   - 70–84：证据合理，可以下结论
   - 40–69：证据模糊、间接、需要推断 —— **务必落在此区间，不要硬给 ok**
   - 0–39：基本是猜测或资料严重不足
6. **Google 评分是确定性事实**：遇到 Google 评分阈值条件，直接拿候选的 rating/googleRating 做数值比较；有数值时不允许 unknown，也不要用评论文本推断评分。
7. **料理保真**：检查 name / primaryType / editorialSummary / realWorldReviews。命中反例关键词且未命中主词/同义词 → 该硬条件判 fail。

## 禁止做（DON'T）
1. **禁止横向比较**：任何字段里都不允许出现"相比之下""比同批其他店""在本批中""更胜一筹"等措辞。
2. **禁止跨条引用**：每家店的判定只能引用**它自己**的 candidate 数据，禁止引用同批其他店的评论 / 地址 / 菜单。
3. **禁止幻觉**：realWorldReviews 为空时严禁编造评价；没有数据就标 unknown。
4. **禁止同义重复**：\`hardFilterChecks\` 已覆盖的主题，\`matchDetails\` 不得换种说法再写一遍。
5. **禁止输出文案 / 打分字段**：不要写 aiSummary、不要写 pros/cons、**不要写 matchScore / score / rating** —— 这一步只做核验。
6. **禁止泄露内部字段名**：note 和 label 里不要出现 "primaryType" / "editorialSummary" / "realWorldReviews" 等字段名。
7. **note / label 控制在 20–40 字**，简短结论 + 简短依据即可。

## confidence 自检铁律
如果你写了 status="ok" 但证据其实只是"评论赞美整体但没具体提到该条件"，confidence 必须 < 70 —— 系统会自动把它降为 unknown。**诚实评估，不要全部给 90+**。

---

# 输出约束

**输出且只输出一个 JSON 对象**，第一个字符是 \`{\`、最后一个字符是 \`}\`，**不要任何前置说明、markdown 包裹**。

Schema：
{
  "picks": [
    {
      "placeId": "<候选的 placeId，原样回写>",
      "verificationStatus": "ok" | "unknown" | "fail",
      "hardFilterChecks": [
        { "filter": "<硬条件原文>", "status": "ok"|"unknown"|"fail", "note": "<20–40 字>", "confidence": <0–100> }
      ],
      "matchDetails": [
        { "label": "<20–40 字结论+依据>", "status": "ok"|"unknown"|"fail", "confidence": <0–100> }
      ]
    }
  ]
}

## verificationStatus 判定法
- 任一 \`weight ≥ 0.85\` 的硬条件 status=fail → \`fail\`
- 否则任一硬条件 status=unknown → \`unknown\`
- 否则 → \`ok\`

## 最终自检清单（输出前必做）
1. \`picks.length === ${group.candidates.length}\`
2. 每个 pick 都包含这 4 个字段：\`placeId\` / \`verificationStatus\` / \`hardFilterChecks\` / \`matchDetails\`
3. **没有任何 pick 写了 matchScore 字段**（打分是下一步的事）

---

# Few-shots

## 示例 A — 强匹配
{
  "picks": [{
    "placeId": "ChIJxxx",
    "verificationStatus": "ok",
    "hardFilterChecks": [
      { "filter": "Google 评分 ≥ 4.3", "status": "ok", "note": "Google 评分 4.6，远超阈值", "confidence": 100 }
    ],
    "matchDetails": [
      { "label": "氛围安静：多条评论提到环境清幽适合谈话", "status": "ok", "confidence": 78 }
    ]
  }]
}

## 示例 B — 证据弱
{
  "picks": [{
    "placeId": "ChIJyyy",
    "verificationStatus": "unknown",
    "hardFilterChecks": [
      { "filter": "Google 评分 ≥ 4.3", "status": "ok", "note": "Google 评分 4.4", "confidence": 100 }
    ],
    "matchDetails": [
      { "label": "适合约会：评论整体好评但未具体提及约会场景，资料不足", "status": "unknown", "confidence": 55 }
    ]
  }]
}

## 示例 C — 料理保真 fail
{
  "picks": [{
    "placeId": "ChIJzzz",
    "verificationStatus": "fail",
    "hardFilterChecks": [
      { "filter": "拉面（料理类型）", "status": "fail", "note": "主营意大利菜，非拉面店", "confidence": 95 }
    ],
    "matchDetails": []
  }]
}
`;
    };

    // ===== Pass 2：仅打分 =====
    type ScoreCandidateBrief = {
      placeId: string;
      name: string;
      rating: number | null;
      userRatingCount: number | null;
      verificationStatus: "ok" | "unknown" | "fail" | undefined;
      hardFilterChecks: z.infer<typeof HardFilterCheckSchema>[];
      matchDetails: z.infer<typeof MatchDetailSchema>[];
    };
    type ScoreGroupInput = { cuisine: string; candidates: ScoreCandidateBrief[] };

    const buildScorePromptForGroup = (group: ScoreGroupInput) => {
      return `# 角色

你是 Echo Eats 的**评分器**。你的**唯一任务**是为每家餐厅输出一个 0–100 的 matchScore 整数，**别的什么都不要做**。

---

# 上下文
- 料理：${group.cuisine}
- 硬条件（带 weight）：${hardFiltersJson}
- 软偏好（带 weight）：${softJson === "[]" ? "无" : softJson}
- 避雷（带 weight）：${negJson === "[]" ? "无" : negJson}
- 菜品偏好：${data.dishPreferences.join("、") || "无"}

## 候选 + 上一步核验结果（共 ${group.candidates.length} 家）
${JSON.stringify(group.candidates, null, 2)}

每家字段：placeId / name / rating / userRatingCount / verificationStatus / hardFilterChecks / matchDetails

---

# 评分规则（绝对刻度，逐家独立打分，不做横向比较）
- 90–100：硬条件全 ok、软偏好多数命中、口碑顶级
- 75–89：硬条件全 ok、软偏好部分命中
- 60–74：硬条件全 ok、软偏好证据不足
- 50–69：硬条件有 unknown / 整体资料偏弱
- 40–55：硬条件有 fail（非 blocking）或多条 unknown
- 0–39：blocking fail（weight ≥ 0.85 且 status=fail）或 verificationStatus=fail

# 🔴 输出铁律（违反即整批作废）
1. \`scores\` 数组长度**必须等于 ${group.candidates.length}**，一家都不能漏。
2. 每个元素只有**两个字段**：\`placeId\`（原样回写）和 \`matchScore\`（**JSON number，0–100 整数**）。
3. **严禁**以下任何写法：
   - ❌ 漏写 matchScore 字段
   - ❌ \`"matchScore": null\` / \`"matchScore": "88"\` / \`"matchScore": "unknown"\` / \`"matchScore": "N/A"\`
   - ❌ 添加任何其它字段（verificationStatus / note / reason / confidence 都不要写）
4. **不确定也必须给数字**：资料不足就按"硬条件全 ok 软偏好弱"给 60–74，绝对不要省略字段。
5. 输出且只输出一个 JSON 对象，第一个字符 \`{\`、最后一个字符 \`}\`，**不要 markdown，不要解释，不要前后说明**。

# 输出 Schema
{
  "scores": [
    { "placeId": "<原样回写>", "matchScore": <0–100 整数> }
  ]
}

# 最终自检（提交前必做）
1. scores.length === ${group.candidates.length}
2. 每个元素只有 placeId 和 matchScore 两个 key
3. 每个 matchScore 都是 JSON number（不是字符串、不是 null、不是 undefined）
4. 如有漏，立即补一个保守估算分再输出
`;
    };



    const extractJson = (text: string): string => {
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenced) return fenced[1].trim();
      const m = text.match(/\{[\s\S]*\}/);
      return m ? m[0] : text;
    };

    // 把 Pass1 的精简 pick 扩展成下游打分代码期望的 AiPickSchema 形状。
    // matchScore 在此阶段固定为 0（占位），由 Pass2 回填；Pass2 失败/缺失则在 batch 层兜底为 60。
    const expandToFullPick = (
      picks: z.infer<typeof AiVerifyGroupSchema>["picks"],
    ): z.infer<typeof AiPickSchema>[] =>
      picks.map((p) => ({
        placeId: p.placeId,
        matchScore: 0,
        matchTier: tierFromScore(0),
        aiSummary: "",
        pros: [],
        cons: [],
        matchDetails: p.matchDetails,
        hardFilterChecks: p.hardFilterChecks,
      }));

    type VerifyOutcome =
      | { ok: true; cuisine: string; picks: z.infer<typeof AiPickSchema>[] }
      | { ok: false; cuisine: string; reason: string };

    const rankVerifyGroup = async (
      group: GroupForPrompt,
    ): Promise<VerifyOutcome> => {
      const prompt = buildVerifyPromptForGroup(group);
      const startedAt = Date.now();
      const tag = `${group.cuisine}#n=${group.candidates.length}`;
      console.log(`[Echo/AI-verify] batch=${tag} start`);
      echoLog.start("AI-verify", { cuisine: group.cuisine, candidates: group.candidates.length });

      const RAW_JSON_SUFFIX = `\n\n再次强调：你的回复必须是**纯 JSON**，不要 markdown 代码块、不要前后说明文字、不要 \`\`\`json 包裹。直接以 { 开头、以 } 结尾。`;
      const STRICT_JSON_SUFFIX = `\n\n上一次回复无法被解析为合法 JSON。请严格输出**纯 JSON**，首字符必须是 \`{\`，末字符必须是 \`}\`，中间不得有任何 markdown、注释或解释文字。`;

      const runRaw = async (promptSuffix: string) => {
        const fb = await generateText({
          model,
          prompt: prompt + promptSuffix,
          maxOutputTokens: 10000,
        });
        const finishReason = (fb as { finishReason?: string }).finishReason;
        if (finishReason === "length" || finishReason === "max-tokens") {
          throw new Error(`truncated (finishReason=${finishReason})`);
        }
        return AiVerifyGroupSchema.parse(JSON.parse(extractJson(fb.text || "")));
      };

      try {
        const parsed = await runRaw(RAW_JSON_SUFFIX);
        console.log(
          `[Echo/AI-verify] batch=${tag} ok in ${Date.now() - startedAt}ms picks=${parsed.picks.length}`,
        );
        return { ok: true, cuisine: group.cuisine, picks: expandToFullPick(parsed.picks) };
      } catch (e1) {
        const m1 = e1 instanceof Error ? e1.message : String(e1);
        console.warn(
          `[Echo/AI-verify] batch=${tag} raw parse failed (${m1}), retrying once…`,
        );
        try {
          const parsed = await runRaw(STRICT_JSON_SUFFIX);
          console.log(
            `[Echo/AI-verify] batch=${tag} ok (retry) in ${Date.now() - startedAt}ms picks=${parsed.picks.length}`,
          );
          return { ok: true, cuisine: group.cuisine, picks: expandToFullPick(parsed.picks) };
        } catch (e2) {
          const m2 = e2 instanceof Error ? e2.message : String(e2);
          console.error(
            `[Echo/AI-verify] batch=${tag} FAILED in ${Date.now() - startedAt}ms reason=${m2}`,
          );
          return { ok: false, cuisine: group.cuisine, reason: m2 };
        }
      }
    };

    // ===== Pass 2：仅打分。失败 / partial 兜底为 60 =====
    type ScoreOutcome = {
      cuisine: string;
      scores: Map<string, number>;
      fallbackIds: Set<string>;
      status: "ok" | "partial" | "failed";
      reason?: string;
    };

    const rankScoreGroup = async (group: ScoreGroupInput): Promise<ScoreOutcome> => {
      const tag = `${group.cuisine}#n=${group.candidates.length}`;
      const startedAt = Date.now();
      const expectedIds = group.candidates.map((c) => c.placeId);
      const fallbackAll = (reason: string): ScoreOutcome => {
        const scores = new Map<string, number>();
        const fallbackIds = new Set<string>();
        for (const id of expectedIds) {
          scores.set(id, 60);
          fallbackIds.add(id);
        }
        return { cuisine: group.cuisine, scores, fallbackIds, status: "failed", reason };
      };

      if (!group.candidates.length) {
        return { cuisine: group.cuisine, scores: new Map(), fallbackIds: new Set(), status: "ok" };
      }

      console.log(`[Echo/AI-score]  batch=${tag} start`);
      echoLog.start("AI-score", { cuisine: group.cuisine, candidates: group.candidates.length });
      const prompt = buildScorePromptForGroup(group);

      const finalize = (
        parsedScores: { placeId: string; matchScore: number }[],
        modeLabel: string,
      ): ScoreOutcome => {
        const scoreMap = new Map<string, number>();
        for (const s of parsedScores) {
          if (typeof s.matchScore === "number" && !Number.isNaN(s.matchScore)) {
            scoreMap.set(s.placeId, Math.max(0, Math.min(100, Math.round(s.matchScore))));
          }
        }
        const fallbackIds = new Set<string>();
        for (const id of expectedIds) {
          if (!scoreMap.has(id)) {
            scoreMap.set(id, 60);
            fallbackIds.add(id);
          }
        }
        const status: "ok" | "partial" = fallbackIds.size === 0 ? "ok" : "partial";
        if (status === "ok") {
          console.log(
            `[Echo/AI-score]  batch=${tag} ok (${modeLabel}) in ${Date.now() - startedAt}ms scored=${scoreMap.size}`,
          );
        } else {
          console.warn(
            `[Echo/AI-score]  batch=${tag} PARTIAL (${modeLabel}) in ${Date.now() - startedAt}ms scored=${scoreMap.size - fallbackIds.size}/${expectedIds.length} fallback60=${fallbackIds.size} missing=${JSON.stringify([...fallbackIds])}`,
          );
        }
        return { cuisine: group.cuisine, scores: scoreMap, fallbackIds, status };
      };

      try {
        const result = await generateText({
          model,
          prompt,
          maxOutputTokens: 2000,
          output: Output.object({
            schema: AiScoreGroupSchema,
            name: "echo_eats_score",
            description: `Score candidates for cuisine "${group.cuisine}"`,
          }),
        });
        return finalize(result.output.scores, "Output.object");
      } catch (e1) {
        const m1 = e1 instanceof Error ? e1.message : String(e1);
        console.warn(
          `[Echo/AI-score]  batch=${tag} Output.object failed (${m1}), retrying raw…`,
        );
        try {
          const fb = await generateText({
            model,
            prompt:
              prompt +
              `\n\n再次强调：纯 JSON 输出，{ 开头 } 结尾，不要 markdown、不要解释。`,
            maxOutputTokens: 3000,
          });
          const parsed = AiScoreGroupSchema.parse(JSON.parse(extractJson(fb.text || "")));
          return finalize(parsed.scores, "raw-fallback");
        } catch (e2) {
          const m2 = e2 instanceof Error ? e2.message : String(e2);
          console.error(
            `[Echo/AI-score]  batch=${tag} FAILED in ${Date.now() - startedAt}ms reason=${m2} → fallback60 all`,
          );
          return fallbackAll(m2);
        }
      }
    };



    // ===== Pass 2：文案（aiSummary + pros + cons），仅对每 cuisine 的 top5 跑 =====
    type CopyPickInput = {
      placeId: string;
      name: string;
      address: string;
      googleReviews: string[];
      tabelogSummary: string | null;
      yelpSummary: string | null;
    };
    type CopyGroupInput = { cuisine: string; picks: CopyPickInput[] };

    const buildCopyPromptForGroup = (group: CopyGroupInput) => {
      return `# 角色

你是 Echo Eats 的**评论摘录文案编辑**。你的任务是基于真实平台评论，给每家餐厅写一段 ≤80 字的总结（aiSummary），并摘录食客口碑中的优点（pros）和槽点（cons）。
你**不知道**用户的硬条件 / 软偏好 / 避雷 / 菜品偏好是什么 —— 这是有意的，请只描述这家店本身的口碑特征。
${langDirective}

---

# 上下文
- 料理：${group.cuisine}
- 本批候选（仅评论与基本信息，本批共 ${group.picks.length} 家）：
${JSON.stringify(group.picks, null, 2)}

每家店字段：placeId / name / address / googleReviews（≤3 条） / tabelogSummary / yelpSummary（可能为空）

---

# 规则约束

## 必须做（DO）
1. **逐家独立撰写**：一家一家独立写，每家店的文案**只引用它自己的**评论字段。
2. **数据源限定**：pros/cons 的每一条**必须**来自 googleReviews / tabelogSummary / yelpSummary 的真实评论文本。
3. **来源标注**：每条 pros/cons 的 \`source\` 字段填平台名（Google / Tabelog / Yelp）。
4. **aiSummary ≤ 80 字**：客观描述这家店的特色、菜品强项、氛围、价位段。
5. **宁缺毋滥**：评论里找不到足够支撑（同一主题 < 2 条评论提及）→ pros 或 cons 直接返回 \`[]\`，不要硬凑。

## 禁止做（DON'T）
1. **禁止横向比较**：任何字段不允许出现"相比之下""比其他选择更好""在本批中"等措辞。
2. **禁止跨店引用**：A 店文案里禁止出现 B 店的店名、菜品、评论。
3. **禁止回扣用户需求**：本批数据**没有**用户的任何条件信息；禁止写"符合您的 XX 需求""满足您要求的""您想要的 XX"等任何指向用户输入的措辞 —— 你根本不知道用户想要什么。
4. **禁止用非评论字段拼凑 pros/cons**：地址、营业时间、Google 评分数值、primaryType、editorialSummary 都**不是**评论，不得作为 pros/cons 的依据。
5. **禁止幻觉**：没有评论支撑就不要写；不要把笼统好评（"很棒""推荐"）当作具体优点。
6. **pros 与 cons 不要写同一件事**：避免一边夸"分量大"一边吐槽"分量大"。
7. **每条 pros/cons 文本 ≤ 30 字**，pros / cons 各最多 3 条。

---

# 输出约束

**输出且只输出一个 JSON 对象**，第一个字符是 \`{\`、最后一个字符是 \`}\`，**不要任何前置说明、markdown 包裹**。

Schema：
{
  "picks": [
    {
      "placeId": "<原样回写>",
      "aiSummary": "<≤80 字客观描述>",
      "pros": [{ "text": "<≤30 字优点>", "source": "Google" | "Tabelog" | "Yelp" }],
      "cons": [{ "text": "<≤30 字槽点>", "source": "Google" | "Tabelog" | "Yelp" }]
    }
  ]
}

每家店都要出现在 picks 里，即使 pros / cons 都是空数组也要给出 placeId 和 aiSummary。

---

# Few-shots

## 示例 A — 评论充分
{
  "picks": [{
    "placeId": "ChIJaaa",
    "aiSummary": "新宿小巷里的家庭式串烧店，主打炭火鸡肉串，人均预算亲民，氛围热闹随性。",
    "pros": [
      { "text": "炭火鸡腿串香气足，鸡皮焦脆", "source": "Google" },
      { "text": "套餐定价实惠，性价比高", "source": "Tabelog" }
    ],
    "cons": [
      { "text": "店内空间小、用餐时段较吵", "source": "Google" }
    ]
  }]
}

## 示例 B — 评论稀薄，宁缺毋滥
{
  "picks": [{
    "placeId": "ChIJbbb",
    "aiSummary": "中目黑站附近的小型怀石料理店，主打时令食材，环境安静。",
    "pros": [],
    "cons": []
  }]
}

## 示例 C — 禁止违规对照
错误（含横向比较 + 回扣用户）：
{ "aiSummary": "相比本批其他店更适合您想要的安静约会环境" }
正确：
{ "aiSummary": "位于代官山小巷的法餐小馆，主打当季食材套餐，店内座位有限、灯光偏暗。" }
`;
    };

    const rankCopyGroup = async (
      group: CopyGroupInput,
    ): Promise<{ cuisine: string; picks: z.infer<typeof AiCopyPickSchema>[] }> => {
      if (!group.picks.length) return { cuisine: group.cuisine, picks: [] };
      const prompt = buildCopyPromptForGroup(group);
      const startedAt = Date.now();
      const tag = `${group.cuisine}#n=${group.picks.length}`;
      console.log(`[Echo/AI-copy]   batch=${tag} start`);
      echoLog.start("AI-copy", { cuisine: group.cuisine, picks: group.picks.length });
      const finalize = (
        picks: z.infer<typeof AiCopyPickSchema>[],
        modeLabel: string,
      ) => {
        const got = new Set(picks.map((p) => p.placeId));
        const missing = group.picks.filter((p) => !got.has(p.placeId)).map((p) => p.placeId);
        if (missing.length === 0) {
          console.log(
            `[Echo/AI-copy]   batch=${tag} ok (${modeLabel}) in ${Date.now() - startedAt}ms picks=${picks.length}`,
          );
        } else {
          console.warn(
            `[Echo/AI-copy]   batch=${tag} PARTIAL (${modeLabel}) in ${Date.now() - startedAt}ms picks=${picks.length}/${group.picks.length} missing=${JSON.stringify(missing)}`,
          );
        }
        return { cuisine: group.cuisine, picks };
      };
      try {
        const result = await generateText({
          model,
          prompt,
          maxOutputTokens: 4000,
          output: Output.object({
            schema: AiCopyGroupSchema,
            name: "echo_eats_copy",
            description: `Write aiSummary + pros + cons for cuisine "${group.cuisine}"`,
          }),
        });
        return finalize(result.output.picks, "Output.object");
      } catch (e1) {
        const m1 = e1 instanceof Error ? e1.message : String(e1);
        console.warn(
          `[Echo/AI-copy]   batch=${tag} Output.object failed (${m1}), retrying raw…`,
        );
        try {
          const fb = await generateText({
            model,
            prompt: prompt + `\n\n再次强调：直接以 { 开头、以 } 结尾，不要 markdown。`,
            maxOutputTokens: 6000,
          });
          const parsed = AiCopyGroupSchema.parse(JSON.parse(extractJson(fb.text || "")));
          return finalize(parsed.picks, "raw-fallback");
        } catch (e2) {
          const m2 = e2 instanceof Error ? e2.message : String(e2);
          console.error(
            `[Echo/AI-copy]   batch=${tag} FAILED in ${Date.now() - startedAt}ms reason=${m2}`,
          );
          return { cuisine: group.cuisine, picks: [] };
        }
      }
    };


    yield { type: "stage", stage: "rank" };
    _currentStage = "AI-rank";
    const rankStartedAt = Date.now();
    echoLog.start("AI-rank", {
      batches: candidatesForPrompt.length,
      totalCandidates: candidatesForPrompt.reduce((s, g) => s + g.candidates.length, 0),
    });
    // 用心跳包裹整个并行排序，避免边缘网关因为长时间静默切流。
    // 每个 cuisine 内：先把候选按 BATCH_SIZE 切片 → Pass1 核验 → Pass2 仅打分，最终把 matchScore 回填到 picks。
    type BatchAggregate = {
      cuisine: string;
      picks: z.infer<typeof AiPickSchema>[];
      verifyOk: number;
      verifyFail: number;
      scoreOk: number;
      scorePartial: number;
      scoreFailed: number;
      fallback60: number;
    };
    const groupResults: BatchAggregate[] = yield* withHeartbeat(
      Promise.all(candidatesForPrompt.map(async (group): Promise<BatchAggregate> => {
        const BATCH_SIZE = 12;
        const batches: typeof group.candidates[] = [];
        for (let i = 0; i < group.candidates.length; i += BATCH_SIZE) {
          batches.push(group.candidates.slice(i, i + BATCH_SIZE));
        }
        const placeByIdInGroup = new Map(group.candidates.map((c) => [c.placeId, c]));

        const agg: BatchAggregate = {
          cuisine: group.cuisine,
          picks: [],
          verifyOk: 0,
          verifyFail: 0,
          scoreOk: 0,
          scorePartial: 0,
          scoreFailed: 0,
          fallback60: 0,
        };

        const batchPicks = await Promise.all(batches.map(async (batch) => {
          // Pass1: 核验
          const verify = await rankVerifyGroup({ ...group, candidates: batch });
          if (!verify.ok) {
            agg.verifyFail++;
            return [];
          }
          agg.verifyOk++;

          if (!verify.picks.length) return [];

          // Pass2: 仅打分。基于 Pass1 的核验结果 + 候选基本字段
          const scoreInput: ScoreGroupInput = {
            cuisine: group.cuisine,
            candidates: verify.picks.map((p) => {
              const base = placeByIdInGroup.get(p.placeId) as
                | { name?: string; rating?: number | null; userRatingCount?: number | null }
                | undefined;
              return {
                placeId: p.placeId,
                name: base?.name ?? "",
                rating: base?.rating ?? null,
                userRatingCount: base?.userRatingCount ?? null,
                verificationStatus: undefined,
                hardFilterChecks: p.hardFilterChecks,
                matchDetails: p.matchDetails,
              };
            }),
          };
          const score = await rankScoreGroup(scoreInput);
          if (score.status === "ok") agg.scoreOk++;
          else if (score.status === "partial") agg.scorePartial++;
          else agg.scoreFailed++;
          agg.fallback60 += score.fallbackIds.size;

          // 回填 matchScore + matchTier
          for (const p of verify.picks) {
            const s = score.scores.get(p.placeId) ?? 60;
            p.matchScore = s;
            p.matchTier = tierFromScore(s);
          }
          return verify.picks;
        }));

        agg.picks = batchPicks.flat();
        return agg;
      })),
      "rank",
    );
    const _rankPicksTotal = groupResults.reduce((s, g) => s + g.picks.length, 0);
    const _rankFailedGroups = groupResults.filter((g) => g.picks.length === 0).length;
    const _verifyOk = groupResults.reduce((s, g) => s + g.verifyOk, 0);
    const _verifyFail = groupResults.reduce((s, g) => s + g.verifyFail, 0);
    const _scoreOk = groupResults.reduce((s, g) => s + g.scoreOk, 0);
    const _scorePartial = groupResults.reduce((s, g) => s + g.scorePartial, 0);
    const _scoreFailed = groupResults.reduce((s, g) => s + g.scoreFailed, 0);
    const _fallback60 = groupResults.reduce((s, g) => s + g.fallback60, 0);
    console.log(
      `[Echo/AI-rank] all ${groupResults.length} group(s) done in ${Date.now() - rankStartedAt}ms verify(ok/fail)=${_verifyOk}/${_verifyFail} score(ok/partial/fail)=${_scoreOk}/${_scorePartial}/${_scoreFailed} fallback60=${_fallback60}`,
    );
    echoLog.ok("AI-rank", Date.now() - rankStartedAt, {
      groups: groupResults.length,
      picksTotal: _rankPicksTotal,
      failedGroups: _rankFailedGroups,
      verifyOk: _verifyOk,
      verifyFail: _verifyFail,
      scoreOk: _scoreOk,
      scorePartial: _scorePartial,
      scoreFailed: _scoreFailed,
      fallback60: _fallback60,
    });
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

    // 3. 三层综合打分：Layer1 准入 + Layer2 贝叶斯基础(满分40) + Layer3 匹配(满分60)
    const placeByRestaurantId = new Map<string, PlaceCandidate>();
    const BAYES_C = 20;
    const BAYES_GLOBAL_MEAN = 3.8;
    const softCount = data.softPreferences.length;
    const negCount = data.negativeFilters.length;
    const dishCount = nonHardFilters.length - softCount - negCount;

    _currentStage = "score";
    const _scoreT0 = Date.now();
    const groups = data.cuisines.map((cuisine) => {
      const pool = placeResults.find((r) => r.cuisine === cuisine)?.places ?? [];
      const aiGroup = ranking.groups.find((g) => g.cuisine.toLowerCase() === cuisine.toLowerCase());
      const pickById = new Map((aiGroup?.picks ?? []).map((pick) => [pick.placeId, pick]));
      type Built = {
        restaurant: z.infer<typeof RestaurantSchema>;
        finalScore: number;
        admitted: boolean;
      };
      const builtList: Built[] = [];

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
              : aiCheck
                ? {
                    ...aiCheck,
                    status: (aiCheck.confidence ?? 50) >= 70 ? aiCheck.status : ("unknown" as const),
                  }
                : {
                    filter: filter.text,
                    status: "unknown" as const,
                    note: isEn ? "Verification incomplete" : "核验未完成",
                  },
          };
        });
        const hasBlockingFail = checks.some(
          ({ filter, check }) => check.status === "fail" && filter.weight >= 0.85,
        );
        const hasUnknown = checks.some(({ check }) => check.status === "unknown");
        const verificationStatus = hasBlockingFail ? "fail" : hasUnknown ? "unknown" : "ok";

        const hardDetails = checks.map(({ filter, check }) => {
          const condition = conciseCondition(filter.text);
          const evidence = conciseEvidence(check.note, condition, isEn);
          return { label: `${condition}：${evidence}`, status: check.status };
        });
        const aiDetails = pick?.matchDetails ?? [];
        const nonHardDetails = nonHardFilters.map((condition, conditionIndex) => {
          const detail = aiDetails[conditionIndex];
          const conditionLabel = conciseCondition(condition.text);
          const evidence = conciseEvidence(detail?.label, conditionLabel, isEn);
          const status = detail
            ? ((detail.confidence ?? 50) >= 70 ? detail.status : ("unknown" as const))
            : ("unknown" as const);
          return { label: `${conditionLabel}：${evidence}`, status };
        });
        const matchDetails = [...hardDetails, ...nonHardDetails];


        // ============ 三层打分 ============
        const recallSources = recallSourcesById.get(p.placeId) ?? [];
        const breakdown: { label: string; delta: number }[] = [];

        // Layer 1 准入层
        const negStatuses = nonHardDetails.slice(softCount, softCount + negCount).map((d) => d.status);
        const negFailHeavy = data.negativeFilters.some(
          (n, i) => n.weight >= 0.85 && negStatuses[i] === "fail",
        );
        const reviewCount = p.userRatingCount ?? 0;
        const adjRating = p.rating != null
          ? (p.rating * reviewCount + BAYES_GLOBAL_MEAN * BAYES_C) / (reviewCount + BAYES_C)
          : BAYES_GLOBAL_MEAN;
        const failsBayesRating = p.rating != null && reviewCount >= 50 && adjRating < 3.5;
        const closedPermanent = p.businessStatus != null && p.businessStatus !== "OPERATIONAL";
        const admitted = !hasBlockingFail && !negFailHeavy && !failsBayesRating && !closedPermanent;

        // Layer 2 基础分 (贝叶斯, 0..20)
        const baseScore = Math.max(0, Math.min(20, adjRating * 4));
        breakdown.push({
          label: isEn
            ? `Bayesian rating ${adjRating.toFixed(2)} × 4`
            : `贝叶斯评分 ${adjRating.toFixed(2)} × 4`,
          delta: Math.round(baseScore),
        });

        // Layer 3 匹配分 (0..80)
        let matchScore = 0;
        const aiBase = (pick?.matchScore ?? 0) * 0.47;
        matchScore += aiBase;
        if (aiBase > 0) {
          breakdown.push({
            label: isEn ? `AI match ${pick?.matchScore ?? 0} × 0.47` : `AI 匹配 ${pick?.matchScore ?? 0} × 0.47`,
            delta: Math.round(aiBase),
          });
        }
        let hardDeduct = 0;
        for (const { filter, check } of checks) {
          if (check.status === "fail") hardDeduct += filter.weight * 10.7;
          else if (check.status === "unknown") hardDeduct += filter.weight * 2.7;
        }
        if (hardDeduct > 0) {
          matchScore -= hardDeduct;
          breakdown.push({
            label: isEn ? "Hard filter penalties" : "硬条件扣分",
            delta: -Math.round(hardDeduct),
          });
        }
        // Soft bonuses/penalties (cap +20 for ok)
        let softBonus = 0, softPenalty = 0;
        for (let i = 0; i < softCount; i++) {
          const w = data.softPreferences[i].weight;
          const st = nonHardDetails[i].status;
          if (st === "ok") softBonus += w * 6.7;
          else if (st === "fail") softPenalty += w * 4;
        }
        softBonus = Math.min(softBonus, 20);
        if (softBonus > 0) {
          matchScore += softBonus;
          breakdown.push({ label: isEn ? "Soft preference hits" : "软偏好命中", delta: Math.round(softBonus) });
        }
        if (softPenalty > 0) {
          matchScore -= softPenalty;
          breakdown.push({ label: isEn ? "Soft preference fails" : "软偏好未中", delta: -Math.round(softPenalty) });
        }
        // Negative fails
        let negPenalty = 0;
        for (let i = 0; i < negCount; i++) {
          if (negStatuses[i] === "fail") negPenalty += data.negativeFilters[i].weight * 13.3;
        }
        if (negPenalty > 0) {
          matchScore -= negPenalty;
          breakdown.push({ label: isEn ? "Avoidance hits" : "命中避雷", delta: -Math.round(negPenalty) });
        }
        // Dish hits (cap +16)
        let dishBonus = 0;
        for (let i = 0; i < dishCount; i++) {
          if (nonHardDetails[softCount + negCount + i].status === "ok") dishBonus += 5.3;
        }
        dishBonus = Math.min(dishBonus, 16);
        if (dishBonus > 0) {
          matchScore += dishBonus;
          breakdown.push({ label: isEn ? "Dish matches" : "菜品命中", delta: Math.round(dishBonus) });
        }
        // Recall bonus non-linear
        const recallTable = [0, 0, 4, 8, 13];
        const recallBonus = recallTable[Math.min(recallSources.length, 4)];
        if (recallBonus > 0) {
          matchScore += recallBonus;
          breakdown.push({
            label: isEn ? `Multi-route recall (${recallSources.length})` : `多路召回 (${recallSources.length} 路)`,
            delta: recallBonus,
          });
        }
        matchScore = Math.max(0, Math.min(80, matchScore));


        let finalScore = Math.max(0, Math.min(100, Math.round(baseScore + matchScore)));
        if (!admitted) {
          breakdown.push({
            label: isEn ? "Admission rule (forced fail)" : "准入层一票否决",
            delta: 0,
          });
          finalScore = Math.min(finalScore, 30);
        }

        const tier: "perfect" | "high" | "partial" =
          admitted && finalScore >= 80 ? "perfect"
            : admitted && finalScore >= 65 ? "high"
              : "partial";

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
          matchScore: finalScore,
          matchTier: tier,
          openNow: p.openNow ?? true,
          reservable: false,
          needsReview: !admitted || verificationStatus !== "ok" || p.rating == null,
          verificationStatus,
          ratings: candidateRatings(p, review, tabelogInfo, isEn, country, yelpInfo),
          aiSummary: pick?.aiSummary?.trim() || (isEn
            ? `${p.name} was retained because its detailed conditions could not be fully verified.`
            : `${p.name} 因资料不足暂时保留，具体条件尚未完全核实。`),
          matchDetails,
          pros: pick?.pros ?? [],
          cons: pick?.cons ?? [],
          links: buildLinks(p, data.city, country, isEn, yelpInfo?.url ?? null),
          photoUrls: [],
          tabelog: tabelogInfo,
          yelp: yelpInfo,
          weekdayDescriptions: p.weekdayDescriptions ?? null,
          visitTimeMatch: visitMatchById.get(p.placeId) ?? null,
          scoreBreakdown: breakdown,
          recallSources,
        };
        placeByRestaurantId.set(restaurant.id, p);
        builtList.push({ restaurant, finalScore, admitted });
      }

      // 排序：先 admitted 后非 admitted，组内按 finalScore 降序
      builtList.sort((a, b) => {
        if (a.admitted !== b.admitted) return a.admitted ? -1 : 1;
        return b.finalScore - a.finalScore;
      });
      const top5 = builtList.slice(0, 5);
      const restaurants = top5
        .filter((b) => b.admitted && b.restaurant.verificationStatus === "ok")
        .map((b) => b.restaurant);
      const partialRestaurants = top5
        .filter((b) => b.admitted && b.restaurant.verificationStatus === "unknown")
        .map((b) => b.restaurant);
      const failedRestaurants = top5
        .filter((b) => !b.admitted || b.restaurant.verificationStatus === "fail")
        .map((b) => b.restaurant);

      const avgFinal = top5.length
        ? Math.round(top5.reduce((s, b) => s + b.finalScore, 0) / top5.length)
        : 0;
      console.log(`[score] cuisine="${cuisine}" pool=${pool.length} admitted=${builtList.filter((b) => b.admitted).length} top5-avg=${avgFinal}`);

      return {
        cuisine: cuisinesAutoFilled ? (isEn ? "Recommended for you" : "为你推荐") : cuisine,
        restaurants,
        ...(partialRestaurants.length ? { partialRestaurants } : {}),
        ...(failedRestaurants.length ? { failedRestaurants } : {}),
      };
    }).filter((group) => group.restaurants.length + (group.partialRestaurants?.length ?? 0) + (group.failedRestaurants?.length ?? 0) > 0);
    echoLog.ok("score", Date.now() - _scoreT0, {
      groups: groups.length,
      restaurants: groups.reduce((s, g) => s + g.restaurants.length, 0),
      partial: groups.reduce((s, g) => s + (g.partialRestaurants?.length ?? 0), 0),
      failed: groups.reduce((s, g) => s + (g.failedRestaurants?.length ?? 0), 0),
    });

    // ===== Pass 2：文案（aiSummary + pros + cons），仅对每 cuisine 的 top5 跑 =====
    const copyTargets: CopyGroupInput[] = groups
      .map((g) => {
        const all = [
          ...g.restaurants,
          ...(g.partialRestaurants ?? []),
          ...(g.failedRestaurants ?? []),
        ];
        return {
          cuisine: g.cuisine,
          picks: all.slice(0, 5).map((r) => {
            const place = placeByRestaurantId.get(r.id);
            const placeId = place?.placeId ?? r.id;
            const review = place ? reviewById.get(place.placeId) : null;
            return {
              placeId,
              name: r.name,
              address: r.address,
              googleReviews: (review?.reviewHighlights ?? []).slice(0, 3),
              tabelogSummary: r.tabelog?.summary ?? null,
              yelpSummary: r.yelp?.summary ?? null,
            };
          }),
        };
      })
      .filter((g) => g.picks.length > 0);

    if (copyTargets.length > 0) {
      _currentStage = "AI-copy";
      const copyStartedAt = Date.now();
      echoLog.start("AI-copy", {
        groups: copyTargets.length,
        picksTotal: copyTargets.reduce((s, g) => s + g.picks.length, 0),
      });
      // 复用 rank 心跳，避免新增前端 stage；UI 此时仍显示"AI 综合排序"。
      const copyResults = yield* withHeartbeat(
        Promise.all(copyTargets.map(rankCopyGroup)),
        "rank",
      );
      console.log(
        `[Echo/AI-copy] all ${copyResults.length} group(s) done in ${Date.now() - copyStartedAt}ms`,
      );
      const copyById = new Map<string, z.infer<typeof AiCopyPickSchema>>();
      let _picksFilled = 0;
      for (const cr of copyResults) {
        for (const pick of cr.picks) {
          copyById.set(pick.placeId, pick);
          _picksFilled++;
        }
      }
      const _picksRequested = copyTargets.reduce((s, g) => s + g.picks.length, 0);
      echoLog.ok("AI-copy", Date.now() - copyStartedAt, {
        groups: copyResults.length,
        picksRequested: _picksRequested,
        picksFilled: _picksFilled,
        picksMissed: _picksRequested - _picksFilled,
        failedGroups: copyResults.filter((r) => r.picks.length === 0).length,
      });
      for (const g of groups) {
        const allRs = [
          ...g.restaurants,
          ...(g.partialRestaurants ?? []),
          ...(g.failedRestaurants ?? []),
        ];
        for (const r of allRs) {
          const place = placeByRestaurantId.get(r.id);
          if (!place) continue;
          const copy = copyById.get(place.placeId);
          if (!copy) continue;
          if (copy.aiSummary) r.aiSummary = copy.aiSummary;
          if (copy.pros.length) r.pros = copy.pros;
          if (copy.cons.length) r.cons = copy.cons;
        }
      }
    }

    yield { type: "stage", stage: "photos" };
    _currentStage = "photos";
    const _photosT0 = Date.now();
    const allRestaurants = groups.flatMap((group) => [
      ...group.restaurants,
      ...(group.partialRestaurants ?? []),
      ...(group.failedRestaurants ?? []),
    ]);
    echoLog.start("photos", { restaurants: allRestaurants.length });
    yield* withHeartbeat(Promise.all(allRestaurants.map(async (restaurant) => {
      const place = placeByRestaurantId.get(restaurant.id);
      const urls = await Promise.all((place?.photoNames ?? []).slice(0, 6).map((name) => resolvePhotoUrl(name, 800)));
      restaurant.photoUrls = urls.filter((url): url is string => Boolean(url));
    })), "photos");
    echoLog.ok("photos", Date.now() - _photosT0, {
      restaurants: allRestaurants.length,
      withPhotos: allRestaurants.filter((r) => r.photoUrls && r.photoUrls.length > 0).length,
    });

    const missing = data.cuisines.filter((cuisine) =>
      !placeResults.some((group) => group.cuisine.toLowerCase() === cuisine.toLowerCase() && group.places.length),
    );
    echoLog.ok("pipeline", Date.now() - _pipelineT0, {
      groups: groups.length,
      restaurants: groups.reduce((s, g) => s + g.restaurants.length, 0),
      missing: missing.length,
      warnings: warnings.length,
    });
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
      echoLog.fail("pipeline", Date.now() - _pipelineT0, e, { atStage: _currentStage });
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

