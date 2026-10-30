# AGENTS
- Qwen model ids per pipeline step live only in src/lib/models.ts; why: switch a step after side-by-side tests with one line.
- Qwen 3.x calls go through ai-gateway noThinkingFetch (enable_thinking:false); why: thinking mode is slow and breaks JSON-only output.
- Perplexity only reads first-hand content (raw reviews, official site, web snippets) via src/lib/evidence.server.ts helpers and withPplxSlot; why: our own ranking model does the analysis, and a shared limiter avoids 429 bursts.
- Perplexity evidence enrichment runs only on the top DEEP_EVIDENCE_CAP candidates per cuisine (rest of POOL_CAP is scored with Google-only evidence); why: tail candidates rarely reach the top 5, and enriching them dominated search time and Perplexity cost.
- Dishes are hard/soft conditions tagged with `dish`; `dishPreferences` is derived from them via foldDishes in src/lib/weights.ts; why: one list with no duplicates, while recall/ranking still get a clean dish list.
- Perplexity calls go through pplxPost (slot first, then per-call timeout; timeouts/429/5xx retry) and readers cache only results with real content; why: queue time was eating request timeouts and cached misses blocked re-reads on the next search.
- Cuisine corrections are limited to typo/refine(shop-format) and must pass validateCuisineCorrection in src/lib/cuisine-correct.ts; why: fix obvious typos and shop formats without rewriting correct input or turning dishes into cuisines.
