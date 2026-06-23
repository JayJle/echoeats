## 目标

彻底解决"同一个诉求被识别成多条"的问题。做法：在 `parseRequirements` 的**抽取阶段**就让 AI 按语义合并，**不**新增第二轮 AI 调用。前端不再做任何去重。

## 改动清单

### 1) `src/routes/results.tsx` — 移除前端去重
- 删除 `displayConditionKey`（47–50）、`uniqueDisplayItems`（52–60）、`uniqueDisplayStrings`（62–70）三个辅助函数。
- 删除 `displayedHardFilters / displayedSoftPreferences / displayedNegativeFilters / displayedDishPreferences`（170–173），渲染处直接使用 `parsed.hardFilters / parsed.softPreferences / parsed.negativeFilters / parsed.dishPreferences`。
- 前端完全信任后端返回数据，不再隐藏任何条目。

### 2) `src/lib/echo.functions.ts` — 在抽取 prompt 里加"语义去重"硬约束

在现有 parseRequirements 的中文 / 英文 prompt 主体（约 252–340 行那段大 prompt）里，插入一节专门讲去重规则，措辞要点如下（中英两版都加）：

> **【语义去重规则 — 必须严格执行】**
> 在最终输出 `hardFilters` / `softPreferences` / `negativeFilters` / `dishPreferences` 之前，对所有条目做一次语义合并：
> 1. 判定"同一诉求"按整句语义，不按关键词或字面重合。同一个诉求的不同措辞、不同强度、肯定与否定改写，都算同一条。
> 2. 不同诉求即使用词重叠也不算同一条（例如"要安静" vs "要热闹"是相反诉求，不可合并；"环境好" vs "服务好"是不同维度，不可合并；但"要安静" vs "不要吵"是同一诉求，必须合并）。
> 3. 同一诉求**只能出现一次**，且**只能出现在 hard / soft / neg 三类中的一类**里。归类规则：取该诉求在用户原文中**最强烈**的那次表达决定归类——出现"必须 / 一定 / 务必 / 不能没有 / must / required"等强制信号 → `hardFilters`；只出现"希望 / 最好 / 喜欢 / prefer / nice to have" → `softPreferences`；只出现"不要 / 讨厌 / 避免 / no / avoid" → `negativeFilters`。
> 4. 合并后的 `weight` 取该诉求所有表达中的**最高值**。
> 5. `text` 字段的"原话片段"部分，使用最能体现最强烈表达的那句用户原文；"→ 标准化条件"部分保持一句话总结。
> 6. `dishPreferences` 同样按菜品语义去重（同义/别名/复数算同一道菜）。

放置位置建议：紧跟在现有的 `## hardFilters 判定规则` / `## 权重判定` 之后，作为一节独立的 `## 语义去重规则`，让模型在落笔前最后过一遍。

### 3) `src/lib/echo.functions.ts` — 强化兜底 `dedupeParsedConditions`（145–170）

当作"AI 漏合并"的最后一道防线，规则升级为：

- 把 hard / soft / neg 三桶合并成扁平列表，按现有的 `conditionKey`（NFKC + lowercase + 去空白标点，取 `→` 前的原话片段）做 key。
- 若同一 key 在多桶出现，**保留 weight 最高的那条**，并放入它原本的 bucket（不再像现在这样无条件让 neg 吞 hard）。weight 相等时 tie-break 顺序 `neg > hard > soft`（保持现有行为）。
- 三桶最终互斥。
- `dishPreferences` 维持现有去重逻辑。
- 注意：这一步是字符串归一去重，**不替代** prompt 里的语义去重，只是保险。

### 4) 可观测性
- `echoLog.ok("parseRequirements", …)` 的 metrics 里追加 `dedupeBefore / dedupeAfter` 三桶数量差，方便观察 AI 自身合并效果；如果 `dedupeParsedConditions` 实际合并了 >0 条，`console.warn` 一条 "[parseRequirements] AI missed semantic dedupe, fallback merged N item(s)"，提示我们再调 prompt。

## 用户感知

- 同一诉求（不同措辞 / 强度 / 正反改写）在结果里只出现一次，落在用户最强烈那次表达所对应的类里，权重取最高值。
- 相反诉求和不同维度的诉求不会被误合。
- 没有额外 AI 调用，响应速度不变。
