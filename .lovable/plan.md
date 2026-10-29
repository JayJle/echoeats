# Combine dishes and preferences into one list

## What changes
- The separate "Dishes" group goes away. Dishes show inside the preferences: nice-to-have dishes are listed under nice-to-haves, and must-have dishes ("必须有蟹刺身") under must-haves. Each dish appears once, with a weight like every other item.
- Users can adjust a dish's weight, move it between must-have and nice-to-have, or remove it, the same as any other preference.
- If the AI picks up the same dish as both a dish and a preference ("想吃拉面" and "ラーメン"), they merge into one item and the higher weight is kept.
- Behind the scenes the app still knows which items are dishes, so restaurant search still looks for those dishes and the ranking still checks the menu for them.

## How
1. Understanding step: each dish becomes a weighted preference with a "dish" tag (normal wish about 0.6, "must have" 1.0), instead of a separate unweighted list.
2. Merge step: dishes and preferences are grouped together, so a dish and its matching preference become one item.
3. The dish list that search and ranking use is built from items tagged as dishes, so those steps keep working.
4. Progress page and adjust-weights panel: remove the Dishes group; tagged dishes show a small dish icon inside their group.
5. Saved searches from before this change still load correctly.

## Technical details
- `WeightedCondition` gets optional `isDish?: boolean`; `dishPreferences` stays as a derived field (texts of `isDish` items in hard and soft) so recall routes, Tabelog/menu checks, and rank prompts are unchanged.
- `src/lib/echo.functions.ts`: update parse prompt and schema (rule near line 527 and example), and fold the dish list into `flat` in `semanticClusterMerge` (keep `isDish` if any member in a group is a dish). Rebuild `dishPreferences` after the merge and after `finalizeEdited` (`src/lib/weights.ts`) so user edits update it too.
- `src/routes/requirements.tsx`, `WeightEditor.tsx`: remove the dish section and add a dish icon. Old stored `dishPreferences` without `isDish` are turned into soft items at 0.6 when loaded.
- Tests: dish and matching preference merge into one item with the max weight; `dishPreferences` comes from `isDish` items, and removing a dish in the editor removes it from that list.
- End-to-end check: search "東京 拉面, 想吃叉烧, 必须安静" and confirm one combined list with no duplicates, and that results still mention the dish.
