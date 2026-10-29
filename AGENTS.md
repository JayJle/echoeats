# AGENTS
- Qwen model ids per pipeline step live only in src/lib/models.ts; why: switch a step after side-by-side tests with one line.
- Qwen 3.x calls go through ai-gateway noThinkingFetch (enable_thinking:false); why: thinking mode is slow and breaks JSON-only output.
- Perplexity only reads first-hand content (raw reviews, official site, web snippets) via src/lib/evidence.server.ts helpers and withPplxSlot; why: our own ranking model does the analysis, and a shared limiter avoids 429 bursts.
- Evidence enrichment runs only on the POOL_CAP-capped candidates; why: enriching dropped candidates was the largest Perplexity cost.
