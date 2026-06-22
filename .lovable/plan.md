## 目标

把"需求结构化解析"中的去重逻辑彻底重写，并下沉到后端（`parseRequirements`），保证：

- 同一语义的条目（无论用词怎么变）在最终输出中**只保留一条**。
- 保留的那一条 = **权重最高**的那一条。
- 跨 `hardFilters` ↔ `softPreferences` 也要合并（"环境必须好 0.9" 与 "环境稍微好一点 0.4" 应只剩 hard 0.9 一条）。
- `negativeFilters` 与 `hardFilters` 是相反极性，**不跨数组合并**，但各自数组内部按同样规则去重。
- 前端 `results.tsx` 不再做任何去重，纯渲染。

## 现状（为什么当前机制失效）

当前 `dedupeParsedConditions` 用 17 条正则 `TOPIC_RULES` 归并同义词，问题：

1. 跨 hard/soft 时**只看是否同 key，不比权重** —— 保留出现顺序的第一条，不是最高权重。
2. 主题表是写死的正则白名单。用户原话只要不命中（如"环境好" / "氛围舒服" / "装修有格调"），就退化到 `normalizeText` 全文匹配，三条都是不同字符串 → 三条都保留。
3. 完全没有语义层判断，只是关键词。

## 新方案（两段式：先廉价归并，再语义归并）

### Step 1：原地廉价归并（保留现有正则 + 改成"权重最高保留"）

- `uniqueConditions`：同一 key 时取 `weight` 最大的那一条，文本沿用最大权重那一条的文本（已基本对，确认行为）。
- `dedupeParsedConditions`：
  - **negative 单独跑** `uniqueConditions`，不参与跨数组合并。
  - 把 `hardFilters` + `softPreferences` 合并成一个候选池，按 `conditionKey` 分组 → 每组取最高 weight 的那一条 → 若该条 weight ≥ 0.8 入 hard，否则入 soft（与现有 "0.8 提升为 hard" 的逻辑天然一致）。
  - 删除目前"hard 命中就把 soft 同 key 全删"的简单优先级写法。

### Step 2：语义去重（新增 `semanticDedupe`）

正则覆盖不到的同义条目，用一次小模型调用收口。

- **何时调用**：在 `runOnce` 内、Step 1 之后；当 `hardFilters + softPreferences` 合计 ≥ 2 条或 `negativeFilters` ≥ 2 条时才触发；否则跳过。
- **怎么调用**：单次 `gemini-2.5-flash-lite`（或当前已配置的最便宜模型）调用，输入为：
  - 用户原文 `freeText`
  - 三个数组（带 index、text、weight、bucket）
  - 输出严格 JSON：`{ "groups": [{ "keepIndex": number, "mergeIndices": number[], "reason": string }] }`
- **Prompt 要点**：
  - "判断两条是否在用户**原意**层面表达同一诉求；要把每条结构化文本与用户原文里的对应片段一并比较。"
  - "同组内**保留 weight 最大**的索引；并列时保留 bucket 优先级高的（neg > hard > soft）。"
  - "neg 与 hard/soft 因极性相反，**绝不能合并到同一组**。"
  - "如果不确定就不合并，宁可保留两条。"
- **后处理**：按 `groups` 把被合并的 index 从相应数组剔除；保留的那一条 weight 不变（已经是最高的）。
- **失败兜底**：模型调用抛错或返回非法 JSON → 跳过 Step 2，仅用 Step 1 结果（不阻塞主流程）。
- **延迟控制**：限定 `maxOutputTokens` ≤ 400；并行不影响主路径（在 `runOnce` 串行一次，但只是一个 flash-lite 的 JSON 输出，预计 < 1s）。

### Step 3：前端去除重复去重

- `src/routes/results.tsx`：删除 `DISPLAY_TOPIC_RULES` / `displayConditionKey` / `uniqueDisplayItems` / `uniqueDisplayStrings`，渲染时直接 `.map` 后端给的数组。
- 仅保留 React `key` 用的稳定 id（用 `text` 即可，因为已经唯一）。

### Step 4：日志

`logParsedSummary` 已存在；额外打印 Step 2 合并了哪些组（`keepIndex` ← `mergeIndices`），方便回放查 bug。

## 不在范围

- 不动 AI prompt 里的 hardFilters / softPreferences / weight 判定规则。
- 不动 `dishPreferences`（仍只做字面去重，菜品名不归并）。
- 不动 `cuisineLevelConstraints`、`visitTime`、`cuisines` 推断。
- 不动准入层 / negative 与 hard 统一处罚规则（上一轮已完成）。

## 技术细节

文件改动：
- `src/lib/echo.functions.ts`：
  - 重写 `dedupeParsedConditions`（Step 1 行为变更）。
  - 新增 `semanticDedupe(parsed, freeText, gateway)`（Step 2）。
  - `runOnce` 末尾 `return dedupeParsedConditions(parsed)` 改为 `return await semanticDedupe(dedupeParsedConditions(parsed), data.freeText, gateway)`。
- `src/routes/results.tsx`：删除前端去重函数与调用点。

预期净延迟：+300~900ms（仅在有 ≥ 2 条同 bucket 时；空请求/单条请求 0 开销）。
