# AGENTS
- Qwen model ids per pipeline step live only in src/lib/models.ts; why: switch a step after side-by-side tests with one line.
- Qwen 3.x calls go through ai-gateway noThinkingFetch (enable_thinking:false); why: thinking mode is slow and breaks JSON-only output.
