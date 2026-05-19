# Finish English Mode End-to-End

## Behavior the user wants

- The language toggle only switches **UI chrome** (buttons, labels, headings, chips' surrounding text).
- It does **NOT** re-run AI search and does **NOT** change already-rendered results.
- The language chosen **at the moment a search is launched** decides what language the AI generates results in. Those results stay in that language forever, even if the user toggles afterwards.

So: search in EN → English results, then toggle to 中文 → UI becomes Chinese but the restaurant cards stay English. Toggle back → UI English again, same cards. No extra AI calls, no billing surprises.

## Why results page still looks Chinese today

UI on `/results` already uses `t()`. What stays Chinese is **AI-generated content**: `aiSummary`, `pros`/`cons`, `matchDetails.label`, `hardFilterChecks.note`, `reviewHighlights`/`commonComplaints`, plus the parsed condition chips (because `parseRequirements` itself writes Chinese). Server functions never received `uiLanguage`, so prompts hardcode 简体中文.

## Changes

### `src/lib/echo.functions.ts`
- Add `uiLanguage: z.enum(['zh','en']).default('zh')` to `ParseInput` and to the parsed schema consumed by `searchRestaurants`.
- `parseRequirements` prompt: replace "所有内容用简体中文" with `All free-text fields must be in ${uiLanguage === 'en' ? 'English' : '简体中文'}`. Leave `language` (BCP47 for Google Maps) alone.
- `searchRestaurants` reads `data.uiLanguage` and threads it to:
  - `ai-rank` prompt → `aiSummary` (2-3 sentences), `pros`, `cons`, `matchDetails[].label`, `hardFilterChecks[].note` in `${uiLanguage}`. When `en`, source suffix becomes `(based on Dianping / Xiaohongshu user reviews)`.
  - `dianping` summary → `reviewHighlights` / `commonComplaints` in `${uiLanguage}`; add `uiLanguage` to its function signature and its memoization key.
- `cuisine-expand` unchanged (driven by destination city language).

### `src/routes/results.tsx`
- **Do NOT** auto re-run search on toggle. `LanguageToggle` only flips UI text.
- `buildParsedForSearch()` and `applyEdit()` already attach `uiLanguage: lang`. Verified.
- Keep header `LanguageToggle` as-is.

### `src/lib/dianping.server.ts`
- Accept `uiLanguage`, inject into prompt, include in cache key so zh/en don't collide.

### `src/lib/store.ts`
- No change. `uiLanguage` is only attached on the request to the server, never persisted on `parsed`.

## Out of scope
- Translating already-stored Chinese results on toggle (no AI call on toggle).
- `/api/transcribe` language hint (Whisper auto-detects).

## Verification
1. Set EN on `/`, run search → parsed chips, AI summaries, pros/cons, match labels, dianping highlights all English. Toggle to 中文 → UI chrome flips but cards stay English. No network call to AI.
2. Set 中文 on `/`, run search → everything Chinese. Toggle to EN → UI flips, cards stay Chinese. No AI call.
3. Edit conditions in EN mode after toggling from 中文 → new parse + search runs in EN (uses **current** toggle at the time of the new search).
4. Regression: full ZH flow unchanged.
