import fs from 'fs';

let content = fs.readFileSync('src/lib/echo.functions.ts', 'utf8');

// 1. Update AiPickSchema to be more general
// (It's already quite general, but let's make sure it doesn't have hard-coded pick-only logic)

// 2. Update buildPromptForGroup
const oldPromptStart = 'const buildPromptForGroup = (group: GroupForPrompt) => {';
const newPromptStart = `const buildPromptForGroup = (group: GroupForPrompt) => {
  const exp = cuisineExpansions.get(group.cuisine);
  const syn = exp && exp.synonyms.length ? exp.synonyms.join("、") : "（无）";
  const neg =
    exp && exp.negativeKeywords.length ? exp.negativeKeywords.join("、") : "（无）";
  const fidelity = exp
    ? \`- 「\${group.cuisine}」：本地化主词 = "\${exp.primary}"；同义词 = \${syn}；反例（明显不是该料理）= \${neg}\`
    : \`- 「\${group.cuisine}」：（无额外扩展）\`;

  return \`你是 Echo Eats 的餐厅匹配分析师。下面是 Google Places 返回的真实候选餐厅（针对料理：「\${group.cuisine}」）。请对提供的所有候选餐厅进行深度核验与分类。

用户需求：
- 城市：\${data.city}
- 日期/时间：\${data.dateTime}
- 硬条件（带 weight 0-1）：\${hardFiltersJson}
- 偏好（带 weight）：\${softJson === "[]" ? "无" : softJson}
- 避雷（带 weight）：\${negJson === "[]" ? "无" : negJson}
- 菜品偏好：\${data.dishPreferences.join("、") || "无"}

## 验证与分类任务
请核验列表中的**每一个**餐厅，并将其归入以下三个桶（Buckets）之一：
1. **ok**：满足所有 weight >= 0.85 的硬条件，且没有明显的负面网评冲突。
2. **unknown**：没有任何 weight >= 0.85 的条件明确判定为 "fail"，但至少有一个重要条件因为信息不足被标记为 "unknown"。
3. **fail**：至少有一个 weight >= 0.85 的硬条件被明确判定为 "fail"（不满足）。

## 料理保真（最高优先级）
\${fidelity}
判定方法：检查候选的 name / primaryType / editorialSummary / realWorldReviews。
- 命中反例关键词且未命中主词/同义词 → **判定为 fail**。

候选数据（JSON）：
\${JSON.stringify(group.candidates, null, 2)}

## 铁律
- **核验所有候选**：必须对提供的列表中的每一家店给出核验结果。
- **hardFilterChecks 长度一致**：对每个餐厅，hardFilterChecks 数组长度必须严格等于 \${hardFiltersList.length}。
- **状态判定依据**：
  - "ok": 明确证据支持。
  - "fail": 明确证据证实不满足。
  - "unknown": 无法确认。
- **禁止幻觉**：如果 realWorldReviews 为空，严禁编造评价。

输出 JSON 格式：{ "picks": [{ "placeId": "...", "verificationStatus": "ok", "matchScore": 88, ... }] }
（注：此处 picks 数组应包含所有核验过的餐厅，不仅仅是推荐的）\`;
};\n`;

// I will search for the function definition and replace it.
const promptRegex = /const buildPromptForGroup = \(group: GroupForPrompt\) => \{[\s\S]*?\};/m;
content = content.replace(promptRegex, newPromptStart);

// 3. Implement batching in rankOneGroup
const oldRankOneGroup = /const rankOneGroup = async \([\s\S]*? \};/m;
// This is more complex because it has nested try-catches.
// I'll replace the loop that calls rankOneGroup instead.

content = content.replace(
  'const groupResults = yield* withHeartbeat(\n      Promise.all(candidatesForPrompt.map(rankOneGroup)),\n      "rank",\n    );',
  `const groupResults = yield* withHeartbeat(
      (async () => {
        const results = [];
        for (const group of candidatesForPrompt) {
          // Batch within each cuisine
          const BATCH_SIZE = 12;
          const batches = [];
          for (let i = 0; i < group.candidates.length; i += BATCH_SIZE) {
            batches.push(group.candidates.slice(i, i + BATCH_SIZE));
          }
          
          const batchPicks = await Promise.all(batches.map(async (batch) => {
            const res = await rankOneGroup({ ...group, candidates: batch });
            return res.picks;
          }));
          
          results.push({ cuisine: group.cuisine, picks: batchPicks.flat() });
        }
        return results;
      })(),
      "rank",
    );`
);

// 4. Update Merging Logic (Bucketing and Top-5 Fill)
const mergingLogicStart = '// 3. 合并 AI picks 与真实 Place 数据';
const mergingLogicRegex = /\/\/ 3\. 合并 AI picks 与真实 Place 数据[\s\S]*?return \{[\s\S]*?type: "result",[\s\S]*?payload: \{[\s\S]*?groups: groups,[\s\S]*?suggestions: fallbackSuggestions\(uiLang\),[\s\S]*?warnings,[\s\S]*?\},[\s\S]*?\};[\s\S]*?\}\);/m;

// I'll read the existing logic and replace it with bucketing logic.
const newMergingLogic = `// 3. 合并 AI picks 与真实 Place 数据
    const placeById = new Map<string, { cuisine: string; place: PlaceCandidate }>();
    for (const r of placeResults) {
      for (const p of r.places) placeById.set(p.placeId, { cuisine: r.cuisine, place: p });
    }

    const groups = data.cuisines
      .map((cuisine) => {
        const aiGroup =
          ranking.groups.find((g) => g.cuisine.toLowerCase() === cuisine.toLowerCase()) ??
          ranking.groups.find((g) => g.cuisine === cuisine);
        const allVerified = aiGroup?.picks ?? [];

        const okList: any[] = [];
        const unknownList: any[] = [];
        const failList: any[] = [];

        for (const pick of allVerified) {
          const entry = placeById.get(pick.placeId);
          if (!entry) continue;
          const p = entry.place;

          const checksByFilter = new Map<string, { status: "ok" | "unknown" | "fail"; note?: string }>();
          for (const c of pick.hardFilterChecks ?? []) {
            checksByFilter.set(c.filter, { status: c.status, note: c.note });
          }
          const checks = data.hardFilters.map((h) => {
            const c = checksByFilter.get(h.text);
            return {
              ...(c ?? { status: "unknown" as const, note: undefined }),
              weight: h.weight,
            };
          });

          // Determine bucket
          let status: "ok" | "unknown" | "fail" = "ok";
          if (checks.some((c) => c.status === "fail" && c.weight >= 0.85)) {
            status = "fail";
          } else if (checks.some((c) => c.status === "unknown" && c.weight >= 0.85)) {
            status = "unknown";
          } else if (checks.some((c) => c.status === "unknown")) {
            // Even low weight unknown makes it unknown for verification purposes if we want to be strict,
            // but let's say only high weight unknowns demote from OK.
            // Actually user asked for 3 buckets.
            status = checks.some(c => c.status === "unknown") ? "unknown" : "ok";
          }

          const aiScore = Math.round(pick.matchScore);
          let weightAdjust = 0;
          for (const c of checks) {
            if (c.status === "fail") weightAdjust -= c.weight * 25;
            else if (c.status === "unknown") weightAdjust -= c.weight * 4;
          }
          const score = Math.max(0, Math.min(100, Math.round(aiScore + weightAdjust)));

          const restaurant = {
            id: pick.placeId,
            name: p.name,
            localName: p.displayName || p.name,
            cuisine: entry.cuisine,
            address: p.address,
            googleMapsUri: p.googleMapsUri,
            websiteUri: p.websiteUri,
            primaryType: p.primaryType,
            matchScore: score,
            matchTier: score >= 92 ? "perfect" : score >= 80 ? "high" : "partial",
            verificationStatus: status,
            openNow: p.openNow,
            reservable: p.reservable,
            needsReview: status !== "ok",
            ratings: candidateRatings(p, reviewById.get(p.placeId) || null, tabelogById.get(p.placeId) || null, isEn, country, yelpById.get(p.placeId) || null),
            aiSummary: pick.aiSummary,
            matchDetails: pick.matchDetails.map(d => ({ ...d, status: d.status === "ok" ? "ok" : "warn" })),
            pros: pick.pros,
            cons: pick.cons,
            links: buildLinks(p, data.city, country, isEn, yelpById.get(p.placeId)?.url),
            photoUrls: p.photoUrls || [],
            tabelog: tabelogById.get(p.placeId) || null,
            yelp: yelpById.get(p.placeId) || null,
            weekdayDescriptions: p.weekdayDescriptions,
            visitTimeMatch: visitMatchById.get(p.placeId) || null,
          };

          if (status === "ok") okList.push(restaurant);
          else if (status === "unknown") unknownList.push(restaurant);
          else failList.push(restaurant);
        }

        // Top-5 fill
        const restaurants = [...okList.sort((a, b) => b.matchScore - a.matchScore).slice(0, 5)];
        if (restaurants.length < 5) {
          const needed = 5 - restaurants.length;
          restaurants.push(...unknownList.sort((a, b) => b.matchScore - a.matchScore).slice(0, needed));
        }

        return {
          cuisine,
          restaurants,
          ok: okList,
          unknown: unknownList,
          fail: failList,
          partialRestaurants: unknownList, // compatibility
        };
      })
      .filter((g) => g.restaurants.length > 0 || g.ok.length > 0 || g.unknown.length > 0);

    yield {
      type: "result",
      payload: {
        groups,
        error: groups.length === 0 ? (isEn ? "No matching restaurants found after verification." : "核验后未找到匹配的餐厅。") : null,
        suggestions: fallbackSuggestions(uiLang),
        warnings,
      },
    };`;

// Use a simpler approach to replace the merging logic as it spans many lines.
const searchResponseIndex = content.indexOf('// 3. 合并 AI picks 与真实 Place 数据');
const searchResponseEnd = content.lastIndexOf('});') + 3; // Approximate
// Better search for the end of the handler
const handlerEnd = content.indexOf('  });', searchResponseIndex);

if (searchResponseIndex !== -1 && handlerEnd !== -1) {
    content = content.substring(0, searchResponseIndex) + newMergingLogic + content.substring(handlerEnd);
} else {
    console.error('Could not find merging logic placement');
    process.exit(1);
}

fs.writeFileSync('src/lib/echo.functions.ts', content);
