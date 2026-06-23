## 目标

同一家餐厅当前可能同时出现在多个品类候选池里（例如「拉面」「定食」「日本料理」都召回了同一家店），最终展示也重复。要在候选池构建阶段按 `placeId` 全局去重，每家店**只**留在最匹配的品类下。

## 归属判定规则（"最适合的品类"）

仅用已有信号，不引入新的 LLM/API 调用：

1. **首要分数**：该品类的多路召回中，命中了多少条 route（recall route tags 数量）。命中路数多 = 更贴合该品类。
2. **次要分数（同分时）**：该品类内按 `rating × log10(reviews+10)` 排序后的位次（位次越靠前越合适）。
3. **再同分**：保留先出现的品类（`placeResults` 数组顺序，与用户的 cuisines 顺序一致）。

## 改动点（src/lib/echo.functions.ts）

全部集中在一处，不动 prompt / AI 流程 / Tabelog / Yelp / 多路召回结构。

### 1) 让 recall route tags 可按 (cuisine, placeId) 查询

当前 `recallSourcesById: Map<placeId, string[]>` 在多个 cuisine 之间是**会被覆盖**的（每个 cuisine 迭代里 `recallSourcesById.set(pid, ...)`），后处理的 cuisine 会盖掉前一个。新增一个并行 map：

```text
recallSourcesByCuisine: Map<cuisine, Map<placeId, string[]>>
```

在现有 `for (const [pid, tags] of recallSourcesMap)` 旁，额外把这份 map 存进 `recallSourcesByCuisine.set(cuisine, new Map(recallSourcesMap))`。`recallSourcesById` 保持原状以免影响下游用到它的地方。

### 2) 在 `candidateGroups` 构建之前，做全局去重

在 `placeResults` 过滤 / POOL_CAP 之前插入一步 dedupe：

- 遍历 `placeResults`，对每个 `(cuisine, place)` 计算：
  - `routeHits = recallSourcesByCuisine.get(cuisine)?.get(place.placeId)?.length ?? 0`
  - `rank = ranked.indexOf(place)`（即在该品类按 rating×log(reviews) 排序后的位次）
- 用一个 `Map<placeId, { cuisine, routeHits, rank }>` 选出每个 placeId 的最佳归属（routeHits desc → rank asc → cuisine 出现顺序）。
- 重写 `placeResults`：每个 cuisine 的 places 过滤掉 "不是它"的 placeId。
- 加日志：`[Echo/places] dedup: X duplicates removed across cuisines (kept best-fit)`，并在 debug 级别列出每个被搬走的店 `place="..." from="A" → kept-in="B" (hitsA=.. hitsB=..)`。

### 3) POOL_CAP 之后保持原逻辑

去重在 POOL_CAP **之前**，这样某品类被搬走一些店后，剩下的尾部仍有机会进入前 30，不会被错误截断。

## 不动的部分

- 8 路召回（primary / recommend / synonyms×2 / dishes / scene / time / budget）保持。
- POOL_CAP = 30 保持。
- AI verify / score / copy 三段 prompt、batch size、Tabelog/Yelp、photos、quick mode 全部不动。
- `recallSourcesById` 保留，避免影响下游引用。

## 预期效果

- 结果列表不再出现"同一家店在多个品类卡片里重复"。
- Token：去重后进入 AI 的候选总数下降（重复店一律只算一次），对召回重复严重的搜索能再省一截。
- 召回质量：每家店去到它"被该品类多条 route 都命中"的那一组，符合用户"放到最适合的品类里"的直觉。
