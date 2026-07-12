import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { createQwenProvider } from "./ai-gateway";
import type { ParsedRequirements, WeightedCondition } from "./store";

/**
 * Planner Agent —— 判断结构化字段是否已满足搜索所需，若否则生成下一轮追问。
 * 每轮把 history + 当前 parsed 全部发给 LLM，LLM 输出：
 *   - 融合后的最新 parsed
 *   - newlyFilled 字段名
 *   - needsClarification / question / done
 */

const PlannerFieldEnum = z.enum([
  "cuisine",
  "hardFilter",
  "softPreference",
  "mealTime",
  "budget",
  "ambiguity",
]);
export type PlannerField = z.infer<typeof PlannerFieldEnum>;

const TurnSchema = z.object({
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

const ParsedIn = z.object({
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

const PlannerInput = z.object({
  city: z.string().default(""),
  uiLanguage: z.enum(["zh", "en"]).default("zh"),
  freeText: z.string().default(""),
  history: z.array(TurnSchema).default([]),
  parsed: ParsedIn.nullable().default(null),
  skippedFields: z.array(PlannerFieldEnum).default([]),
  turnCount: z.number().int().default(0),
});

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

const PlannerOutput = z.object({
  parsed: ParsedIn,
  newlyFilled: z.array(z.string()).default([]),
  needsClarification: z.boolean().default(false),
  done: z.boolean().default(false),
  question: QuestionSchema.nullable().default(null),
});
export type PlannerResponse = z.infer<typeof PlannerOutput>;

const MAX_TURNS = 5;

/** 本地兜底：判断关键字段是否缺失，用于校验 LLM 输出的合理性。 */
function detectMissingFields(
  parsed: ParsedRequirements | null,
  skipped: Set<PlannerField>,
): PlannerField[] {
  if (!parsed) return ["cuisine", "hardFilter", "mealTime", "budget"];
  const missing: PlannerField[] = [];
  const hasRealCuisine =
    parsed.cuisines.length > 0 &&
    !parsed.cuisines.every((c) => c === "餐厅" || c.toLowerCase() === "restaurants");
  if (!hasRealCuisine && !skipped.has("cuisine")) missing.push("cuisine");

  const prefs: WeightedCondition[] = [
    ...(parsed.hardFilters ?? []),
    ...(parsed.softPreferences ?? []),
  ];
  if (prefs.length === 0 && !skipped.has("hardFilter") && !skipped.has("softPreference")) {
    missing.push("hardFilter");
  }

  const hasVisitTime = !!parsed.visitTime && parsed.visitTime.mentioned;
  if (!hasVisitTime && !skipped.has("mealTime")) missing.push("mealTime");

  const budgetRe = /(预算|人均|¥|￥|\$|€|£|jpy|usd|cny|rmb|元|块|budget|per person|price)/i;
  const hasBudget = prefs.some((p) => budgetRe.test(p.text));
  if (!hasBudget && !skipped.has("budget")) missing.push("budget");

  return missing;
}

export const plannerTurn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => PlannerInput.parse(input))
  .handler(async ({ data }): Promise<PlannerResponse> => {
    const key = process.env.QWEN_API_KEY;
    if (!key) throw new Error("Missing QWEN_API_KEY");
    const gateway = createQwenProvider(key);

    const skipSet = new Set<PlannerField>(data.skippedFields);
    const missing = detectMissingFields(data.parsed as ParsedRequirements | null, skipSet);
    const reachedLimit = data.turnCount >= MAX_TURNS;

    // 关键字段全齐 或 已达上限 → 直接结束，不消耗 LLM。
    if (missing.length === 0 || reachedLimit) {
      return {
        parsed: (data.parsed ?? emptyParsed(data.city)) as PlannerResponse["parsed"],
        newlyFilled: [],
        needsClarification: false,
        done: true,
        question: null,
      };
    }

    const isEn = data.uiLanguage === "en";
    const historyBlock = data.history.length
      ? data.history
          .map((t) => `${t.role === "assistant" ? "Assistant" : "User"}: ${t.content}`)
          .join("\n")
      : "(none)";

    const prompt = `You are the Planner Agent for Echo Eats, a restaurant discovery app.
Your job: decide whether the structured requirements are complete enough to search, and if not, ask ONE focused clarifying question.

Reply in ${isEn ? "English" : "Simplified Chinese"} inside the JSON \`question.prompt\` and \`suggestions[].label\`.

## Context
- City: ${data.city || "(unknown)"}
- User's original free-text request: ${data.freeText || "(none)"}
- Current parsed structure (JSON): ${JSON.stringify(data.parsed ?? {})}
- Fields the user has explicitly SKIPPED (never ask again): ${JSON.stringify(data.skippedFields)}
- Missing key fields detected locally: ${JSON.stringify(missing)}
- Turn count so far: ${data.turnCount} / ${MAX_TURNS}
- Conversation so far:
${historyBlock}

## Rules
1. Merge any NEW info in the latest user message into \`parsed\`, keeping the existing ParsedRequirements shape (city, cuisines, hardFilters[{text,weight}], softPreferences[{text,weight}], negativeFilters, dishPreferences[], visitTime{mentioned,evidence,weekday,hhmm,raw}, dateTime, searchStrategy, cuisineLevelConstraints).
2. List every field name you actually added/updated this turn in \`newlyFilled\` (values like "cuisines","hardFilters","visitTime","softPreferences","budget"). This drives UI highlight.
3. Pick ONE field to clarify from the missing list, priority: cuisine > mealTime > budget > hardFilter. NEVER ask about a field in skippedFields.
4. If the previous user turn was unparseable or contradicts existing info (e.g. budget 500 but wants 3-Michelin-star), set \`question.reason\` to "unparseable" or "conflict" and re-ask THAT field.
5. Generate 2-3 concrete \`suggestions\` based on city + parsed context. Examples:
   - cuisine in Tokyo → [{label:"寿司",value:"寿司"},{label:"拉面",value:"拉面"},{label:"居酒屋",value:"居酒屋"}]
   - budget in Tokyo → [{label:"人均 ≤ 3000 日元",value:"人均预算 3000 日元以内"}, ...]
   - mealTime → [{label:"今晚 7 点",value:"今晚 19:00"}, ...]
6. If all missing fields are impossible to ask (all skipped) OR you decide the current parsed is good enough, set \`done=true\`, \`needsClarification=false\`, \`question=null\`.
7. Never invent constraints the user didn't state. Only suggestions may be inferred.
8. Output STRICT JSON only, matching this TypeScript type:
{
  "parsed": { ...ParsedRequirements },
  "newlyFilled": string[],
  "needsClarification": boolean,
  "done": boolean,
  "question": null | {
    "field": "cuisine" | "hardFilter" | "softPreference" | "mealTime" | "budget" | "ambiguity",
    "prompt": string,
    "reason": "missing" | "conflict" | "unparseable",
    "suggestions": [{ "label": string, "value": string }]
  }
}

Return ONLY the JSON object, no markdown fences, no commentary.`;

    const runModel = async (modelId: "qwen-plus" | "qwen-max"): Promise<PlannerResponse> => {
      const { text } = await generateText({
        model: gateway(modelId),
        prompt,
        temperature: 0.2,
      });
      const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
      const parsed = JSON.parse(cleaned) as unknown;
      return PlannerOutput.parse(parsed);
    };

    try {
      const out = await runModel("qwen-plus");
      enforceAnsweredField(out, data.history, data.city);
      const stillMissing = detectMissingFields(
        out.parsed as ParsedRequirements | null,
        skipSet,
      );
      // 兜底：LLM 忘了触发但本地检测到缺失 → 强制补一条 question
      if (stillMissing.length === 0) {
        out.done = true;
        out.needsClarification = false;
        out.question = null;
      } else if (!out.done && !out.question) {
        out.needsClarification = true;
        out.question = fallbackQuestion(stillMissing[0], data.city, isEn);
      }
      return out;
    } catch (e1) {
      console.warn("[planner] first attempt failed:", e1 instanceof Error ? e1.message : e1);
      try {
        return await runModel("qwen-max");
      } catch (e2) {
        console.warn("[planner] retry failed:", e2 instanceof Error ? e2.message : e2);
        // 最终兜底：本地生成一条简单追问，不阻塞流程
        return {
          parsed: (data.parsed ?? emptyParsed(data.city)) as PlannerResponse["parsed"],
          newlyFilled: [],
          needsClarification: true,
          done: false,
          question: fallbackQuestion(missing[0] ?? "hardFilter", data.city, isEn),
        };
      }
    }
  });

function emptyParsed(city: string): PlannerResponse["parsed"] {
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

/**
 * Deterministic safety net: if the assistant's last question targeted a field
 * and the user actually answered it (not a skip / not empty), force that field
 * to appear in `parsed` — otherwise the LLM sometimes forgets to merge it and
 * we re-ask the same question next turn.
 */
function enforceAnsweredField(
  out: PlannerResponse,
  history: PlannerTurn[],
  city: string,
): void {
  // Find last assistant turn with a field, and the user reply after it.
  let lastAsst: PlannerTurn | null = null;
  let userReply: PlannerTurn | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    if (t.role === "assistant" && t.field) {
      lastAsst = t;
      userReply = history[i + 1] && history[i + 1].role === "user" ? history[i + 1] : null;
      break;
    }
  }
  if (!lastAsst || !lastAsst.field || !userReply) return;
  const answer = userReply.content.trim();
  if (!answer) return;
  // Skip marker heuristic: very short skip words. If user skipped, the panel
  // still writes a user turn; treat those as non-answers.
  if (/^(skip|跳过|不用了|no thanks|—)$/i.test(answer)) return;

  const p = (out.parsed ??= {
    city,
    cuisines: [],
    dateTime: "",
    hardFilters: [],
    softPreferences: [],
    negativeFilters: [],
    dishPreferences: [],
    searchStrategy: [],
    visitTime: null,
  } as PlannerResponse["parsed"]);

  const field = lastAsst.field;
  const touched = (name: string) => {
    if (!out.newlyFilled.includes(name)) out.newlyFilled.push(name);
  };

  if (field === "mealTime") {
    if (!p.visitTime || !p.visitTime.mentioned) {
      p.visitTime = {
        mentioned: true,
        evidence: answer,
        weekday: p.visitTime?.weekday ?? null,
        hhmm: p.visitTime?.hhmm ?? null,
        raw: answer,
      };
      touched("visitTime");
    }
  } else if (field === "cuisine") {
    if (!p.cuisines.some((c) => c.trim() === answer)) {
      p.cuisines = [...p.cuisines, answer];
      touched("cuisines");
    }
  } else if (field === "budget") {
    const has = (p.softPreferences ?? []).some((s) => s.text === answer) ||
      (p.hardFilters ?? []).some((s) => s.text === answer);
    if (!has) {
      p.softPreferences = [...(p.softPreferences ?? []), { text: answer, weight: 0.7 }];
      touched("budget");
    }
  } else if (field === "hardFilter" || field === "softPreference") {
    const has = (p.hardFilters ?? []).some((s) => s.text === answer) ||
      (p.softPreferences ?? []).some((s) => s.text === answer);
    if (!has) {
      p.softPreferences = [...(p.softPreferences ?? []), { text: answer, weight: 0.7 }];
      touched(field === "hardFilter" ? "hardFilters" : "softPreferences");
    }
  }
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
