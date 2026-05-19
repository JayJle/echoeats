## Problem

On the English version of the results page, several strings still render in Chinese, and the per-person price row hides Google Place's price level when no review-based price is available.

Specifically:
1. **"未指定"** appears when no date is chosen (line 311 — already language-aware, but verify it's reaching UI in EN).
2. **"硬条件 / 硬条件未满足 / 硬条件待核实"** — match-detail labels are hardcoded in Chinese (`src/lib/echo.functions.ts` lines 1575–1580). They ignore `uiLanguage`.
3. **"大众点评 / 人均价格"** — `candidateRatings` (lines 819–824) emits Chinese platform labels regardless of language. Plus `formatPriceFromReview` appends `（来自网评）` / `（…，来自网评）` in Chinese.
4. **Per-person price ("人均消费") falls back to nothing** when there is no review-derived `priceLevel`. User wants the Google Places `priceLevel` ($, $$, $$$, $$$$) shown as a fallback even though the AI ranker doesn't weight it heavily.

## Fix

All changes are presentation-only (server function shapes the strings going to the UI; no schema or business-logic change).

### 1. Plumb `uiLanguage` into the result-builder helpers

Around line 1605 (`ratings: candidateRatings(p, review, tabelogInfo)`) and around line 1575 (match-detail labels), pass `data.uiLanguage` (already in scope as `isEn`).

### 2. Localize `candidateRatings` (lines 800–825)

- Accept `isEn` arg.
- Platform labels when `isEn`:
  - `"大众点评"` → `"Dianping"`
  - `"人均价格"` → `"Avg. price"`
- Inside `dpScore`, replace `（网评）` with `(reviews)` when `isEn`.
- **Price fallback**: if `formatPriceFromReview(review)` returns `null`, fall back to `priceLevelLabel(p.priceLevel)` (the Google `$$$` string). When using the Google fallback, append `(Google)` / `（Google）` so users know the source. This addresses the "show Google price even if not weighted" request.

### 3. Localize `formatPriceFromReview` (lines 792–798)

Accept `isEn`; in EN return `"$120 (from reviews)"` or `"$120 (avg. price, from reviews)"`.

### 4. Localize hard-constraint match-detail labels (lines 1570–1582)

Use the existing i18n keys already defined in `dict.ts` (`results.hardCheckOk / Fail / Unknown`) — render via `translate(data.uiLanguage, "results.hardCheckOk", { text: h.text, suffix: noteSuffix })` from `src/lib/i18n/dict.ts`. Also localize `noteSuffix` separator (`（…）` → `(…)`).

### 5. Date placeholder

Confirm line 311 — `"Unspecified"` is already emitted for `uiLanguage === "en"`. If "未指定" still showing on EN UI, it likely comes from the AI model echoing the prompt template (line 110). Tighten the prompt: when `uiLanguage === "en"`, instruct the model to use `"Unspecified"` in `dateTime` instead of `"未指定"`.

## Out of scope

- Source-side Chinese strings inside Dianping prompts (only used for CN cities, never surfaced raw on EN UI).
- "Google 搜索" / "官网" link button labels (separate pass if user wants).
- Changing how the AI ranker weights price (user explicitly said: keep behavior, just display).

## Files touched

- `src/lib/echo.functions.ts` — `candidateRatings`, `formatPriceFromReview`, match-detail builder, ranker prompt date-line.
