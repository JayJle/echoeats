import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { createQwenProvider } from "./ai-gateway";
import {
  detectMissingFields,
  localFallbackResponse,
  MAX_PLANNER_TURNS,
  PlannerInput,
  PlannerOutput,
  postProcessPlannerOutput,
  type PlannerResponse,
} from "./planner-utils";

export type { PlannerField, PlannerResponse, PlannerTurn, ReaskInfo } from "./planner-utils";


/** Planner Agent: merges answers, asks one needed clarification, max 5 turns. */
export const plannerTurn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => PlannerInput.parse(input))
  .handler(async ({ data }): Promise<PlannerResponse> => {
    const isEn = data.uiLanguage === "en";
    const skipSet = new Set(data.skippedFields);
    const askedSet = new Set(data.askedFields);
    const missing = detectMissingFields(data.parsed, skipSet).filter(
      (f) => !askedSet.has(f) || data.reaskField?.field === f,
    );
    const reachedLimit = data.turnCount >= MAX_PLANNER_TURNS;

    if ((missing.length === 0 && !data.reaskField) || reachedLimit) {
      return localFallbackResponse({ data, isEn });
    }


    const key = process.env.QWEN_API_KEY;
    if (!key) return localFallbackResponse({ data, isEn });

    const gateway = createQwenProvider(key);
    const historyBlock = data.history.length
      ? data.history
          .map((t) => `${t.role === "assistant" ? "Assistant" : "User"}: ${t.content}`)
          .join("\n")
      : "(none)";

    const prompt = `You are the Planner Agent for Echo Eats, a restaurant discovery app.
Your job: merge the latest user answer into structured requirements, then ask ONE focused clarifying question only if still needed.

Reply in ${isEn ? "English" : "Simplified Chinese"} inside question.prompt and suggestions[].label.

## Context
- City: ${data.city || "(unknown)"}
- User's original free-text request: ${data.freeText || "(none)"}
- Current parsed structure (JSON): ${JSON.stringify(data.parsed ?? {})}
- Fields explicitly SKIPPED (never ask again): ${JSON.stringify(data.skippedFields)}
- Missing key fields detected locally BEFORE merging latest answer: ${JSON.stringify(missing)}
- Turn count so far: ${data.turnCount} / ${MAX_PLANNER_TURNS}
- Conversation so far:
${historyBlock}

## Rules
1. Structured parsed fields must contain only facts the user explicitly typed, spoke, or selected. Never write inferred guesses into parsed.
2. If the latest assistant question targeted a field, treat the following user reply as an answer for that field unless it is clearly skip/vague/contradictory.
3. After merging, ask only ONE field that is still missing, priority: cuisine > mealTime > budget > hardFilter. Never ask skipped fields.
4. If the answer is unparseable or contradictory, re-ask that same field with reason "unparseable" or "conflict".
5. Generate 2-3 concrete suggestions for the selected question. Cuisine suggestions may be inferred from context, but they are UI options only. Do not put them in parsed.cuisines unless the user selected/typed them in the conversation history.
6. If fields are complete, max turns reached, or remaining missing fields were skipped, set done=true, needsClarification=false, question=null.
7. Never invent constraints the user did not state. Only suggestions may be inferred. If original free-text did not explicitly mention a cuisine, parsed.cuisines must remain [] until the user answers the cuisine clarification.
8. Output STRICT JSON only, matching:
{
  "parsed": { "city": string, "cuisines": string[], "cuisinesInferred"?: boolean, "cuisineLevelConstraints"?: [{"text": string, "weight": number}], "dateTime": string, "hardFilters": [{"text": string, "weight": number}], "softPreferences": [{"text": string, "weight": number}], "negativeFilters": [{"text": string, "weight": number}], "dishPreferences": string[], "searchStrategy": string[], "visitTime"?: null | {"mentioned": boolean, "evidence": string, "weekday": number | null, "hhmm": string | null, "raw": string} },
  "newlyFilled": string[],
  "needsClarification": boolean,
  "done": boolean,
  "question": null | { "field": "cuisine" | "hardFilter" | "softPreference" | "mealTime" | "budget" | "ambiguity", "prompt": string, "reason": "missing" | "conflict" | "unparseable", "suggestions": [{ "label": string, "value": string }] }
}

Return ONLY the JSON object, no markdown fences, no commentary.`;

    const runModel = async (modelId: "qwen-plus" | "qwen-max"): Promise<PlannerResponse> => {
      const { text } = await generateText({
        model: gateway(modelId),
        prompt,
        temperature: 0.2,
      });
      const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
      return PlannerOutput.parse(JSON.parse(cleaned));
    };

    try {
      const out = await runModel("qwen-plus");
      return postProcessPlannerOutput({ out, data, isEn });
    } catch (e1) {
      console.warn("[planner] first attempt failed:", e1 instanceof Error ? e1.message : e1);
      try {
        const out = await runModel("qwen-max");
        return postProcessPlannerOutput({ out, data, isEn });
      } catch (e2) {
        console.warn("[planner] retry failed:", e2 instanceof Error ? e2.message : e2);
        return localFallbackResponse({ data, isEn });
      }
    }
  });