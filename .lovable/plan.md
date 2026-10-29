# Dishes no longer repeated as nice-to-haves

## What changes
- When something is recognised as a dish (e.g. 蟹刺身, ramen), it appears only under "Dishes" and is removed from the nice-to-have list.
- Exception: if the user said the dish is required ("必须有蟹刺身"), it stays as a must-have too, because that is a real filter that can rule out restaurants. Only nice-to-have duplicates are removed.
- Avoid items (e.g. "不要生鱼片") are never touched.
- Scoring still checks the dish, since dishes are already given to the ranking step separately.

## How
1. Understanding prompt: change the rule "dish goes into dishes AND conditions" so that a dish wish without "must" goes only into dishes; a must-have dish still goes into both.
2. Safety net in the merge step (which already groups similar items): it also reports which nice-to-have items mean the same thing as a listed dish ("想吃拉面" = "ラーメン"); those are dropped. A plain text match is used as a fallback if that step fails.
3. Log how many nice-to-haves were removed this way.

## Technical details
- `src/lib/echo.functions.ts`: edit the parse prompt boundary rule (~line 527) and example; extend `SemanticClusterOutput` with `softDishDupIds: number[]` and the cluster prompt; in `semanticClusterMerge` drop soft entries whose id is in that list (only bucket "soft"); fallback exact/contains match against `dishPreferences` in the failure path.
- Add a small test for the fallback rule: soft "蟹刺身" removed when dish "蟹刺身" exists; hard "必须有蟹刺身" kept; negative kept.
