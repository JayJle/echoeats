## 问题

所有店的高频好评只显示「匹配当前搜索方向」、高频差评只显示「请到 Google Maps 确认最新营业时间」。

## 根因

上一轮反幻觉改造里，prompt 已经要求 AI 在没有可信网评时 **必须返回空 pros/cons 数组**。但 `src/lib/echo.functions.ts` 第 843–844 行仍保留了旧的占位兜底：

```ts
pros: pick.pros.length ? pick.pros : ["匹配当前搜索方向"],
cons: pick.cons.length ? pick.cons : ["请到 Google Maps 确认最新营业时间"],
```

于是 AI 老老实实返回 `[]`，前端却被这两条假数据覆盖，导致每张卡片看起来都一样、且和"绝对禁止编造"的承诺自相矛盾。

另外 `src/routes/results.tsx` 里 `r.pros.map / r.cons.map` 在数组为空时不会渲染任何内容，也没有"暂无网评"提示，用户会以为是 bug。

## 修复

### 1. `src/lib/echo.functions.ts` (第 843–844 行)

直接透传 AI 返回的真实数组，不再注入占位：

```ts
pros: pick.pros,
cons: pick.cons,
```

### 2. `src/routes/results.tsx`「高频好评 / 高频差评」区块

当 `r.pros.length === 0` 或 `r.cons.length === 0` 时，渲染一行灰色小字：

- 好评空 → `暂无可信网评`
- 差评空 → `暂无明显差评` （或同上文案，二选一）

如果两边都为空，整个 grid 仍然渲染（保持卡片高度一致），只是各自显示"暂无"。

## 不动的部分

- AI prompt 不改（已经在反幻觉那一轮定型）
- `dianping.server.ts` 不动
- 卡片其它区域（AI 总结、匹配详情、Ratings）不动

## 预期效果

- 有真实网评的店：显示真实的好评/差评要点
- 没有可信网评的店（小城市/冷门料理）：显示"暂无可信网评"，与 AI 总结末尾的"（暂无可信网评，仅基于 Google 数据）"前后一致，用户一眼能看懂为什么这家没有评论摘要