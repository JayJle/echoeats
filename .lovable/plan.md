# Adjustable requirement weights on the progress page

## What the user sees
- The "What we understood" panel shows each understood need with its actual weight (0.1–1.0), as a small bar plus a number, grouped as now: must-haves, nice-to-haves, avoid, dishes, cuisines.
- An "Adjust" button turns each weight into a slider (step 0.1). Users can also move an item between "must-have" and "nice-to-have", or remove an item.
- While the user is editing, the search keeps running in the background (no wasted time if they change nothing).
- An "Apply & re-search" button appears once something changed. Clicking it stops the current search and restarts from the restaurant search step with the edited needs. The understanding step is skipped, so the restart saves roughly 5–10 seconds and the AI cannot re-interpret the user's edits.
- "Cancel" discards edits and the original search continues untouched.
- The results page keeps the edited weights, so "Back / refine" also starts from them.

## Rules
- Weight range 0.1–1.0, step 0.1 (same scale the AI already uses).
- Existing rule stays: a nice-to-have at weight 0.8 or more is treated as a must-have; the slider shows a hint when crossing 0.8 so the move is not a surprise.
- Avoid items keep their "not / avoid" meaning; only their weight changes.

## Technical details
- `src/routes/requirements.tsx`: add editable draft state copied from `parsedPreview`; render sliders (shadcn Slider) per condition; split `runSearch` so the search part can run with a supplied parsed object (`runSearchFromParsed(parsed)`), reusing the existing abort/runId logic to cancel the in-flight stream and reset progress to the search stage.
- No backend change needed: `searchRestaurants` already accepts the full parsed object and its validator re-applies dedupe; the 0.8 promotion happens in parse, so the client applies the same promotion on apply.
- i18n strings (zh/en) in `src/lib/i18n/dict.ts`: Adjust, Apply & re-search, Cancel, promotion hint.
- Add a small test for the client promotion rule (soft ≥ 0.8 becomes hard) and weight clamping.
- Verify end to end in the browser: start a search, change a weight, apply, confirm the search restarts and results come back.
