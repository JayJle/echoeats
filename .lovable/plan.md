## 问题诊断

用户搜「猪肉饭」结果第一条是「鳗鱼饭」。根因有 4 个：

1. **查询词没本地化**：`searchPlaces` 用 `cuisine` 中文原文 + 城市拼接（"猪肉饭 Tokyo"），日语区 Google Places 在中文 query 下会做语义模糊匹配，把所有「丼物」一起召回，包含鳗鱼饭、牛丼。
2. **没有同义词扩展**：「猪肉饭」在日本叫「豚丼 / 豚バラ丼」，在港台叫「叉烧饭 / 烧肉饭」，英文是「pork rice / pork bowl」。当前只做 1-2 个 query。
3. **召回后无相关性过滤**：所有 `placeResults[].places` 不分料理对错，全量塞给 AI 排序 prompt。AI 看到 20 个候选，会按 rating 高低挑，鳗鱼饭店因为评分高就被选上。
4. **AI prompt 没把"料理类型本身"列为 hardFilter**：`cuisine` 字段只是分组键，prompt 里没明确"店必须实际卖这个料理"。

## 改动范围

只改后端 3 个文件：`google-places.server.ts`、`echo.functions.ts`、`dianping.server.ts`（轻改）。前端 `results.tsx` 不动。

## 1. 新增「料理本地化与同义词扩展」模块

新增 `src/lib/cuisine-expand.server.ts`，导出：

```ts
expandCuisineQueries(cuisine: string, city: string, lang: string): {
  primary: string;           // 最准确的本地化主词
  synonyms: string[];        // 同义词（用于 query 扩展和召回过滤）
  negativeKeywords: string[];// 排除关键词（如搜「猪肉饭」时，"鳗"、"牛"、"鸡"算反例）
}
```

实现策略：用 `gemini-3-flash-preview` 做一次轻量 LLM 调用（缓存 in-memory by `${cuisine}|${lang}`），输出结构化 JSON，例如：

```
猪肉饭 + ja → { primary:"豚丼", synonyms:["豚バラ丼","焼豚丼","チャーシュー丼","pork rice bowl"], negativeKeywords:["鰻","うなぎ","牛丼","親子丼","海鮮丼"] }
猪肉饭 + en → { primary:"pork rice bowl", synonyms:["char siu rice","pork donburi"], negativeKeywords:["eel","beef","chicken"] }
寿司 + ja → { primary:"寿司", synonyms:["sushi","鮨"], negativeKeywords:[] }   // 通用词不需要 negative
```

成本：每个 cuisine 一次 ~200 token 调用，缓存命中后 0 成本。

## 2. `searchPlaces` 多 query 召回

`echo.functions.ts` 海外分支当前只用 `[cuisine + city, cuisine + city + suffix]` 两条 query。改为：

```
queries = [
  `${primary} ${city}`,
  ...synonyms.slice(0, 2).map(s => `${s} ${city}`),
  `${primary} ${city} ${semanticSuffix}`,
]
```

最多 4 条 query 并发，结果按 placeId 去重，与现状一致。

## 3. 召回后做"料理相关性过滤"

去重后的 `places` 数组在塞给 AI 排序前，先过一道关键词过滤：

```
function filterByCuisineRelevance(places, primary, synonyms, negativeKeywords) {
  return places.filter(p => {
    const haystack = `${p.name} ${p.primaryType ?? ""} ${p.editorialSummary ?? ""}`.toLowerCase();
    const negHit = negativeKeywords.some(n => haystack.includes(n.toLowerCase()));
    if (negHit) {
      // 命中 negative 但同时命中 positive，仍保留（混合店）
      const posHit = [primary, ...synonyms].some(k => haystack.includes(k.toLowerCase()));
      if (!posHit) return false;
    }
    return true;
  });
}
```

关键点：
- 仅过滤"明显反例"，不强求 positive hit（避免误杀只有店名没有类型描述的小店）。
- 过滤后若候选数 < 3，回退到不过滤的全集（保留召回宽度，由 AI 再判）。
- 只过滤 `primaryType + editorialSummary + name` 命中 negative 且无 positive 的，比较保守。

## 4. AI 排序 prompt 加「料理保真」硬条件

在 `searchRestaurants` handler 里，把「店实际卖 ${cuisine}」作为 **隐式硬条件第 0 条**注入 prompt（不写入 `data.hardFilters`，仅在 prompt 里说明），新增段落：

```
## 料理保真（最高优先级）
本组的料理类型是「${cuisine}」（本地化主词：${primary}；同义词：${synonyms.join("、")}）。
candidate.primaryType / editorialSummary / name 必须能合理对应这个料理，否则**不要放进 picks**（视为 fail，不进 partial）。
明确属于其它料理（如本组要"猪肉饭"但候选是鳗鱼饭/牛丼/海鲜丼）→ 直接剔除，不解释。
仅在候选模糊（如"日式定食店"且菜单不明）时允许保留并标 unknown。
```

注意：这条**不计入 `hardFilterChecks` 数组长度**，只在自然语言段落里强制。`hardFilterChecks` 仍严格 = `data.hardFilters.length`，不破坏现有合约。

## 5. 国内分支同步加同义词

`dianping.server.ts` 的 `searchDianpingCuisine` 里调 Perplexity 找候选时，prompt 把同义词列出，例如「请找上海的猪肉饭/烧肉饭/叉烧饭餐厅」，提升召回准确度。改动很小：在拼 user prompt 时插一行同义词 hint。

## 6. （可选）UI 提示

不改 UI；如需后续可在结果页显示 `parsed.cuisines[i] → 本地化为 "豚丼/pork rice"`，让用户感知本地化。本期先不做。

## 技术细节

```text
用户 cuisine ─┐
              ├─► expandCuisineQueries (LLM, 缓存)
city/lang ────┘    │
                   ▼
        { primary, synonyms[], negativeKeywords[] }
                   │
                   ├─► searchPlaces(多 query 并发)
                   │        ▼
                   │   去重 places[]
                   │        ▼
                   └─► filterByCuisineRelevance
                            ▼
                   reviewById 合并 + AI 排序 prompt
                   （prompt 内嵌料理保真硬条件）
```

## 风险与回退

- LLM 扩展失败 → fallback 到 `{ primary: cuisine, synonyms: [], negativeKeywords: [] }`，行为退化为现状。
- 过滤后候选 < 3 → 自动回退到不过滤集合，不让用户看到空结果。
- 缓存仅 in-memory，per-Worker；冷启动会多一次 LLM 调用，可接受。

## 预期效果

- 「猪肉饭 + Tokyo」→ 召回 query 变成 `豚丼 Tokyo`、`豚バラ丼 Tokyo`、`pork rice bowl Tokyo`，自然不会再大规模召回鳗鱼饭店。
- 即使有少量鳗鱼饭混入，过滤层（negativeKeywords 命中"鰻"）会剔除它们。
- AI 排序层兜底：即使前两层漏网，prompt 明确禁止把鳗鱼饭挑进猪肉饭分组。
- 通用大类（寿司、拉面）negativeKeywords 为空，行为不变，无回归风险。
