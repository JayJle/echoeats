## 现状

文件：`src/lib/echo.functions.ts`，候选池构建段（约 L1358–1480）。

每个品类独立调用 `searchPlaces` 召回，每条召回路由的命中集合存在 `recallSourcesMap`。返回结构是：

```
placeResults: Array<{ cuisine: string; places: PlaceCandidate[]; error: string | null }>
```

不同品类之间没有去重。一家店同时属于「日本料理 / 寿司 / 怀石」时会被三个分组各召回一次，后续打分、Tabelog 调用、AI 排序都会重复处理。

## 目标

同一家餐厅在 `placeResults` 里**只能出现在一个品类分组**，且**不能因为去重导致候选丢失**（即被去重那一家整体仍保留，只是归到"最合适"那个品类里）。

## 设计原则

1. 跨品类去重必须在 `placeResults` 构建完成后、所有后续昂贵步骤（visitTime 过滤、规则初筛、Tabelog、AI 排序）之前进行，避免重复算力。
2. "最合适品类" 按可信度排序的判定（依次走，前一档分不出胜负才用下一档）：
   - **召回路由命中数**：本品类在召回阶段被多少条路由独立命中（`recallSourcesMap.get(placeId).size`）；越多越能代表这家店核心是这个品类。
   - **品类关键词命中数**：把这家店的 `name + primaryType + editorialSummary` 拿来匹配该品类 `CuisineExpansion` 的 `primary + synonyms`，命中条数越多越合适。
   - **原始品类顺序**：仍打平则按 `data.cuisines` 数组里的先后顺序，先出现的优先。
3. 选中归属品类后，从其它品类的 `places` 数组里移除这家店；place 本身**绝不丢弃**。
4. 整个过程只搬家，不删数据 —— 去重前后 `unique placeId 总数 == 去重后所有 places 拼起来的 placeId 数`，并打日志校验。

## 改动

文件：`src/lib/echo.functions.ts`

1. 在 `placeResults` 内部并行 map 的返回值里，**额外带出每个 placeId 在本品类下的召回命中数**：把 `recallSourcesMap` 转成 `Map<string, number>` 一并返回，例如 `{ cuisine, places, recallHits, error }`。
2. 在第 1478 行 `for` 循环之后、L1481 `totalCandidates` 之前，新增 `dedupeAcrossCuisines(placeResults, cuisineExpansions, data.cuisines)` 函数：
   - 收集所有 placeId → 出现在哪些品类、对应 recallHits、对应 expansion。
   - 对每个跨品类 placeId 按上面三档比较选出 winner cuisine。
   - 重新生成 `placeResults`：只在 winner cuisine 的 places 里保留该 place，其它品类移除。
   - 返回新 `placeResults`，并打印日志：
     - `[dedup-cross-cuisine] place="X" placeId=... candidates=[ramen(hits=3,kw=2), izakaya(hits=1,kw=0)] kept=ramen`
     - 汇总：`[dedup-cross-cuisine] uniquePlaces=N beforeTotal=M afterTotal=N removedDuplicates=M-N`
   - 兜底断言：`afterTotal === uniquePlaces`，不等就 `console.error` 并退回去重前的 `placeResults`，**永不丢店**。
3. 紧接着保留现有 `totalCandidates` 计算 —— 它会自然变成去重后的数字，下游不需要改。

## 不在本次范围

- 不改召回逻辑、不改品类扩展规则、不动 AI 排序与 Tabelog 调用。
- 不改 cuisine 分组在 UI 上的呈现顺序。
- 不引入新接口或新依赖。

## 验证

1. 用同一个城市跑一个含 3 个相邻品类的请求（例如东京 + 寿司/日本料理/怀石），日志应出现 `removedDuplicates > 0`，且：
   - `afterTotal === uniquePlaces` 断言通过。
   - 同一 placeId 在结果中只出现一次。
2. 跑一个完全不相干的多品类请求（例如东京 + 拉面/咖啡店），`removedDuplicates` 应为 0，候选数不变。
3. 跑一个单品类请求，函数应短路返回原 `placeResults`，无日志变化。
