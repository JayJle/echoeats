## 修改方案 v4（强化每段 prompt 的严格约束）

整体流程（不变）：抽取 → 去重（带原文）→ 打分组装 → 输出。每段 prompt 单独加严输出约束和规则约束，防止 schema 偏移、下游崩溃。

---

### Stage A — 抽取

```
# 角色
你是需求抽取器。只做抽取，不判轻重、不去重、不归类。

# 输入
- 城市：{city}
- 已选料理：{cuisines}
- 自由文本：{freeText}
- 输出语言：{uiLanguage}（zh 或 en）

# 严格规则（违反任一条即视为失败）
1. 通读 freeText，把每一处含约束/偏好/避雷/菜品/时间意味的原话片段都摘出来。同一诉求出现多次也都摘，不做合并、不去重、不打分、不归桶。
2. snippet 必须是 freeText 的**连续子串原文**，逐字一致，不改写、不翻译、不加标点。
3. normalized 必须是一句话标准化描述（≤30 字），用 {uiLanguage} 撰写；非空字符串。
4. kind **只能**是以下三个枚举值之一：
   - "filter"：任何约束/偏好/避雷（人数、预算、氛围、可预约、不要 X 等）
   - "dish"：具体菜品名（蟹刺身、和牛、拉面 等）
   - "time"：用餐日期/时段/营业时间相关（"晚上 7 点"、"营业到 10 点"、"明天中午"）
   出现其它值即非法。
5. id 为正整数，从 1 开始，连续递增，全局唯一。
6. freeText 为空或无任何约束意味时，items 返回空数组。
7. 只输出 JSON，不输出任何解释、不加 markdown 围栏。

# 输出 schema（严格）
{
  "items": [
    {
      "id": <int ≥ 1>,
      "snippet": <freeText 的连续子串>,
      "normalized": <非空字符串，≤30 字，{uiLanguage}>,
      "kind": "filter" | "dish" | "time"
    }
  ]
}

# 思考步骤（内部执行）
1. 通读 freeText。
2. 从前到后扫描，每碰到一个约束/菜品/时间表达就摘一条。
3. 检查 snippet 是否原文子串、kind 是否合法枚举、id 是否递增。
4. 输出 JSON。

# 示例
freeText："两个人务必必须 15000 日元以内，环境稍微好一点，最重要的是环境一定要好，
不要游客店，最好有蟹刺身，明天晚上 7 点。"
items:
  {id:1, snippet:"两个人", normalized:"人数=2", kind:"filter"}
  {id:2, snippet:"务必必须 15000 日元以内", normalized:"人均预算≤15000 JPY", kind:"filter"}
  {id:3, snippet:"环境稍微好一点", normalized:"环境优质", kind:"filter"}
  {id:4, snippet:"最重要的是环境一定要好", normalized:"环境优质", kind:"filter"}
  {id:5, snippet:"不要游客店", normalized:"避免游客店", kind:"filter"}
  {id:6, snippet:"最好有蟹刺身", normalized:"想吃蟹刺身", kind:"filter"}
  {id:7, snippet:"蟹刺身", normalized:"蟹刺身", kind:"dish"}
  {id:8, snippet:"明天晚上 7 点", normalized:"明天 19:00 用餐", kind:"time"}
```

---

### Stage B — 去重 / 取舍

```
# 角色
你是需求条目语义去重与取舍引擎。判断一律基于语义，不做字面匹配。

# 输入
- freeText：完整原文（看上下文用）
- items：Stage A 输出，每条 {id, snippet, normalized, kind}，顺序=原文出现顺序

# 严格规则（违反任一条即视为失败）
1. 把表达**同一诉求**的 items 聚成一簇（同义、近义、强度不同、肯定否定改写都算同一簇）。kind 不同的 items（filter / dish / time）**不能**聚到一起。
2. **每个输入 id 必须且只能出现在一个 cluster 的 ids[] 中**——不能漏，不能重复，不能新增不存在的 id。
3. 每簇必须给出 winnerId，且 winnerId 必须出现在该簇 ids[] 内。
4. 选赢家时综合判断（自行权衡，不强制规则）：
   - 用户**后说的**通常代表最新意图
   - 语义强度更强的优先（"最重要"/"一定"/"绝对"这类强调）
   - 与整段诉求和上下文更一致的优先
   - 出现矛盾（如"要好" vs "可以不好"）时综合上面三条，并在 reason 点明
5. reason 为非空字符串，≤20 字，用 {uiLanguage} 撰写。
6. 没有同义条目的 item 独自成簇，ids=[id]、winnerId=id、reason 写"独立条目"。
7. 只输出 JSON，不输出任何解释、不加 markdown 围栏。

# 输出 schema（严格）
{
  "clusters": [
    {
      "ids": [<int>, ...]   // 非空，所有 id 必须来自输入 items
      "winnerId": <int>,    // 必须 ∈ ids
      "reason": <非空字符串，≤20 字>
    }
  ]
}

# 思考步骤
1. 按 kind 分组，filter / dish / time 互不混。
2. 每组内按语义聚簇。
3. 每簇按规则 4 挑赢家、写 reason。
4. 校验：输入所有 id 是否被覆盖恰好一次。
5. 输出 JSON。

# 示例
items 同 Stage A 示例。clusters:
  {ids:[1], winnerId:1, reason:"独立条目"}
  {ids:[2], winnerId:2, reason:"独立条目"}
  {ids:[3,4], winnerId:4, reason:"后说且最强信号"}
  {ids:[5], winnerId:5, reason:"独立条目"}
  {ids:[6], winnerId:6, reason:"独立条目"}
  {ids:[7], winnerId:7, reason:"独立条目"}
  {ids:[8], winnerId:8, reason:"独立条目"}
```

---

### Stage C — 打分 + 组装

```
# 角色
你是需求打分与组装引擎。判断一律基于语义，下面 weight 锚点仅作参照，不要字面匹配。

# 输入
- freeText：完整原文
- 表单：{city, cuisines, date, uiLanguage, autoInferCuisines}
- winners：Stage B 选出的赢家条目，每条 {snippet, normalized, kind}

# 严格规则（违反任一条即视为失败）
1. 输出语言：hardFilters / softPreferences / negativeFilters / dishPreferences / cuisineLevelConstraints / searchStrategy / cuisines / dateTime / visitTime.raw 用 {uiLanguage}；`language` 字段按城市本地语言填合法 BCP47（如 ja / zh-CN / en-US）；`visitTime.evidence` 保留 freeText 原文片段不翻译。
2. winners 里 kind="dish" 的条目 → 放入 dishPreferences（字符串数组，去重后保留）；**不要**进 hard/soft/neg。
3. winners 里 kind="time" 的条目 → 用于生成 visitTime / dateTime；**不要**进 hard/soft/neg。
4. winners 里 kind="filter" 的条目按语义判桶位：
   - hardFilters：语义上"必须满足"的可验证条件。例：必须 15000 日元以内 / 人数两个 / 要能预约 / 营业到 10 点。
   - softPreferences：偏好或模糊形容词，希望满足但非死线。例：氛围最好好一点 / 地道一些。
   - negativeFilters：否定/避雷诉求。例：不要游客店 / 别太吵。
   - cuisineLevelConstraints：**品类级**特征（不是单家餐厅可查属性，而是整品类特征）：用餐时长 / 同行人结构 / 食量/口味强度 / 氛围基调 / 用餐场景。
5. **桶位互斥与镜像约束**（违反一定坏掉下游）：
   - 否定句**只**进 negativeFilters，**严禁**同时进 hardFilters。
   - cuisineLevelConstraints 的每一条**必须**同时镜像一条到 softPreferences（text 和 weight 一致），**严禁**进 hardFilters。
   - 同一条目不能同时出现在 hardFilters 和 softPreferences。
6. 每条 hard/soft/neg 形如 `{"text": "<原话片段> → <标准化条件>", "weight": <number>}`：
   - text 非空，必须含 " → " 分隔符
   - weight 为 [0.1, 1.0] 区间、保留 1 位小数的 number
7. weight 锚点（按语气强度的语义判断，不要字面匹配）：
   - 1.0：不可妥协 + 叠加强调（"绝对绝对"/"最最重要的是"/"无论如何都得"）
   - 0.9：语义强硬不可让步（"必须"/"一定要"/"只接受"/"不能"）
   - 0.8：明确要求但语气平稳；或可验证硬属性（预算上限/人数/可预约）基线 0.8
   - 0.6：明显偏好可让步（"最好"/"希望"/"优先"）
   - 0.4：弱倾向（"如果可以"/"尽量"）
   - 0.3：顺口一提
   类别先验：主观偏好（氛围/装修/服务）基线 ≤ 0.7；避雷类基线 0.7，强烈避雷上到 1.0。
8. cuisines：用户已填则**原样回传**（顺序不变、不增删）；为空且 autoInferCuisines=true 时按 freeText 和品类级约束推 1-2 个最匹配品类；推不出来填 ["餐厅"]。cuisines 必须是非空字符串数组。
9. country：必须是合法 ISO 3166-1 alpha-2（两个大写字母）或空字符串 ""；不要填三位码、不要小写。
10. dateTime：始终为字符串，从不为 null；表单未填时 zh 写 "未指定"、en 写 "Unspecified"。
11. visitTime：未提及时返回 null；提及时 evidence 字段必须是 freeText 的原文片段。
12. 只输出 JSON，不输出任何解释、不加 markdown 围栏。

# 输出 schema
严格遵循已有 `parsed_restaurant_requirements`（字段名零改动）。

# 思考步骤
1. 按 kind 把 winners 分流到 dish / time / filter。
2. filter 类逐条判桶位 + 打 weight。
3. 处理品类级镜像约束（cuisineLevelConstraints ↔ softPreferences）。
4. 组装 cuisines / country / language / dateTime / visitTime / searchStrategy。
5. 自检：否定句没串到 hard、品类级没串到 hard、cuisines 非空、country 两位大写、weight 一位小数、text 含 " → "。
6. 输出 JSON。
```

---

### 二、代码侧（与 v3 一致，复述要点）

`src/lib/echo.functions.ts`：
1. 新增 `extractRawItems`（Stage A）+ schema。
2. 改写 `semanticCluster`（Stage B）：prompt 替换、schema 不变（已含 winnerId+reason）、调用时**追加 freeText 全文**作为输入上下文。
3. 新增 `scoreAndAssemble`（Stage C）：用现 `parsed_restaurant_requirements` schema，prompt 替换为上面那段。
4. `parseRequirements` 主流程改成 A→B→C 串行；缓存键、forceInfer 重试、visitTime 兜底、structured output 配置、下游 schema 字段名全部不动。
5. 删 Stage B 原代码侧选赢家逻辑（line 256-294），只留 schema 校验 + `dedupeParsedConditions` 精确字符串兜底。
6. 加防御：每段 LLM 调用后做 schema 解析失败重试一次；Stage B 校验"输入 id 集合 = 输出 id 集合"，不一致则降级回单 cluster=单 item 兜底。

### 三、不动 / 风险

- 最终输出 schema 字段名零改动，召回 / Yelp / Tabelog / 排序链路完全不动。
- 风险：三次调用 → 延迟 +1-2s；如不接受可后续把 A+B 合并。Stage A 漏抽是最致命的，prompt 已加"宁多勿少"。

---

确认就切 build 模式落地；想再加哪条严格约束告诉我。