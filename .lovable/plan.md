# Model upgrade (chosen per step's needs) + "more cities" hint

## 1. City page wording (Chinese and English)
- Chinese: `香港 / Hong Kong，东京 / Tokyo 等`
- English: `Hong Kong / 香港, Tokyo / 东京, etc.`

## 2. What each step actually needs
Each step is upgraded only if a newer model from the same company does that job better. A newer version alone isn't a reason to switch.

| Step | What it needs | Now | Candidate | Keep it only if |
|---|---|---|---|---|
| Reading your request | Clean JSON every time, keeps "don't want" wording, gets 6:30 PM right | qwen-plus | qwen3.7-plus | JSON never breaks, and negatives and times stay correct |
| Request retry | Strongest reasoning, only runs when the first try fails | qwen-max | qwen3.8-max | Fixes the cases the main model gets wrong |
| Merging duplicate needs | Group similar meanings, short output, fast | qwen-plus | qwen3.7-plus or qwen3.8-flash | Same groupings as now, faster |
| Translating cuisines | Very short, fast, cheap | qwen-turbo | qwen3.8-flash | As accurate, no slower |
| Ranking Pass 1 (check) | Many restaurants per call, strict JSON, no empty replies (the old pain point) | qwen-plus | qwen3.7-plus | No empty replies, no missing restaurants |
| Ranking Pass 2 (score) | Fair score per restaurant, nothing skipped (old "fallback to 60" issue) | qwen-plus | qwen3.7-plus | Fewer skipped scores than now |
| Ranking Pass 3 (text) | Good bilingual writing | qwen-plus | qwen3.7-plus | Text reads at least as well |
| Tabelog / Yelp lookup | Find the exact restaurant page | sonar / sonar-pro | check for newer Sonar | Only if documented and it finds pages more often |
| Voice input | Accurate Chinese + English speech | scribe_v2 | check for newer Scribe | Only if documented and works on our setup |

## 3. How each candidate is tested before switching
1. Make sure each new model works with our key and server location (one test call each). If a call fails, that step keeps its current model.
2. Run the same set of real past requests through old and new models for each step. Include a brunch request, a "not street food" request, a "6:30 PM" request, and a Tokyo sushi request. Compare broken JSON, empty replies, skipped scores, correctness and speed.
3. Switch only the steps where the new model wins. Report each result to you in a simple table.
4. After switching, run one full search in the app and check the logs for each stage's time and any failures.
5. Update README and the architecture doc with the final models and why each was chosen.

## Technical details
- Model ids live in `src/lib/echo.functions.ts` (~271, 674, 795, 800, 2145), `src/lib/cuisine-expand.server.ts:42`, `src/lib/tabelog.server.ts`, `src/lib/yelp.server.ts`, `src/routes/api/transcribe.ts:67`. Pull Qwen ids into one `MODELS` constant so a step can be switched with one line.
- Endpoint is the Beijing `dashscope.aliyuncs.com` compatible-mode URL. Check availability there, since Alibaba's newest list is for the international region.
- Comparison script lives in /tmp and calls DashScope directly with the existing prompts. It checks parse success, field coverage (each placeId has a matchScore), `[AVOID]` kept, PM-time correctness, and latency.
- i18n key `step1.placeholder` in `src/lib/i18n/dict.ts` (zh line 34, en line 265).
- Add `roadmap.md` tracking: placeholder text, per-step model evaluation, switch + verify, docs update.
