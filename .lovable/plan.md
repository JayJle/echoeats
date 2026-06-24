## 重跑 brunch 用例并输出结果

不改代码，只在 sandbox 里调用当前 `extractEchoIntent` server function，跑用户这段 brunch 文本，把 Stage A 原始项、Stage B 聚类轨迹、Stage C 最终输出全部打印出来。

### 步骤
1. 通过 Playwright 在 `localhost:8080` 注入 `localStorage('echo-eats-lang','zh')` 和 `sessionStorage('echo-eats-query', <这段文本>)`，触发现有提取流程。
2. 抓取 server function 日志（`[Echo/extractRawItems]`、Stage B clusterTrace、mergedCount、最终 intent JSON）。
3. 按以下分组回报给用户：
   - `visitTime` / `cuisines` / `dishPreferences`
   - `hardFilters`（A1 档次、A3 环境、A4 服务、A5 菜品出品、A6 评分≥4.0）
   - `softPreferences`（A6 评分≥4.3、A8 社区/富人区）
   - `negativeFilters`（不豪华、不低端 — 期望与 A1 合并成 1 条档次）
   - clusterTrace：每个簇的 winner snippet + 合并了哪些原始项
4. 标注是否符合上一轮约定的子维度分桶规则；若仍有跨维度错合并或 winner 选弱，明确指出。

### 不做
- 不改 `echo.functions.ts` / prompt
- 不改 UI
- 仅运行 + 报告
