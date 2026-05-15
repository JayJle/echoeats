
# 在搜索过程中加「取消」按钮

## 目标
用户在 ① 深度/快速搜索(`/requirements`)和 ② 结果页"应用并重新搜索" / "↻ 再次搜索"(`/results`)期间,可以随时点取消,立刻退出 loading 状态、丢弃即将返回的结果、不跳转。

## 取消的语义(说人话)
- **客户端**:立刻 abort 当前 fetch(浏览器层会切 TCP),UI 立刻恢复可用、清空进度条,后续返回的数据全部忽略。
- **服务端**:本次请求在 worker 上可能还会跑完一两秒(因为后端 server function 内部已经在并发抓 Google/Perplexity/Tabelog,中途的子请求不会回头取消)。这部分用户感知不到,只是浪费一点配额。**不改后端**,因为改造成贯穿式 `AbortSignal` 传递改动面太大、收益小。

## 实现

### 共用机制:AbortController + 请求代次 id
两道保险:
1. `new AbortController()`,把 `signal` 透传给 `parseFn` / `searchFn` 调用(`useServerFn` 调用支持 `{ data, signal }`,fetch 会被取消)
2. 每次开始搜索时 `runIdRef.current++`,记下本次 `myRunId`;promise resolve 后比对,若 `myRunId !== runIdRef.current` 说明已取消,直接 `return`,不写 store、不跳转

第 2 点是兜底,即使 abort 没把 promise reject 掉,陈旧结果也不会污染状态。

### `src/routes/requirements.tsx`
- 新增 `abortRef = useRef<AbortController | null>(null)` 和 `runIdRef = useRef(0)`
- `runSearch` 开头:`runIdRef.current++; const myRunId = runIdRef.current; const ac = new AbortController(); abortRef.current = ac;`
- 调用改成 `parseFn({ data, signal: ac.signal })` / `searchFn({ data, signal: ac.signal })`
- 每次 await 后 `if (myRunId !== runIdRef.current) return;` 提前退出
- catch 里识别 `err.name === "AbortError"` 或 signal aborted → 不显示错误、静默退出
- 新增 `handleCancel`:`abortRef.current?.abort(); runIdRef.current++; clearTimers(); setLoading(false); setCurrentStage(null); setError(null);`
- UI:在进度卡片右上角加一个小 `取消` 按钮(`variant="ghost" size="sm"`),loading 期间显示
- 卸载 effect 里也调用 `abortRef.current?.abort()`(避免离开页面后回调还在跑)

### `src/routes/results.tsx`
两个调用点都加同样机制:
- `runSearchAgain`(顶栏「↻ 再次搜索」):新建 controller,传 signal,加请求代次守卫
- `applyEdit`(框内「应用并重新搜索」):同上
- `handleCancel`:abort + 代次自增 + `setRefining(false)` + 清错误
- UI:
  - 全屏 refining 蒙层里的卡片增加一个「取消」按钮
  - 内嵌编辑区里,refining 时把现有「应用并重新搜索」按钮文案/状态保持,旁边的「取消」按钮在 refining 期间从"取消编辑"变为"取消搜索"(共用同一个按钮,根据 `refining` 切换 onClick 和文案)

## 不做的事
- 不改 `src/lib/echo.functions.ts`、不改其他 server function 签名
- 不在服务端传播 abort 信号到 Google Places / Perplexity / Tabelog 子请求(改造面太大)
- 不引入新依赖
- 不改 store schema

## 风险与注意
- TanStack Start 的 `useServerFn` 调用约定是 `(opts: { data, signal? })`;如果运行时不接受 `signal`(传错被忽略),代次 id 兜底依然能保证 UI 正确性,只是 fetch 不会被真的中断。我会先按文档传 signal,无效再退化为只用代次 id。
- abort 抛出的 Error 在不同 runtime 名字不同(`AbortError` / `DOMException`),catch 里用 `ac.signal.aborted` 直接判断更稳。
