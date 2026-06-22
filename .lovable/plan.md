## 目标

把 Tabelog（JP 分支）/ Yelp（非 JP / 英文与其他海外地区分支）两段 Perplexity 调用的 prompt 换成你给的新版本（增加 `signals[]` 隐藏信号字段、强调"压信息进 signals 而不是堆 summary"），并把上下游打通，让 AI 排序能拿到 signals 做更准确的 pros/cons。前端展示层不动 —— signals 是**后台隐藏字段**。

## 分区域说明

- **Tabelog prompt**：仅日本城市（city 解析为 JP）走，system/user prompt 全中文；signals 每条 ≤35 中文字。
- **Yelp prompt**：日本以外（北美/欧洲/东南亚等）走，system/user prompt 在英文地区输出英文 signals（≤15 words/条），非英文地区输出中文 signals（≤35 字/条），由 `isEn` 入参决定。
- 两条管线相互独立：同一家餐厅不会同时跑 Tabelog 和 Yelp（按 country 分流）。

## 差异分析

### Prompt 修改前 vs 修改后
| 维度 | 旧版 | 新版（你的） |
|---|---|---|
| 输出字段 | rating / reviewCount / url / price / **summary** | 同左 + **signals[]**（≤8 条） |
| 摘要策略 | 1-2 句 ≤60 字 summary 承担全部信息 | summary 缩到 1 句，**高价值信息压进 signals**（招牌菜/口味/服务/氛围/价格/排队/场景/负面） |
| Few-shot | 无 | 有正例 + 反例（不匹配返回全 null） |
| 不匹配语义 | 文字描述 | 显式给反例 + Yelp 的 verifyMode 明确"不匹配 → url 也 null" |
| Token 预算 | sonar 400 / sonar-pro 700 | 需上调（signals 8 条 ≈ 280 字额外输出） |

### 用户视角 vs 你（开发）视角
- **前端用户视角**：完全无变化。卡片只显示 summary、rating、价位、链接。signals 不渲染。
- **AI 排序视角**：候选 JSON 多了 `tabelogSignals` / `yelpSignals` 两个数组。AI 生成 pros/cons 和 aiSummary 时能直接引用具体菜名和真实评论事实，而不是从一句 summary 里再"挤"信息 → pros/cons 更具体、less hallucination、排序更稳。
- 同样的 token 成本（略涨），让真正能用上结构化评论事实的 AI 排序拿到 5–8 倍密度的信号；前端的轻量感不变。

## 实施步骤（4 个文件）

### 1. `src/lib/tabelog.server.ts`
- `TabelogInfo` 类型加 `signals: string[]`
- 替换 system prompt + Stage 1 user prompt + Stage 2 user prompt 为你给的新版本（保留现有 `${name}/${address}/${city}/${area}/${cuisine}/${preUrl}` 插值）
- `response_format.json_schema` 加 `signals: { type: "array", items: { type: "string" } }` 到 properties + required
- `max_tokens`：stage 1 `400 → 700`，stage 2 `700 → 1100`
- `parseStage` 解析 signals：仅接受字符串数组；每条 `trim().slice(0, 35)` 过滤空串；整体 `slice(0, 8)`；读不到 → `[]`
- 日志加 `signals=${n}`

### 2. `src/lib/yelp.server.ts`
- 同上：`YelpInfo` 加 `signals: string[]`
- 替换 system + Stage 1/2 prompt（保留 `verifyMode` 分支与 `isEn` 语言切换）
- json_schema 加 signals
- max_tokens 同上调
- parseStage 解析逻辑同上，长度上限统一用 `slice(0, 80)` 兜底（prompt 已经约束语言/字符数）

### 3. `src/lib/echo.functions.ts` —— 下游 AI 排序也要改

**A. 候选构建（~1567-1604 行）**
- 把 `signals` 从 TabelogInfo/YelpInfo 透传到内部 `tabelog`/`yelp` 对象（仅在 server 端使用）
- **不**写进 `RestaurantSchema`，避免污染返回给前端的数据

**B. AI 排序 candidate JSON（构造 group.candidates 处）**
- 给每个候选额外注入 `tabelogSignals: string[]` 和 `yelpSignals: string[]` 顶层字段（与 tabelog/yelp 对象并列），方便 AI 直接读到

**C. AI 排序 system/user prompt（~1713-1723 pros/cons 写作规范段）**
需要新增两条规则：

1. 数据源说明那段（1716 行附近）补一句：
   > `tabelogSignals` / `yelpSignals` 是已经从 Tabelog/Yelp 评论里**预提炼好的真实要点**（招牌菜/口味/服务/氛围/价格/排队/场景/负面），可以直接作为 pros/cons 的事实依据使用，**优先级高于** googleReviews 原始文本片段。

2. aiSummary 写作规则补一句：
   > 写 aiSummary 时如果 tabelogSignals/yelpSignals 非空，应优先从中挑 1–2 条最相关的具体事实点（如招牌菜、典型氛围）融入，不要重复 tabelog.summary 或 yelp.summary 原文。

3. 反幻觉规则补一条：
   > signals 数组是**已核验**的结构化事实；pros/cons 引用 signals 内容时无需再标注 source 之外的依据。但**不要**把 signals 原文当成 cons 的"差评"，除非该条本身就是负面表述（如"价格偏高 / 排队久 / 不适合大人数"）。

**D. 极简兜底（~1747-1762 行）**
除截短 summary 外，**signals 整段丢弃**（`tabelogSignals: [], yelpSignals: [], tabelog.signals 删掉`），优先保证不超 token。

### 4. 不动
- `src/lib/store.ts` — Restaurant 类型不暴露 signals
- `src/routes/results.tsx` — 不展示 signals
- `src/integrations/supabase/types.ts` — 不入库

## 完成后

我会把改完的两段 prompt（拼好的实际样例字符串）+ AI 排序 prompt 里新增的那 3 条规则，贴给你过目，再确认无误。

## 一个待你确认的点

`max_tokens` 我建议 stage1 → 700、stage2 → 1100。如果想更省 token，可改成 stage1 → 600、stage2 → 900（signals 可能被截到 5–6 条）。要哪个？
