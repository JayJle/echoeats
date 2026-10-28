import type { ParsedRequirements, WeightedCondition } from "@/lib/store";

export const PROMOTE_AT = 0.8;

/** Clamp to [0.1, 1.0], one decimal. */
export function clampWeight(w: number): number {
  if (!Number.isFinite(w)) return 0.7;
  return Math.round(Math.min(1, Math.max(0.1, w)) * 10) / 10;
}

/** Apply user edits: clamp all weights, promote soft >= 0.8 to hard (same rule as the parser). */
export function finalizeEdited(p: ParsedRequirements): ParsedRequirements {
  const fix = (a: WeightedCondition[]) => a.map((c) => ({ ...c, weight: clampWeight(c.weight) }));
  const soft = fix(p.softPreferences);
  return {
    ...p,
    hardFilters: [...fix(p.hardFilters), ...soft.filter((s) => s.weight >= PROMOTE_AT)],
    softPreferences: soft.filter((s) => s.weight < PROMOTE_AT),
    negativeFilters: fix(p.negativeFilters),
  };
}
