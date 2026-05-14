# Echo Eats — MVP Implementation Plan

A natural-language restaurant discovery agent. Users describe city, cuisine, time, and free-form needs. AI structures requirements, searches multiple sources, and returns ranked recommendations with match scores and explanations.

## Scope (this build)

- 4-step guided input flow (city → cuisines → date/time → free text)
- AI requirement confirmation page (hard filters / soft preferences / negative filters / dish preferences / search strategy)
- Search results page with category groups, match scores, AI summaries, ratings, pros/cons, platform links
- Loading/streaming states between steps
- Bilingual UI copy (Chinese primary, matching the PRD)

## Out of scope (per PRD)

Social/feed, video, booking, navigation, communities, AI companion.

## User flow & routes

```text
/                    → Step 1: city
/cuisines            → Step 2: cuisine types (multi)
/when                → Step 3: date + time
/requirements        → Step 4: free-text needs
/confirm             → AI-parsed requirement summary (edit / search)
/results             → ranked restaurants grouped by cuisine
```

State carried across steps via a Zustand store (persisted to sessionStorage) so refresh doesn't lose input.

## Pages

**Step 1–4**: Single centered card, large input, "Next" button, progress indicator (1/4 … 4/4). Step 2 supports comma-separated or chip input. Step 3 uses date + time inputs.

**Confirm page**: Shows AI-parsed structure in clear sections — City, Cuisine Types, Date/Time, Hard Filters, Soft Preferences, Negative Filters, Dish Preferences, Search Strategy. Two actions: `Edit` (back to Step 4) and `Start Search`.

**Results page**: Header summarizing query → grouped sections per cuisine → restaurant cards with:
- Name (EN + local), match badge (★ Perfect / High / Partial), Match Score %
- Status row: open now, reservable
- Photo strip (3 slots)
- Multi-platform ratings table (Google / Tabelog / Yelp / Dianping / Meituan, "no data" allowed)
- AI summary paragraph explaining the recommendation
- Match details checklist (✓/⚠)
- High-frequency pros (+) and cons (−)
- Platform links

## AI integration

Two TanStack server functions in `src/lib/echo.functions.ts`, both calling Lovable AI Gateway via the OpenAI-compatible adapter (`google/gemini-3-flash-preview`):

1. `parseRequirements({ city, cuisines, date, time, freeText })` → structured object with `hardFilters[]`, `softPreferences[]`, `negativeFilters[]`, `dishPreferences[]`, `searchStrategy[]`. Uses AI SDK `Output.object` with a Zod schema.

2. `searchRestaurants(parsedRequirements)` → array of restaurant objects grouped by cuisine. For MVP we use the LLM to *generate plausible candidates* with realistic ratings/summaries based on the structured query (the PRD's real multi-platform scrapers — Tabelog/Dianping/Meituan — are out of MVP backend scope and require separate data infra). Output schema covers all fields rendered on the card. Clearly noted in code: this is the "AI-as-source" placeholder; real data sources can be wired into this same function later without changing the UI.

`LOVABLE_API_KEY` read inside handlers, never exposed to client. Lovable Cloud is **not** required for this build (no DB, no auth) — just the AI Gateway.

## Frontend stack

- TanStack Start file routes (no React Router DOM)
- Tailwind v4 + existing shadcn/ui (Button, Card, Input, Textarea, Badge, Separator)
- Zustand for cross-step query state
- TanStack Query + `useServerFn` for parse + search calls, with proper loading skeletons
- Design tokens only (no hardcoded colors); warm, restrained palette appropriate for a food/concierge product (light theme default, subtle accent)

## Components

```text
src/components/
  StepShell.tsx          shared layout: progress, title, input slot, next button
  CuisineChips.tsx       multi-input with chip display
  RequirementSection.tsx labeled list block for confirm page
  RestaurantCard.tsx     full result card
  MatchBadge.tsx         Perfect / High / Partial pill
  RatingTable.tsx        per-platform rating rows
  ProsCons.tsx
  LoadingState.tsx       skeleton + status message
```

## Files to create / modify

```text
src/styles.css                          (refine tokens for warm palette)
src/lib/store.ts                        (Zustand query store)
src/lib/echo.functions.ts               (parseRequirements, searchRestaurants)
src/lib/ai-gateway.ts                   (Lovable AI provider helper)
src/routes/index.tsx                    (Step 1)
src/routes/cuisines.tsx                 (Step 2)
src/routes/when.tsx                     (Step 3)
src/routes/requirements.tsx             (Step 4)
src/routes/confirm.tsx                  (AI confirmation)
src/routes/results.tsx                  (ranked results)
src/routes/__root.tsx                   (update title/meta to Echo Eats)
src/components/...                      (per list above)
```

## Technical notes

- All AI calls run server-side; client only sends user input via `useServerFn`.
- Server functions return plain DTOs (per server-fn rules).
- Zod schemas shared between validator and Output.object for parse step.
- Errors (429 rate limit, 402 credits) surfaced with toast + inline message; preserve user input.
- No placeholder index page remains — real Step 1 ships at `/`.
- SEO: per-route `head()` with unique titles (Echo Eats — Step N / Confirm / Results).

## Open question

The PRD lists Tabelog / Dianping / Meituan scrapers in the backend. These need scraping infra well beyond an MVP frontend build. Plan delivers the **full UX** with AI-generated candidate data in the search step so the product is end-to-end usable today; real scrapers/APIs can plug into `searchRestaurants` later. If you'd rather wait and wire real data sources first, say so before I start.
