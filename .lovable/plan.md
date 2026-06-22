## 目标

把 Tabelog（JP 分支）/ Yelp（非 JP 海外分支）两段 Perplexity 调用的 prompt 换成你给的新版本（增加 `signals[]` 隐藏信号字段、压信息进 signals 而不是堆 summary），并把下游 AI 排序打通。前端展示层不动 —— signals 是**后台隐藏字段**。

## 分区域

- **Tabelog**：仅 JP 城市；全中文 prompt；signals 每条 ≤35 中文字
- **Yelp**：JP 以外；`isEn=true` 时英文 signals（≤15 words/条），否则中文（≤35 字/条）
- 两条管线按 country 分流，互不重叠

## 差异分析

| 维度 | 旧 | 新 |
|---|---|---|
| 字段 | rating/reviewCount/url/price/summary | + **signals[]** ≤8 条 |
| 摘要策略 | summary 1-2 句 ≤60 字承担全部信息 | summary 缩到 1 句，信息压进 signals（招牌菜/口味/服务/氛围/价格/排队/场景/负面） |
| Few-shot | 无 | 正例 + 反例 |
| 不匹配 | 文字描述 | Yelp verifyMode 明确"不匹配 → url 也 null" |
| max_tokens | sonar 400 / sonar-pro 700 | **sonar 700 / sonar-pro 1100** |

**用户视角**：前端 0 变化。
**开发视角**：AI 排序候选 JSON 多出 `tabelogSignals` / `yelpSignals`，pros/cons 写作能直接引用结构化事实 → 更具体、更少幻觉。

## 实施（4 文件）

### 1. `src/lib/tabelog.server.ts`
- `TabelogInfo` 加 `signals: string[]`
- 替换 system + Stage1 + Stage2 user prompt 为你给的新版（保留 `${name}/${address}/${city}/${area}/${cuisine}/${preUrl}` 插值）
- `json_schema` 加 `signals: { type: "array", items: { type: "string" } }`（properties + required）
- `max_tokens`: stage1 700 / stage2 1100
- `parseStage` 解析 signals：字符串数组；每条 `trim().slice(0,35)` 去空；整体 `slice(0,8)`；读不到 → `[]`
- 日志加 `signals=${n}`

### 2. `src/lib/yelp.server.ts`
- 同上：`YelpInfo` 加 `signals: string[]`；替换 prompts（保留 `verifyMode` + `isEn` 分支）；json_schema 加 signals；max_tokens 同上调；parseStage 长度上限 `slice(0,80)` 兜底（覆盖中英文）

### 3. `src/lib/echo.functions.ts` —— 下游 AI 排序也改

**A. 候选构建**：把 signals 透传到内部 tabelog/yelp 对象（仅 server 端），**不**加进 `RestaurantSchema`

**B. AI 排序 candidate JSON**：每个候选注入顶层 `tabelogSignals: string[]` / `yelpSignals: string[]` 字段

**C. AI 排序 prompt 新增 3 条规则**（插在 ~1713-1723 pros/cons 写作规范段）：
1. 数据源优先级：`tabelogSignals` / `yelpSignals` 是预提炼好的真实评论要点，可直接作为 pros/cons 事实依据，**优先级高于** googleReviews 原始片段
2. aiSummary 写作：如果 signals 非空，优先从中挑 1–2 条最相关具体点（招牌菜/氛围）融入；不要复读 tabelog.summary / yelp.summary 原文
3. 反幻觉：signals 是已核验事实；**不要**把正向 signals 硬当 cons，除非该条本身就是负面表述（"价格偏高/排队久/不适合大人数"）

**D. 极简兜底（~1747-1762）**：除截短 summary，把 `tabelogSignals`/`yelpSignals` 整段清空 + 删 `tabelog.signals` / `yelp.signals`，优先保 token

### 4. 不动
`store.ts` / `results.tsx` / `supabase/types.ts`

## 交付

切到 build 模式后我改完代码，把**拼好的实际 prompt 字符串**和 AI 排序 prompt 新增的 3 条规则贴出来给你过目。