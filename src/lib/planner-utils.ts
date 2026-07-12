import { z } from "zod";
import type { ParsedRequirements, WeightedCondition } from "./store";

export const PlannerFieldEnum = z.enum([
  "cuisine",
  "hardFilter",
  "softPreference",
  "mealTime",
  "budget",
  "ambiguity",
]);
export type PlannerField = z.infer<typeof PlannerFieldEnum>;

export const TurnSchema = z.object({
  role: z.enum(["assistant", "user"]),
  content: z.string(),
  field: PlannerFieldEnum.optional().nullable(),
});
export type PlannerTurn = z.infer<typeof TurnSchema>;

const WeightedIn = z.object({
  text: z.string(),
  weight: z.number().min(0).max(1).default(0.7),
});

const VisitTimeIn = z.object({
  mentioned: z.boolean().default(false),
  evidence: z.string().default(""),
  weekday: z.number().nullable().default(null),
  hhmm: z.string().nullable().default(null),
  raw: z.string().default(""),
}).nullable();

export const ParsedIn = z.object({
  city: z.string().default(""),
  cuisines: z.array(z.string()).default([]),
  cuisinesInferred: z.boolean().optional(),
  cuisineLevelConstraints: z.array(WeightedIn).optional(),
  dateTime: z.string().default(""),
  hardFilters: z.array(WeightedIn).default([]),
  softPreferences: z.array(WeightedIn).default([]),
  negativeFilters: z.array(WeightedIn).default([]),
  dishPreferences: z.array(z.string()).default([]),
  searchStrategy: z.array(z.string()).default([]),
  visitTime: VisitTimeIn.optional(),
});

export const PlannerInput = z.object({
  city: z.string().default(""),
  uiLanguage: z.enum(["zh", "en"]).default("zh"),
  freeText: z.string().default(""),
  history: z.array(TurnSchema).default([]),
  parsed: ParsedIn.nullable().default(null),
  skippedFields: z.array(PlannerFieldEnum).default([]),
  turnCount: z.number().int().default(0),
});
export type PlannerInputData = z.infer<typeof PlannerInput>;

const SuggestionSchema = z.object({
  label: z.string(),
  value: z.string(),
});

const QuestionSchema = z.object({
  field: PlannerFieldEnum,
  prompt: z.string(),
  reason: z.enum(["missing", "conflict", "unparseable"]).default("missing"),
  suggestions: z.array(SuggestionSchema).max(4).default([]),
});

export const PlannerOutput = z.object({
  parsed: ParsedIn,
  newlyFilled: z.array(z.string()).default([]),
  needsClarification: z.boolean().default(false),
  done: z.boolean().default(false),
  question: QuestionSchema.nullable().default(null),
});
export type PlannerResponse = z.infer<typeof PlannerOutput>;

export const MAX_PLANNER_TURNS = 5;

const BUDGET_RE = /(预算|人均|¥|￥|\$|€|£|jpy|usd|cny|rmb|日元|円|元|块|budget|per person|price|便宜|实惠|性价比|中等|适中|高端|奢侈|贵|affordable|cheap|moderate|mid\s*range|splurge|expensive)/i;
const SKIP_RE = /^(skip|跳过|不用了|不了|不需要|no thanks|—)$/i;
const VAGUE_RE = /^(随便|都行|不限|无所谓|不知道|anything|any|whatever|no preference)$/i;

export function emptyParsed(city: string): PlannerResponse["parsed"] {
  return {
    city,
    cuisines: [],
    dateTime: "",
    hardFilters: [],
    softPreferences: [],
    negativeFilters: [],
    dishPreferences: [],
    searchStrategy: [],
    visitTime: null,
  };
}

export function detectMissingFields(
  parsed: ParsedRequirements | null,
  skipped: Set<PlannerField>,
): PlannerField[] {
  if (!parsed) return ["cuisine", "mealTime", "budget", "hardFilter"];
  const missing: PlannerField[] = [];
  const hasRealCuisine =
    parsed.cuisines.length > 0 &&
    !parsed.cuisines.every((c) => c === "餐厅" || c.toLowerCase() === "restaurants");
  if (!hasRealCuisine && !skipped.has("cuisine")) missing.push("cuisine");

  const prefs: WeightedCondition[] = [
    ...(parsed.hardFilters ?? []),
    ...(parsed.softPreferences ?? []),
  ];

  const hasVisitTime = !!parsed.visitTime && parsed.visitTime.mentioned;
  if (!hasVisitTime && !skipped.has("mealTime")) missing.push("mealTime");

  const hasBudget = prefs.some((p) => BUDGET_RE.test(p.text));
  if (!hasBudget && !skipped.has("budget")) missing.push("budget");

  if (prefs.length === 0 && !skipped.has("hardFilter") && !skipped.has("softPreference")) {
    missing.push("hardFilter");
  }

  return missing;
}

export function postProcessPlannerOutput(args: {
  out: PlannerResponse;
  data: PlannerInputData;
  isEn: boolean;
}): PlannerResponse {
  const { out, data, isEn } = args;
  const skipSet = new Set<PlannerField>(data.skippedFields);
  // Planner suggestions are allowed to be inferred, but structured facts are not.
  // Start from the already-confirmed parsed state and merge only the user's latest answer deterministically.
  out.parsed = normalizeParsed(data.parsed ?? emptyParsed(data.city), data.city);
  const answeredField = enforceAnsweredField(out, data.history, data.city);
  const stillMissing = detectMissingFields(out.parsed as ParsedRequirements | null, skipSet);

  if (stillMissing.length === 0 || data.turnCount >= MAX_PLANNER_TURNS) {
    out.done = true;
    out.needsClarification = false;
    out.question = null;
    return out;
  }

  const nextField = pickNextField(stillMissing, answeredField);
  const questionIsUsable =
    !!out.question &&
    stillMissing.includes(out.question.field) &&
    !skipSet.has(out.question.field);

  if (!questionIsUsable) {
    out.question = fallbackQuestion(nextField, data.city, isEn);
  } else if (out.question) {
    out.question.suggestions = normalizeSuggestions(
      out.question.suggestions,
      out.question.field,
      data.city,
      isEn,
    );
  }
  out.done = false;
  out.needsClarification = true;
  return out;
}

export function localFallbackResponse(args: {
  data: PlannerInputData;
  isEn: boolean;
}): PlannerResponse {
  const { data, isEn } = args;
  const parsed = normalizeParsed(data.parsed ?? emptyParsed(data.city), data.city);
  const out: PlannerResponse = {
    parsed,
    newlyFilled: [],
    needsClarification: true,
    done: false,
    question: null,
  };
  enforceAnsweredField(out, data.history, data.city);
  const missing = detectMissingFields(out.parsed as ParsedRequirements | null, new Set(data.skippedFields));
  if (missing.length === 0 || data.turnCount >= MAX_PLANNER_TURNS) {
    return { ...out, needsClarification: false, done: true, question: null };
  }
  return {
    ...out,
    question: fallbackQuestion(missing[0] ?? "hardFilter", data.city, isEn),
  };
}

function normalizeParsed(parsed: PlannerResponse["parsed"], city: string): PlannerResponse["parsed"] {
  return {
    ...emptyParsed(city),
    ...parsed,
    city: parsed?.city || city,
    cuisines: Array.isArray(parsed?.cuisines) ? parsed.cuisines.filter(Boolean) : [],
    cuisinesInferred: false,
    hardFilters: Array.isArray(parsed?.hardFilters) ? parsed.hardFilters : [],
    softPreferences: Array.isArray(parsed?.softPreferences) ? parsed.softPreferences : [],
    negativeFilters: Array.isArray(parsed?.negativeFilters) ? parsed.negativeFilters : [],
    dishPreferences: Array.isArray(parsed?.dishPreferences) ? parsed.dishPreferences : [],
    searchStrategy: Array.isArray(parsed?.searchStrategy) ? parsed.searchStrategy : [],
  };
}

function pickNextField(missing: PlannerField[], answeredField: PlannerField | null): PlannerField {
  if (answeredField && missing.includes(answeredField)) return answeredField;
  return missing[0] ?? "hardFilter";
}

function normalizeSuggestions(
  suggestions: { label: string; value: string }[],
  field: PlannerField,
  city: string,
  isEn: boolean,
) {
  const clean = suggestions.filter((s) => s.label.trim() && s.value.trim()).slice(0, 3);
  if (clean.length >= 2) return clean;
  return fallbackQuestion(field, city, isEn).suggestions;
}

function getLastAssistantQuestion(history: PlannerTurn[]): { field: PlannerField; answer: string } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    if (t.role === "assistant" && t.field) {
      const reply = history[i + 1];
      if (reply?.role !== "user") return null;
      return { field: t.field, answer: reply.content.trim() };
    }
  }
  return null;
}

function isUsefulAnswer(field: PlannerField, answer: string): boolean {
  if (!answer || SKIP_RE.test(answer) || VAGUE_RE.test(answer)) return false;
  if (field === "mealTime") {
    return /(今天|今晚|明天|后天|周[一二三四五六日天末]|星期|周末|中午|晚上|早上|午餐|晚餐|早餐|点|:\d{2}|\b\d{1,2}\b|tonight|tomorrow|weekend|lunch|dinner|noon|morning|evening|am|pm)/i.test(answer);
  }
  if (field === "budget") return BUDGET_RE.test(answer) || /\d/.test(answer);
  if (field === "cuisine") return !/[?？]/.test(answer) && answer.length <= 40;
  return true;
}

function splitCuisineAnswer(answer: string): string[] {
  return answer
    .split(/\s*(?:、|，|,|\/|或|或者|和|and|or)\s*/i)
    .map((v) => v.trim())
    .filter((v) => v && v.length <= 40 && !/[?？]/.test(v))
    .filter((v) => !BUDGET_RE.test(v) && !/(预算|人均|元|円|块|\d+\s*(?:点|:|am|pm))/i.test(v));
}

function parseMealTimeAnswer(answer: string): {
  weekday: number | null;
  hhmm: string | null;
} {
  const today = new Date().getDay();
  let weekday: number | null = null;
  if (/后天/.test(answer)) weekday = (today + 2) % 7;
  else if (/明天|tomorrow/i.test(answer)) weekday = (today + 1) % 7;
  else if (/今天|今晚|today|tonight/i.test(answer)) weekday = today;
  else {
    const map: Array<[RegExp, number]> = [
      [/(?:周|星期|礼拜)[日天]|sunday/i, 0],
      [/(?:周|星期|礼拜)一|monday/i, 1],
      [/(?:周|星期|礼拜)二|tuesday/i, 2],
      [/(?:周|星期|礼拜)三|wednesday/i, 3],
      [/(?:周|星期|礼拜)四|thursday/i, 4],
      [/(?:周|星期|礼拜)五|friday/i, 5],
      [/(?:周|星期|礼拜)六|saturday/i, 6],
    ];
    weekday = map.find(([pattern]) => pattern.test(answer))?.[1] ?? null;
  }

  let hhmm: string | null = null;
  const clock24 = answer.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (clock24) {
    hhmm = `${clock24[1].padStart(2, "0")}:${clock24[2]}`;
  } else {
    const clock12 = answer.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i);
    if (clock12) {
      const hour = (Number(clock12[1]) % 12) + (clock12[3].toLowerCase() === "pm" ? 12 : 0);
      hhmm = `${String(hour).padStart(2, "0")}:${clock12[2] ?? "00"}`;
    } else {
      const zhHour = answer.match(/(?:早上|上午|中午|下午|傍晚|晚上|今晚|夜里|凌晨)?\s*(\d{1,2})\s*点(?:半|([0-5]?\d)分?)?/);
      if (zhHour) {
        let hour = Number(zhHour[1]);
        const minute = zhHour[0].includes("半") ? "30" : (zhHour[2] ?? "00").padStart(2, "0");
        if (/(下午|傍晚|晚上|今晚|夜里)/.test(answer) && hour >= 1 && hour <= 11) hour += 12;
        if (/(凌晨)/.test(answer) && hour === 12) hour = 0;
        if (hour >= 0 && hour <= 23) hhmm = `${String(hour).padStart(2, "0")}:${minute}`;
      } else if (/早午餐|brunch/i.test(answer)) hhmm = "10:30";
      else if (/早餐|breakfast/i.test(answer)) hhmm = "08:30";
      else if (/午餐|午饭|中午|lunch|noon/i.test(answer)) hhmm = "12:30";
      else if (/晚餐|晚饭|晚上|dinner|supper|evening|tonight/i.test(answer)) hhmm = "19:00";
      else if (/夜宵|宵夜|late[-\s]?night/i.test(answer)) hhmm = "22:00";
    }
  }

  if (hhmm && weekday == null && /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\d{1,2}\s*点/i.test(answer)) {
    weekday = today;
  }
  return { weekday, hhmm };
}

function enforceAnsweredField(
  out: PlannerResponse,
  history: PlannerTurn[],
  city: string,
): PlannerField | null {
  const last = getLastAssistantQuestion(history);
  if (!last || !isUsefulAnswer(last.field, last.answer)) return last?.field ?? null;

  const p = (out.parsed ??= emptyParsed(city));
  const touched = (name: string) => {
    if (!out.newlyFilled.includes(name)) out.newlyFilled.push(name);
  };
  const answer = last.answer;

  if (last.field === "mealTime") {
    if (!p.visitTime || !p.visitTime.mentioned) {
      const mealTime = parseMealTimeAnswer(answer);
      p.visitTime = {
        mentioned: true,
        evidence: answer,
        weekday: mealTime.weekday,
        hhmm: mealTime.hhmm,
        raw: answer,
      };
      touched("visitTime");
    }
  } else if (last.field === "cuisine") {
    const cuisines = splitCuisineAnswer(answer);
    const next = [...p.cuisines];
    for (const cuisine of cuisines) {
      if (!next.some((c) => c.trim() === cuisine)) next.push(cuisine);
    }
    if (next.length !== p.cuisines.length) {
      p.cuisines = next;
      p.cuisinesInferred = false;
      touched("cuisines");
    }
  } else if (last.field === "budget") {
    const has = (p.softPreferences ?? []).some((s) => s.text === answer) ||
      (p.hardFilters ?? []).some((s) => s.text === answer);
    if (!has) {
      p.softPreferences = [...(p.softPreferences ?? []), { text: answer, weight: 0.7 }];
      touched("budget");
    }
  } else if (last.field === "hardFilter" || last.field === "softPreference") {
    const has = (p.hardFilters ?? []).some((s) => s.text === answer) ||
      (p.softPreferences ?? []).some((s) => s.text === answer);
    if (!has) {
      if (last.field === "hardFilter") {
        p.hardFilters = [...(p.hardFilters ?? []), { text: answer, weight: 0.8 }];
      } else {
        p.softPreferences = [...(p.softPreferences ?? []), { text: answer, weight: 0.7 }];
      }
      touched(last.field === "hardFilter" ? "hardFilters" : "softPreferences");
    }
  }
  return last.field;
}

function fallbackQuestion(
  field: PlannerField,
  city: string,
  isEn: boolean,
): NonNullable<PlannerResponse["question"]> {
  const table: Record<PlannerField, { zh: string; en: string; sugg: { label: string; value: string }[] }> = {
    cuisine: {
      zh: `想在${city || "这里"}吃点什么口味？`,
      en: `What cuisine are you in the mood for${city ? " in " + city : ""}?`,
      sugg: [
        { label: isEn ? "Sushi" : "寿司", value: isEn ? "Sushi" : "寿司" },
        { label: isEn ? "Ramen" : "拉面", value: isEn ? "Ramen" : "拉面" },
        { label: isEn ? "Izakaya" : "居酒屋", value: isEn ? "Izakaya" : "居酒屋" },
      ],
    },
    mealTime: {
      zh: "打算什么时候去吃？",
      en: "When are you planning to eat?",
      sugg: [
        { label: isEn ? "Tonight 7pm" : "今晚 7 点", value: isEn ? "Tonight 19:00" : "今晚 19:00" },
        { label: isEn ? "Tomorrow lunch" : "明天中午", value: isEn ? "Tomorrow 12:30" : "明天中午 12:30" },
      ],
    },
    budget: {
      zh: "人均预算大概多少？",
      en: "What's your per-person budget?",
      sugg: [
        { label: isEn ? "Budget-friendly" : "便宜实惠", value: isEn ? "Budget-friendly, ≤ $20" : "人均 100 元以内" },
        { label: isEn ? "Mid-range" : "中等", value: isEn ? "Mid-range, $20-50" : "人均 300 元左右" },
        { label: isEn ? "Splurge" : "高端", value: isEn ? "Splurge, $80+" : "人均 800 元以上" },
      ],
    },
    hardFilter: {
      zh: "还有什么特别在意的？氛围、位置、评分…",
      en: "Anything specific? Vibe, location, rating…",
      sugg: [
        { label: isEn ? "Locals love it" : "本地人爱去", value: isEn ? "Locals love it, not touristy" : "本地人爱去，不要游客店" },
        { label: isEn ? "Quiet, good for talking" : "安静能聊天", value: isEn ? "Quiet enough to talk" : "安静能聊天" },
        { label: isEn ? "Google 4.0+" : "Google 4.0 以上", value: isEn ? "Google rating 4.0+" : "谷歌评分 4.0 以上" },
      ],
    },
    softPreference: {
      zh: "有什么偏好？",
      en: "Any preferences?",
      sugg: [],
    },
    ambiguity: {
      zh: "刚才的信息有点模糊，能再说明一下吗？",
      en: "The last answer was a bit unclear — could you clarify?",
      sugg: [],
    },
  };
  const e = table[field];
  return {
    field,
    prompt: isEn ? e.en : e.zh,
    reason: "missing",
    suggestions: e.sugg,
  };
}