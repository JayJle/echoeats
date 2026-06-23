## 目标
当前 `src/lib/echo.functions.ts` 里只有 AI-verify / AI-copy / score / tabelog / yelp 等几个节点有日志，且格式不统一，缺少"开始时间、耗时、是否失败、输入输出关键指标"的全链路视图。本次只补**日志**，不动业务逻辑、不动 schema、不动 UI。

## 日志规范（统一前缀）
- 统一前缀：`[Echo/<stage>]`
- 三段式：`start`（关键输入） → `ok in Xms`（关键输出指标） → `failed in Xms: <reason>`
- 时间一律毫秒；关键指标用 `key=value` 格式便于 grep
- 错误既打 `console.error` 也保留 message，便于在 worker logs 里 `grep "[Echo/" | grep failed`

## 要补/完善的节点

| Stage | 现状 | 要补的字段 |
|---|---|---|
| `parseRequirements` | 仅失败时 warn | `start` + `ok in Xms cuisines=… budget=… diet=…`；fallback 命中标记 |
| `places` (Google Places 召回) | 只有 per-cuisine `[recall]` | 节点级 `start cuisines=N` / `ok in Xms total=… perCuisine={…}` |
| `rules-prefilter` | 已有计数 | 补 `in Xms` |
| `visitTime` 过滤 | 已有 removed | 补 `in Xms remaining=…` |
| `tabelog` / `yelp` 富化 | 已有 hit 数 | 补 `start total=N` / `ok in Xms hit=H miss=M errors=E` |
| `AI-verify` per group | 有 ok/failed/ms | 加 `start candidates=N`；批次维度日志（B/Btotal）|
| `AI-verify` 汇总 | 有 group 总耗时 | 加 `groups=… picksTotal=… failedGroups=…` |
| `score` per cuisine | 有 pool/admitted/avg | 节点级 `[Echo/score] all done in Xms groups=…` |
| `AI-copy` per group | 有 ok/failed/ms | 加 `start picks=N`；汇总加 `failedGroups=…` |
| `AI-copy` 汇总 | 有总耗时 | 加 `picksFilled=… picksMissed=…` |
| `photos` | 无 | `start restaurants=N` / `ok in Xms urls=…` |
| 总线 | 无 | `[Echo/pipeline] start` 在入口；`[Echo/pipeline] done in Xms stages=…` 在末尾；异常路径打 `failed in Xms at <stage>` |

## 实施步骤
1. 在 `echo.functions.ts` 文件顶部新增一个小工具（不导出）：
   ```ts
   const echoLog = {
     start: (stage: string, extra?: Record<string, unknown>) => { … console.log },
     ok:    (stage: string, ms: number, extra?: …) => { … },
     fail:  (stage: string, ms: number, err: unknown, extra?: …) => { … console.error },
   };
   ```
   统一拼接 `[Echo/<stage>] start key=val …` 等格式。
2. 按上表逐个节点：
   - 在节点开始处记录 `const t0 = Date.now()` 并 `echoLog.start(...)`
   - 在节点正常结束处 `echoLog.ok(stage, Date.now()-t0, {...指标})`
   - try/catch 里 `echoLog.fail(...)`，不吞错误
3. 入口（`searchRestaurants` generator 顶部）加 `[Echo/pipeline] start lang=… cuisines=…`；末尾 `done in Xms`；既有 catch 里追加 `failed at stage=<current>`（用一个游标变量记录当前 stage）。
4. 不改任何 yield 出去的 `stage` 事件、不改前端、不改 schema。

## 验收
- 运行一次完整搜索，复制 worker logs，按 `[Echo/` grep 应能看到：pipeline → parseRequirements → places → rules-prefilter → visitTime → tabelog → yelp → AI-verify(×groups) → score → AI-copy(×groups) → photos → pipeline done 的完整时间线。
- 任意一个 group 的 AI-verify 或 AI-copy 失败时，日志里能直接看到 "stage / cuisine / 耗时 / 错误信息"，无需再查上下文。

## 不做的事
- 不引入第三方 logger / OpenTelemetry
- 不改业务计算、不动 Prompt、不动 Schema
- 不新增前端可见 stage、不改心跳
