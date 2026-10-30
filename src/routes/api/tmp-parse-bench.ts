// TEMPORARY: parse-only benchmark for cuisine correction. Delete after use.
import { createFileRoute } from "@tanstack/react-router";
import { parseRequirements } from "@/lib/echo.functions";

const CASES: [string, string][] = [
  ["寿司", "一定要有回转，要大腹"],
  ["寿司", "最好是回转的"],
  ["团丼", "新宿附近"],
  ["拉面", "一定要鱼介拉面"],
  ["拉面", "想吃豚骨的"],
  ["拉面", "安静、不排队"],
  ["烤肉", "要厚切牛舌"],
  ["居酒屋", "要有烤鸡串"],
];

export const Route = createFileRoute("/api/tmp-parse-bench")({
  server: {
    handlers: {
      GET: async () => {
        const out = await Promise.all(
          CASES.map(async ([c, t]) => {
            const p = (await parseRequirements({
              data: { city: "东京", cuisines: [c], autoInferCuisines: false, date: "", freeText: t, uiLanguage: "zh" },
            } as never)) as Record<string, unknown>;
            const f = (a: unknown) => ((a as { text: string; weight: number; dish?: string }[]) ?? []).map((x) => `${x.dish ? "🍽" : ""}${x.text}@${x.weight}`);
            return {
              input: `${c} | ${t}`,
              cuisines: p.cuisines,
              corrections: p.cuisineCorrections,
              hard: f(p.hardFilters),
              soft: f(p.softPreferences),
              neg: f(p.negativeFilters),
              dishes: p.dishPreferences,
            };
          }),
        );
        return Response.json(out);
      },
    },
  },
});
