
# 节点二：用户需求结构化解析（parseRequirements）— 节点详细处理逻辑

## 核心逻辑

1. **接收上游标准化原始请求**
   从节点一接收已校验、已 trim 的原始输入包：
   - `city`（必填，已通过城市校验，非中国大陆）
   - `cuisines`（用户显式选择的品类列表，可能为空）
   - `allowAiInferCuisine`（用户在第二页是否勾选"交给 AI 自动推断品类"）
   - `freeText`（第三页采集的自然语言需求，已合并语音转写文字，已去除首尾空格）
   - `visitDateHint`（用户在首页/品类页选择的日期，ISO 或自然语言）
   - `uiLanguage`（界面语言：zh / en / ja）

2. **输入预检与短路**
   在调用大模型之前先做一次廉价判断，避免无意义的 LLM 消耗：
   - 若 `freeText` 为空 **且** `cuisines` 为空 **且** 没有 `visitDateHint`：
     直接产出"空结构"（所有数组为空、`visitTime` 为空、`degraded = 'none'`、`skippedLlm = true`），跳过节点二的模型调用，原样透传给节点三。
   - 若 `freeText` 长度超过 2000 字符：截断到前 2000 字符，并在日志中记录 `inputTruncated = true`。
   - 若 `freeText` 命中明显的 prompt 注入特征（"忽略以上指令"、"system:" 等）：剥离这些片段后再送入模型，并记录 `injectionStripped = true`。

3. **构造解析 Prompt**
   将预处理后的输入拼装成解析提示词，明确告诉模型：
   - 只允许从 `freeText` 中**抽取**信息，不允许臆造用户没说过的条件；
   - 严格忠实原文，不确定的一律不写入 `hardFilters`；
   - 输出语言与 `uiLanguage` 保持一致（中文输入→中文 evidence，英文输入→英文 evidence）；
   - 决策顺序：显式数值条件 → 显式排除项 → 等级关键词（米其林 / Tabelog 100）→ 菜品/食材偏好 → 氛围偏好 → 时间信息；
   - 所有 key 必须是机器可核验的白名单字段；
   - 每条 `hardFilters` / `softPreferences` / `negativeFilters` 必须带 `evidence`（原文片段），用于后续追溯。

4. **调用主模型解析**
   调用主模型（默认 `google/gemini-3-flash-preview`）生成结构化 JSON：
   - 设置超时 8 秒；
   - 使用结构化输出（schema 约束）而非自由文本；
   - 同步记录 `model_used` / `latency_ms` / `prompt_tokens` / `completion_tokens`。

5. **降级链路**
   按以下顺序兜底，保证节点二**永不阻断**整体搜索流程：
   - 主模型 5xx / 429 / 超时 / 非 JSON → 切换 `google/gemini-2.5-flash-lite` 重试一次；
   - 备用模型仍失败 → 切换 `openai/gpt-5-mini` 最后一次重试；
   - 连续 N 次主模型失败 → 5 分钟内的请求直接跳过主模型，从 fallback 起步；
   - 全部模型失败 → 输出最小结构 `{ city, uiLanguage, freeText }`，标记 `degraded = 'minimal'`，仍允许节点三继续。

6. **输出校验与修复**
   对模型返回结果做强校验，模型不能决定字段形状：
   - 用 Zod `safeParse` 校验整体 schema；
   - 白名单过滤未知 key，丢弃非法字段；
   - 权重 clamp 到合法区间：`hardFilters` 0.1–1.0、`softPreferences` 0.3–0.7、`negativeFilters` 固定 1.0；
   - 校验 `evidence` 是否真的出现在 `freeText` 中（容忍 95% 字符匹配），未命中的条目降级为 `softPreferences` 或直接丢弃；
   - 校验 `visitTime` 字段间一致性（`weekday` 与 `date` 不冲突、`mealPeriod` 在枚举内）；
   - 货币单位异常时按城市默认货币兜底。

7. **组装标准化解析结果**
   产出节点三需要的标准结构：
   ```
   {
     city,
     uiLanguage,
     cuisines,                    // 透传，节点二不改
     allowAiInferCuisine,         // 透传
     hardFilters,
     softPreferences,
     negativeFilters,
     dishPreferences,
     cuisineLevelConstraints,     // 独立字段，不并入 hardFilters
     visitTime,
     degraded,                    // 'none' | 'fallback' | 'minimal'
     skippedLlm,
     freeText                     // 原文透传，方便节点三/调试回看
   }
   ```

8. **交付节点三**
   节点二**不**判断目标国家、不决定搜索语言、不分流数据源、不补全最终品类列表——这些都是节点三 `resolveSearchContext` 的职责。节点二只负责把"自然语言需求"翻译成"机器可消费的结构化条件"。

---

需要我接着把节点三 `resolveSearchContext`（国家判断 / 数据源分流 / 品类兜底）也按同样的"核心逻辑"段落写一份吗？
