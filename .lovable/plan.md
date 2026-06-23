## 背景

用户强调："去重只是去重，不能因为去重把本来存在的餐厅删掉。"

## 当前实现复核（src/lib/echo.functions.ts 1704-1751）

- 每个 `placeId` 在 `bestByPid` 里**必然**被赋一个归属品类（首次遇到走 `!prev` 分支无条件写入）。
- 过滤时只删除"不属于该品类"的副本，归属品类那一份保留。
- 结论：一家店原本出现 N 次 → 去重后恰好剩 1 次；原本只出现 1 次 → 不动。**任何餐厅都不会因去重而消失。**

## 计划：加一道防御性自检

在去重块末尾追加一段 sanity check，确保未来代码改动也不会引入"误删"：

```ts
const uniqueBefore = new Set<string>();
for (const r of placeResultsBeforeDedup) for (const p of r.places) uniqueBefore.add(p.placeId);
const uniqueAfter = new Set<string>();
for (const r of placeResults) for (const p of r.places) uniqueAfter.add(p.placeId);
if (uniqueAfter.size !== uniqueBefore.size) {
  const missing = [...uniqueBefore].filter((id) => !uniqueAfter.has(id));
  console.error(
    `[Echo/places] DEDUP BUG: ${missing.length} place(s) lost during dedup`,
    missing.slice(0, 10),
  );
}
```

实现细节：
- 在进入去重块前先把 `placeResults` 的引用快照成 `placeResultsBeforeDedup`（浅引用即可，去重是 `.map` 生成新数组，旧引用不受影响）。
- 用 `console.error` 而非抛错——不阻断生产流程，但日志里立刻能发现。

## 不动的部分

- 归属选择规则（routeHits → rank → cuisineIdx）保持不变。
- 8 路召回、POOL_CAP=30、AI prompt 链路全部不动。

## 预期效果

- 行为完全不变（当前实现已经满足"不删店"原则）。
- 多了一道防御日志，任何后续修改若不小心删掉店会立刻在控制台报警。
