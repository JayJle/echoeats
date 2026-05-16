## 现状

`searchRestaurants` 是一个 `createServerFn`（一次性 POST → 一次性 JSON 响应）。整个流程在一个请求里串行/并行完成：

1. cuisine 扩展（每个料理 1 次 AI 调用）
2. Google Places 搜索（每料理 1-3 query × 每 query ~1s）
3. Perplexity 网评（每候选 1 次，最多 10×料理数，每次最多 20s）
4. Tabelog 抓取（日本，并发 8，每次最多 20s）
5. Gemini 最终排序（一次大 prompt，5-20s）

深度搜索 + 多料理 + 日本场景下总耗时常 **60-120 秒**。

「Timeout」实际命中的是 **Cloudflare Worker 单请求的响应时长上限**（Lovable 部署在 workerd 上，单个非流式 HTTP 响应大约 ~100s 就会被边缘网关切断），而不是代码里的 20-30s `AbortController`——后者只是单次上游调用的超时，单个失败会被 `Promise.allSettled` 吞掉，不影响主流程。

所以「再加长 setTimeout」**解决不了**问题，必须让响应在长时间内持续有数据流出，或者把任务从请求里搬出去。

## 方案对比

| 方案 | 改动量 | 用户体验 | 能撑多久 |
|---|---|---|---|
| A. 把 `searchRestaurants` 改成 **流式 async generator**，分阶段 `yield` 进度块 | 中（只改 1 个 serverFn + requirements.tsx 的 await 改 for-await） | 进度条变成真实进度（候选数、网评进度、最终结果），无 timeout | 只要客户端不断网，理论无上限（实测 5-10 分钟稳定） |
| B. **任务队列**：serverFn 入队 → 返回 jobId → 后台 worker（cron 每 10s）处理 → 前端轮询 `/api/public/jobs/:id` | 大（新表、新 cron、新轮询页、状态机） | 可关闭页面再回来看，最稳 | 无限 |
| C. 仅放宽各上游 `AbortController` 到 60-90s + 适当降低并发 | 小 | 不解决根因，仍会撞 Worker 100s 墙 | 无效 |

## 推荐方案：A（流式 serverFn）

TanStack Start 的 `createServerFn` 原生支持 `async function*` handler，每 `yield` 一段 JSON，客户端用 `for await` 逐段消费。只要中途持续有 chunk 流出，Worker/CF 边缘就不会判超时。这正是 Lovable 的 AI 流式聊天用的同一套机制。

### 代码改动（最小集）

**`src/lib/echo.functions.ts`**：

把 `searchRestaurants` 从 `.handler(async ({data}) => {...})` 改成 `.handler(async function* ({data}) {...})`，在关键阶段 `yield`：

```ts
yield { type: "stage", stage: "places", message: `搜索 ${data.city} 候选…` };
// …Google Places 调用…
yield { type: "stage", stage: "places-done", count: totalCandidates };

yield { type: "stage", stage: "reviews", total: tasks.length };
// 在 reviews 循环里：每完成一个就 yield 一次心跳
for (const t of tasks) {
  const r = await t;
  done++;
  yield { type: "review-progress", done, total: tasks.length };
}

yield { type: "stage", stage: "rank" };
// …Gemini ranking…
yield { type: "result", payload: finalSearchResponse };
```

返回类型保持现在的 `SearchResponse` 不变（包在最后一个 `{type:"result", payload}` 里）。

**`src/routes/requirements.tsx`**：

```ts
let finalResp: SearchResponse | null = null;
for await (const chunk of await searchFn({ data: parsedWithMode, signal: ac.signal })) {
  if (chunk.type === "stage") setCurrentStage(mapStage(chunk.stage));
  if (chunk.type === "review-progress") setReviewProgress(chunk);   // 可选：真实进度
  if (chunk.type === "result") finalResp = chunk.payload;
}
if (finalResp) { setResults(finalResp); navigate({to:"/results"}); }
```

附带删掉现在那套 `setTimeout(()=>setCurrentStage("reviews"), 3000)` 的伪进度——改成由后端真事件驱动。

**`src/routes/results.tsx`** 里的「换一批」「再搜一次」同理改 `for await`。

### 注意点

- `yield` 的对象必须可 JSON 序列化（已是普通对象，OK）。
- generator 的 `finally` 块要 `controller.abort()` 所有挂起的 fetch，防止客户端断开时上游继续跑。
- 现有所有 `setTimeout(..., 20000)` 之类的单次上游超时**不动**，它们是必要的熔断。
- `searchRestaurants` 内部的 `return { groups: [], error: "..." }` 改成 `yield { type:"result", payload: {...} }; return;`。

## 不动的部分

- 大众点评 / Tabelog / Perplexity / Google Places 调用本身
- ParsedSchema、RestaurantSchema、UI 组件结构
- 鉴权、Supabase、CSS、路由

## 不做方案 B 的理由

队列方案要新建数据库表、cron、状态机、前端轮询页，且本质上是为「关掉浏览器还能回来」服务的——当前 UX 是用户盯着进度条等结果，流式方案体验更直接、改动量小一个数量级。如果以后要做「后台跑、邮件通知」再切 B。
