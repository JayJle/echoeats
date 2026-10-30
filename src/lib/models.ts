// Single source of truth for which Qwen model each step uses.
// Chosen per step from side-by-side tests (2026-10-28), not by "newest wins".
export const MODELS = {
  // qwen3.7-plus put soft prefs (ambience, budget) into hard filters in tests → keep qwen-plus.
  parse: "qwen-plus",
  // Stronger reasoning for the retry; matched qwen-plus classification, newer.
  parseRetry: "qwen3.8-max",
  // Semantic clustering — same structured-output path as parse; keep stable.
  cluster: "qwen-plus",
  // Short translate/expand; qwen-turbo hit rate limits, flash was fast and accurate.
  cuisineExpand: "qwen3.8-flash",
  // Step 1 cuisine resolve (keep/replace/extend or infer): short JSON, fast model.
  cuisineResolve: "qwen3.8-flash",
  // Ranking Pass 1/2/3: full score coverage and ~15% faster than qwen-plus.
  rank: "qwen3.7-plus",
} as const;
