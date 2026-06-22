# 提速方案：Yelp 并发提升 + 候选瘦身 + 进度数字

只改 `src/lib/echo.functions.ts`。前端、评分、AI prompt 都不动。

## 改动 1：Yelp 并发 8 → 16

第 1548 行：
```ts
const CONCURRENCY = 8;
```
改为：
```ts
const CONCURRENCY = 16;
```

Perplexity 调用是纯网络 I/O，单条 ~1–2s，提并发对延迟近似线性减半。429 单点已经被 `try/catch` 兜住，不会拖垮整组。

## 改动 2：Yelp 只富化"会进入 AI 排序"的候选

当前 `allTargets` 把 `placeResults` 全量塞进去（这次 ~80 条），但 AI rank 阶段 `BATCH_SIZE = 12` 每组只取头部，多余的富化纯属浪费。

在第 1543–1546 行构造 `allTargets` 时，按 cuisine 先取头部 N 个，N 与下游 batch 对齐（取 12，覆盖一个 batch 用量，留一点冗余）：

```ts
const YELP_PER_CUISINE = 12;
const allTargets: { p: PlaceCandidate; cuisine: string }[] = [];
for (const r of placeResults) {
  // 简易排序：rating × log(reviews+1)，缺数据的放后面
  const ranked = [...r.places].sort((a, b) => {
    const sa = (a.rating ?? 0) * Math.log((a.userRatingCount ?? 0) + 1);
    const sb = (b.rating ?? 0) * Math.log((b.userRatingCount ?? 0) + 1);
    return sb - sa;
  });
  for (const p of ranked.slice(0, YELP_PER_CUISINE)) {
    allTargets.push({ p, cuisine: r.cuisine });
  }
}
```

> 注意：`PlaceCandidate` 上的评分字段名以当前文件实际为准（可能是 `rating` / `userRatingsTotal` / `userRatingCount`），落地时读一下定义再写。

预期候选量 80 → ~40，叠加并发提升后 Yelp 阶段 **71s → 15–20s**。

## 改动 3：心跳带进度数字（rank 阶段）

第 1924–1940 行包裹 AI rank 的 `withHeartbeat(...)` 改为按组完成时主动 yield 进度。把 `Promise.all(...)` 换成一个并发执行 + 完成计数器的小工具，每完成一组就 `yield { type: "stage", stage: "rank", done, total }`。

伪代码：
```ts
const total = candidatesForPrompt.length;
let done = 0;
yield { type: "stage", stage: "rank", done: 0, total };

const tasks = candidatesForPrompt.map(async (group) => {
  // ...原有 batch + rankOneGroup 逻辑...
  const result = { cuisine: group.cuisine, picks: batchPicks.flat() };
  done++;
  return result;
});

// 用一个 channel/queue 把每个 settle 转成 yield；最简实现：
const groupResults = yield* withHeartbeatProgress(tasks, "rank", () => ({ done, total }));
```

最小代价做法（不动 generator 框架）：
- 把现有 `withHeartbeat(Promise.all(...), "rank")` 替换成 `withHeartbeat(Promise.all(...), "rank", () => ({ done, total }))`
- 在 `withHeartbeat` 中每次心跳 tick 调用回调，把 `done/total` 塞进 stage 事件

前端 `results.tsx` 如果当前是忽略 `stage.done`，**这一项纯加字段不影响展示**；如果将来想做进度条，字段已经在了。

## 不做的事

- AI rank 改流式（要前端配合，单独一轮）
- 评分公式 / prompt / fallback 链路
- Places 召回数量

## 预期效果

| 指标 | 改前 | 改后 |
|---|---|---|
| Yelp 阶段 | ~71s | ~15–20s |
| AI rank | ~30–60s | 不变 |
| 端到端 | ~100–130s | **~45–80s** |
| 进度反馈 | 只有空心跳 | rank 阶段有 `done/total` |

## 验证

部署后跑一次相同 query（St. Louis + 多菜系），看 worker 日志：
- `[Yelp] hit X/Y` 的 Y 应从 ~80 降到 ~40
- 时间戳差应从 71s 降到 ~20s
- `[Echo/AI-rank] all N group(s) done in Xms` 不变
