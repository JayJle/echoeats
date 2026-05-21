## 现状盘点（按调用链）

| 阶段 | 调用 | 失败重试 | 降级 | 用户感知 |
|---|---|---|---|---|
| 1. 需求解析 | Lovable AI Gateway (`parseRequirements`) | ✅ 二次解析 + forceInfer 重试 | ✅ 兜底空结构 | ✅ 已较稳 |
| 2. 品类扩展 | `cuisine-expand` (LLM) | ❌ 单次 | ⚠️ catch 后静默退回原 cuisines | 用户不知道扩展失败 |
| 3. Google Places 文本搜索 | `places:searchText` | ❌ 单次，非 200 直接 throw | ❌ 整条搜索 500 | **整页报错** |
| 4. Google Places 照片解析 | `/v1/{name}/media` | ❌ 单次 | ⚠️ 失败写入 `null` 缓存毒化 | 静默无图 |
| 5. Tabelog / Yelp / 大众点评 | Perplexity / Firecrawl | ❌ 单次，非 200 warn 后返 null | ✅ 单条返 null 不影响整体 | 静默缺数据 |
| 6. AI 排序 | Lovable AI Gateway | ✅ 三级降级（Output.object → raw → slim） | ✅ 全失败返 `aiRankFailed` 标记 | ✅ 已较稳 |
| 7. 语音转写 | ElevenLabs STT | ❌ 单次，错误抛 500 | ❌ | 录音白丢 |

**结论**：解析 + 排序两端已有重试/降级，**中间 5 个外部依赖几乎都是单次调用**。最致命的是阶段 3（Places 文本搜索）—— 一旦 429/5xx 整个搜索结果页直接红屏。

## 改造方案

### A. 统一的 `withRetry` 工具（新文件 `src/lib/retry.server.ts`）

```ts
withRetry(fn, {
  retries: 2,             // 共 3 次
  baseMs: 400,            // 指数退避 400 / 800 / 1600 + 抖动
  shouldRetry: (e) => /* 5xx / 429 / fetch failed / AbortError */,
  timeoutMs: 12000,       // AbortController
  label: "places.search",
})
```

- 只对**幂等 + 可重试**错误重试（5xx、429、网络层）；4xx 不重试。
- 每个 fetch 包 `AbortSignal.timeout`，避免上游 hang 死 worker。
- 统一日志前缀 `[retry:<label>]`，便于检索。

### B. 各阶段接入

| 阶段 | 接入 | 失败降级 |
|---|---|---|
| Places 搜索 | retries=2, timeout=10s | 该 cuisine 标 `searchFailed`，**其它 cuisine 继续** |
| Places 照片 | retries=1, timeout=6s；**仅成功才写缓存** | 单张失败 → `<img onError>` 切占位卡 |
| Tabelog/Yelp/大众 | retries=1, timeout=15s | 保持现状（返 null） |
| cuisine-expand | retries=1 | 失败时前端 toast「品类扩展未生效」 |
| transcribe | retries=1, timeout=20s | 失败返 4xx + 文案，前端 toast 提示重试 |

### C. 把"局部失败"做成用户可见、可重试的一等公民

`SearchResults` 新增：

```ts
warnings: Array<{
  stage: "places" | "tabelog" | "yelp" | "dianping" | "ai-rank" | "cuisine-expand";
  cuisine?: string;
  message: string;       // 已 i18n
  retryable: boolean;
}>;
```

`results.tsx` 顶部渲染可关闭 `<Alert>`：

> ⚠️ 部分数据源未返回结果（Google Maps × 1）。[仅重试失败项] [查看现有结果]

新增 server fn `retryFailedStages({ parsed, failedStages })`，**只跑挂掉的几段**并 merge 回 store —— 避免因为一个 cuisine 挂了被迫整页重搜（贵又慢）。

### D. 全局兜底

- `echo.functions.ts` 顶层 try/catch：任何未捕获异常 → 返 `{ groups: [], error, warnings, suggestions }`，**不再向上 throw**。
- `results.tsx` 渲染友好降级页 + 「重试」按钮（`router.invalidate()`）。

### E. 可观测性

- `withRetry` 每次重试与最终失败写 `[retry:places.search] attempt=2/3 status=503 ms=812`。
- 每阶段结束写一行汇总：`[stage:places] cuisines=3 ok=2 failed=1 ms=4210`。

## 不做（明确范围）

- 不引外部重试库（自实现 ~40 行）。
- 不做跨请求持久化熔断（worker 无共享内存）。
- 不动 AI 排序已有的三级降级。
- 不动 i18n 文案外的 UI 样式与 design token。

## 文件清单

- 新增 `src/lib/retry.server.ts`
- 改 `src/lib/google-places.server.ts`（搜索/照片 + 缓存仅成功写）
- 改 `tabelog.server.ts` / `yelp.server.ts` / `dianping.server.ts` / `cuisine-expand.server.ts`
- 改 `src/routes/api/transcribe.ts`
- 改 `src/lib/echo.functions.ts`（warnings、顶层 catch、`retryFailedStages`）
- 改 `src/routes/results.tsx`（warnings Alert + 重试按钮）
- 改 `src/lib/i18n/dict.ts`（中英文案）

## 验证

1. 临时把 `GOOGLE_PLACES_API_KEY` 改错 → 不再红屏，顶部 Alert 提示，其它源仍渲染。
2. `resolvePhotoUrl` 注入 50% 失败 → 重试一次仍失败则切占位；**刷新后能拿到图**（验证未毒化缓存）。
3. 模拟 transcribe 上游超时 → 12s 内返错误 toast，worker 不 hang。
4. `server-function-logs --search "[stage:"` 能看到每次搜索的阶段汇总。

---

## 方案白话版（给非技术用户）

我们的搜索结果页背后要调好几个外部服务：Google 地图、Tabelog、Yelp、大众点评、AI 排序、语音识别等。现在的问题是——**这些服务任何一个偶尔抽风，要么整页变成红色错误，要么静悄悄少了一块内容你完全不知道**。

这次改造做三件事：
1. **失败自动重试**：网络抖动 / 服务繁忙时，自己悄悄重试 2 次（间隔 0.4 → 0.8 → 1.6 秒），通常用户根本察觉不到就好了。
2. **设定超时上限**：每个外部调用最多等 10-20 秒，避免你盯着加载圈半分钟最后还是失败。
3. **失败也别藏着**：万一真的有数据源彻底挂了，结果页顶部会出现一条黄色提示「Google 地图本次没返回，其它结果照常」，并且**只重试挂掉的那一块**，不用整页重搜。

## 用户视角的变化

| 场景 | 现在 | 改造后 |
|---|---|---|
| Google 服务偶尔 503 | 整页红色报错，要重头搜 | 用户基本无感（自动重试成功）|
| Google 真的挂了 | 整页报错 | 顶部黄条 + 其它品类的结果照常显示，一键「重试失败项」|
| 某家店的图加载失败 | 永远空白（缓存毒化，刷新也没用）| 切到"图片搜索"占位卡，刷新能恢复 |
| 语音识别上游卡死 | 录音白录、按钮一直转 | 最多 20 秒后弹 toast「识别失败，请重试或手动输入」|
| 大众点评/Yelp 偶尔没数据 | 没提示，用户以为这家就是没数据 | 顶部黄条注明「大众点评本次未返回」|

## 成本与副作用

**成本变化**：基本可忽略。
- 重试只在失败时触发，正常路径**调用次数不变**。
- 即使全部触发到第 3 次，外部 API 总调用量上限是原来的 3 倍，但实际触发率通常 < 5%，预估月度成本 +1~3%。
- 「仅重试失败项」按钮反而**省钱**——以前用户遇到错误会整页刷新（重跑所有 cuisine），现在只重跑挂掉的那一段。

**延迟变化**：
- 成功路径：**0 额外延迟**。
- 失败路径：最坏情况比现在多等约 3 秒（两次退避之和），但换来的是成功率明显提升，整体体验更顺。
- 超时上限实际上**减少了**最坏延迟（以前可能干等 60 秒，现在 10-20 秒就放弃）。

**潜在负面影响 / 风险**：
1. 外部服务真的全面宕机时（如 Google 大故障），重试反而会让我们的响应更慢（多花 ~3 秒才报错）—— 已用超时控制兜底，可接受。
2. 黄色警告条多了一个视觉元素，可能让少数用户觉得"是不是出问题了"—— 文案会写得克制（「部分数据源本次未返回，已为你显示其它结果」），并可关闭。
3. 新代码增加约 200 行，主要在 `retry.server.ts` 和各 server 文件里，维护成本可控。
