import type { ParsedRequirements, WeightedCondition } from "@/lib/store";

export const PROMOTE_AT = 0.8;
/** Default weight for a dish the user wants but did not mark as required. */
export const DISH_DEFAULT_WEIGHT = 0.6;

/** Clamp to [0.1, 1.0], one decimal. */
export function clampWeight(w: number): number {
  if (!Number.isFinite(w)) return 0.7;
  return Math.round(Math.min(1, Math.max(0.1, w)) * 10) / 10;
}

type Foldable = {
  hardFilters: WeightedCondition[];
  softPreferences: WeightedCondition[];
  negativeFilters: WeightedCondition[];
  dishPreferences: string[];
};

const norm = (s: string) => s.normalize("NFKC").trim().toLocaleLowerCase();

/**
 * Dishes live inside hard/soft conditions (tagged with `dish`).
 * Any dish in `dishPreferences` that is not yet tagged is attached to a matching
 * hard/soft condition (text contains the dish), otherwise added as a nice-to-have.
 * `dishPreferences` is then rebuilt from the tagged conditions.
 */
export function foldDishes<T extends Foldable>(p: T): T {
  const hard = p.hardFilters.map((c) => ({ ...c }));
  const soft = p.softPreferences.map((c) => ({ ...c }));
  const tagged = () => new Set([...hard, ...soft].filter((c) => c.dish).map((c) => norm(c.dish!)));
  for (const raw of p.dishPreferences) {
    const dish = raw.trim();
    if (!dish || tagged().has(norm(dish))) continue;
    const match = [...hard, ...soft].find((c) => !c.dish && norm(c.text).includes(norm(dish)));
    if (match) match.dish = dish;
    else soft.push({ text: dish, weight: DISH_DEFAULT_WEIGHT, dish });
  }
  const seen = new Set<string>();
  const dishPreferences: string[] = [];
  for (const c of [...hard, ...soft]) {
    if (!c.dish) continue;
    const k = norm(c.dish);
    if (seen.has(k)) continue;
    seen.add(k);
    dishPreferences.push(c.dish);
  }
  return { ...p, hardFilters: hard, softPreferences: soft, dishPreferences };
}

/** Apply user edits: clamp all weights, promote soft >= 0.8 to hard (same rule as the parser). */
export function finalizeEdited(p: ParsedRequirements): ParsedRequirements {
  const fix = (a: WeightedCondition[]) => a.map((c) => ({ ...c, weight: clampWeight(c.weight) }));
  const soft = fix(p.softPreferences);
  const next = {
    ...p,
    hardFilters: [...fix(p.hardFilters), ...soft.filter((s) => s.weight >= PROMOTE_AT)],
    softPreferences: soft.filter((s) => s.weight < PROMOTE_AT),
    negativeFilters: fix(p.negativeFilters),
  };
  // Dishes come only from tagged conditions, so removing a dish row removes the dish.
  return foldDishes({ ...next, dishPreferences: [] });
}
