# Model upgrade + "more cities" hint on the city page

## 1. City page wording (Chinese and English)
Change the example text in the city box so people can tell it isn't limited to two cities:
- Chinese: `香港 / Hong Kong，东京 / Tokyo 等`
- English: `Hong Kong / 香港, Tokyo / 东京, etc.`

## 2. Upgrade AI models (same companies, newer versions)
The current models and the newest ones from the same company (per Alibaba Cloud's model list, updated Oct 28 2026):

| Step | Now | Upgrade to |
|---|---|---|
| Reading your request (main) | qwen-plus | qwen3.7-plus |
| Reading your request (retry) | qwen-max | qwen3.8-max |
| Merging duplicate needs | qwen-plus | qwen3.7-plus |
| Translating / expanding cuisines | qwen-turbo | qwen3.8-flash |
| Ranking Pass 1 / 2 / 3 | qwen-plus | qwen3.7-plus |
| Tabelog / Yelp lookup | Perplexity sonar / sonar-pro | no change unless a newer one turns up |
| Voice input | ElevenLabs scribe_v2 | no change unless a newer one turns up |

Safety steps:
- Before switching, check with your key that each new model actually works (call each one once). Any model that fails stays on its current version.
- Keep all model names in one shared spot so a future upgrade only means changing one line.
- After switching, run one real search and compare speed and how many results fall back to the default score with the last run.
- Update README and the architecture doc model tables.

## Technical details
- Model ids appear in `src/lib/echo.functions.ts` (lines ~271, 674, 795, 800, 2145), `src/lib/cuisine-expand.server.ts:42`, `src/lib/tabelog.server.ts`, `src/lib/yelp.server.ts`, `src/routes/api/transcribe.ts:67`. Pull Qwen ids into a `MODELS` constant.
- Endpoint is the Beijing `dashscope.aliyuncs.com` compatible-mode URL; confirm availability there with a quick test call per model id.
- Do a quick web check for newer Perplexity Sonar and ElevenLabs Scribe versions; only switch if documented.
- i18n keys: `step1.placeholder` in `src/lib/i18n/dict.ts` (zh line 34, en line 265).
