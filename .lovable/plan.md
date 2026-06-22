# 跨品类候选去重方案

## 背景（现状）

`src/lib/echo.functions.ts` 中，候选池目前的结构是 `placeResults: { cuisine, places: PlaceCandidate[] }[]`，每个品类各自一个桶：

```
placeResults = [
  { cuisine: "寿司",   places: [A, B, C, D] },
  { cuisine: "居酒屋", places: [B, C, E, F] },   // B、C 与寿司桶重复
  { cuisine: "日本料理", places: [A, C, F, G] }, // A、C、F 也重复
]
```

后续每一步都按这个分桶结构进行：
- L1444 visitTime 闭店硬筛
- L1485 规则初筛（businessStatus/price/rating）
- L1521 Tabelog（JP）：`for r of placeResults; for p of r.places` —— **同一家店会被抓多次**
- L1565 Yelp（非 JP）：同样多次
- L1603+ AI 分组排序：每个品类各自给 AI 一次 batch —— 同一家店会被多次喂给 AI 评估
- 前端 `results.tsx` 按 group 渲染 —— 用户会在多个品类卡片里看到同一家店

所以现在的浪费主要发生在 **Tabelog/Yelp 抓取** 和 **AI 评论分析** 两步，正好是最贵的两步。需要在它们之前把同一 placeId 在跨品类间合并掉，并把这家店**唯一归属**到一个品类。

## 去重原则（不丢失）

1. 去重只发生在 **跨品类**：同一品类桶内本来就用 `merged: Map<placeId, …>` 合过了。
2. 去重的判定键是 **Google Places 的 `placeId`**。这是稳定唯一键，不用名称/地址再做模糊匹配（避免误伤同名分店）。
3. 去重等于"**移到唯一归属品类**"，不是删除。最终所有原本出现过的 placeId 仍然在某一个桶里出现一次。事后会用一行 log 自证：

   ```
   [dedupe] union=N, kept=N (per-cuisine sum before=M, after=N)
   ```

   `union` 和 `kept` 必须相等；否则视为 bug 立刻报错。
4. 跨品类去重之前还要保留每个 placeId **曾经命中过哪些品类** 的信息（`matchedCuisines: string[]`），方便：
   - 前端在该卡片上展示"也属于 居酒屋"标签（可选 UI 后续做，不在这次 scope）；
   - AI prompt 里告诉模型这家店在哪些品类下被召回，避免它纠结分类。

## 归属品类的选择规则（按优先级，遇到平手就看下一条）

对每个 placeId 在多品类中重复时，按以下顺序判定它**归到哪一个**品类桶：

1. **强匹配优先**：在该品类的 `CuisineExpansion` 下，命中 `primary` 或 `synonyms`（出现在 `name / primaryType / editorialSummary` 里）的归该品类。
   - 进一步细分：`primaryType` 命中 > `name` 命中 > `editorialSummary` 命中。
   - 已经在 `filterByCuisineRelevance` 用过同一套词表，复用即可。
2. **召回路线强度**：看 `recallSourcesById` 里这家店在该品类的 recall tag。`primary`（品类名直搜）> `name:*` / `cuisine:syn`（同义词路线）> `budget:*` / `mood:*` 等周边路线。
3. **稀有品类优先**：候选总数更少的品类优先（候选多的品类不缺这一家，少的品类留住它结构上更平衡）。这一步专门防止"寿司桶吃掉所有日料店"。
4. **用户输入顺序**：以 `data.cuisines` 的顺序为准，越靠前优先级越高。这条是最终 tiebreaker，保证结果可复现。

`["餐厅"] / fallback` 兜底品类永远排到最后——只有当这家店没有任何"具体品类"愿意收时，才落到兜底桶。

## 实施位置（关键：在 Tabelog/Yelp/AI 之前）

在 `echo.functions.ts` L1396 各品类 `Promise.all` 返回之后、L1444 `visitTime` 闭店硬筛之前，新增一个 `dedupeAcrossCuisines(placeResults, …)` 步骤。它的输入是 per-cuisine 桶，输出仍然是同形状的 per-cuisine 桶，但每个 placeId 在所有桶里只出现一次。

放在闭店硬筛之前还是之后都可以，但**必须在 Tabelog（L1521）和 Yelp（L1565）和 AI 分组（L1603）之前**——这是省钱省时间的核心点。建议放在 L1396 之后立刻执行，理由：
- 闭店、价格、评分三道规则筛本身按 placeId 做就行，对去重不敏感；
- 但 visitTime 的 `visitMatchById` 是按 placeId 存的，跨品类没冲突，放后面也不影响；
- 越早去重，后续所有 `for r of placeResults` 循环规模都越小，调试 log 也更清爽。

## 数据结构改动

`PlaceCandidate`（或外部 side-map）补一个：

```ts
// side-map，避免修改 PlaceCandidate 类型
const matchedCuisinesById = new Map<string, string[]>();  // placeId -> 原本所有命中的 cuisine
```

`dedupeAcrossCuisines` 内部：

```text
1. 遍历 placeResults，建 placeId -> { place, cuisines: string[], scores: { cuisine -> rank } }
2. 对每个 placeId：按"归属规则"挑出 winnerCuisine
3. 重建 placeResults：每个 cuisine 桶只保留 winner 是自己的 placeId
4. 同时填充 matchedCuisinesById
5. 打印 [dedupe] log + 健康检查 (union vs kept 必须相等)
```

## 顺带要做的小事

- AI prompt 里把 `matchedCuisines` 透传进去（如果某家店原本也命中"居酒屋"，prompt 里附一句"该店也符合 居酒屋"），避免 AI 因为分类差异给出奇怪的解释。这个改动很小，在构建 `candidatesForPrompt` 处加一个字段即可。
- 前端 `results.tsx` 不做强制改动；如果想给重复店加个小 tag 可后续单独提。

## 不做的事

- 不引入名称/地址模糊匹配——`placeId` 已经够。
- 不改 `searchPlaces` 召回阶段——召回照旧按品类分别请求，保证每个品类的召回多样性。
- 不改 `cuisineLevelConstraints` / 推断 cuisines 的逻辑。
- 不改前端 UI（除非你想要"重复品类"小标签）。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| winner 规则选错品类，导致用户在期望的品类下看不到这家店 | `matchedCuisines` 保留全集 + log 打印；UI 后续可加二级标签 |
| 兜底品类 `["餐厅"]` 吃掉所有候选 | 归属规则里兜底品类降到最低优先级 |
| 健康检查触发 | 直接 throw / pushWarn，迅速暴露而不是静默丢店 |

## 待你确认

- "归属品类"的 4 条优先级你是否接受？尤其是第 3 条 **"稀有品类优先"** 要不要放进去——它和第 1 条强匹配可能偶尔打架。如果你只想要简单规则，可以只保留 **1 → 4**（强匹配 → 用户顺序），更可预测但偶尔会让候选数严重不均。
