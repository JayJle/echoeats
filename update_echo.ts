import fs from 'fs';

let content = fs.readFileSync('src/lib/echo.functions.ts', 'utf8');

// Update ResultsSchema to match new store structure
content = content.replace(
  /const ResultsSchema = z\.object\(\{\s*groups: z\.array\(\s*z\.object\(\{\s*cuisine: z\.string\(\),\s*restaurants: z\.array\(RestaurantSchema\),\s*partialRestaurants: z\.array\(RestaurantSchema\)\.optional\(\),\s*\}\),\s*\),\s*\}\);/,
  `const ResultsSchema = z.object({
  groups: z.array(
    z.object({
      cuisine: z.string(),
      restaurants: z.array(RestaurantSchema),
      okRestaurants: z.array(RestaurantSchema).optional(),
      partialRestaurants: z.array(RestaurantSchema).optional(),
      failedRestaurants: z.array(RestaurantSchema).optional(),
    }),
  ),
});`
);

// Merging logic with correct bucket names
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
          const highWeightFail = checks.some((c) => c.status === "fail" && c.weight >= 0.85);
          const highWeightUnknown = checks.some((c) => c.status === "unknown" && c.weight >= 0.85);
          
          if (highWeightFail) status = "fail";
          else if (highWeightUnknown) status = "unknown";
          else if (checks.some(c => c.status === "unknown")) status = "unknown";

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
            localName: p.name, // Use original name for consistency or try to get local
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

        // Top-5 fill: OK then Unknown
        const sortedOk = [...okList].sort((a, b) => b.matchScore - a.matchScore);
        const sortedUnknown = [...unknownList].sort((a, b) => b.matchScore - a.matchScore);
        
        const restaurants = [...sortedOk.slice(0, 5)];
        if (restaurants.length < 5) {
          const needed = 5 - restaurants.length;
          restaurants.push(...sortedUnknown.slice(0, needed));
        }

        return {
          cuisine,
          restaurants,
          okRestaurants: sortedOk,
          partialRestaurants: sortedUnknown,
          failedRestaurants: failList,
        };
      })
      .filter((g) => g.restaurants.length > 0 || (g.okRestaurants?.length ?? 0) > 0);

    yield {
      type: "result",
      payload: {
        groups,
        error: groups.length === 0 ? (isEn ? "No matching restaurants found." : "未找到匹配的餐厅。") : null,
        suggestions: fallbackSuggestions(uiLang),
        warnings,
      },
    };`;

const searchResponseIndex = content.indexOf('// 3. 合并 AI picks 与真实 Place 数据');
const handlerEnd = content.indexOf('  });', searchResponseIndex);

if (searchResponseIndex !== -1 && handlerEnd !== -1) {
    content = content.substring(0, searchResponseIndex) + newMergingLogic + content.substring(handlerEnd);
}

fs.writeFileSync('src/lib/echo.functions.ts', content);
