# Echo Eats：单页对话 + Planner 澄清 方案

> 目标：把「城市 → 品类 → 需求 → 结果」的三页流程合并成「城市 → 单页对话 → 结果」，
> 由 AI 每轮只澄清 1 个字段；搜索环节加 Reflection 自动补救；quick 模式彻底删除。
> 所有 LLM 调用继续走已切换好的 Qwen（DashScope）。

---

## 1. 用户能感知的变化

- 首页只需要输入城市（保留候选城市选择器），不再让用户勾品类。
- 进入新的对话页：AI 每轮只问 **一个** 字段，给 3–6 个 chip 选项 + 「跳过」 + 「自己输入」。
- 一次说完多字段（例："今晚 9 点 300 块想吃安静拉面"）→ AI 自动跳过已填字段。
- 结果太少时自动扩一次（半径 / 同义词 / 放宽硬过滤），前端能看到 `stage: reflect`。
- 「快速搜索 / 深度搜索」选择彻底消失，只有 deep。
- 品类界面、需求界面消失。

## 2. 代价

- 对话轮数从 1 次自由输入变成 3–4 轮（每轮负担更低）。
- 每次搜索多 1 次 planner 调用：+2–3 秒、成本 +8–15%。
- 若触发 reflection 再加 8–15 秒、成本约翻倍（≤1 次）。

---

## 3. 修改清单（文件级）

### 3.1 新增文件

- **`src/routes/chat.tsx`** — 新单页对话
  - 从 store 读 `city`、`chatHistory`、`intentDraft`、`skippedFields`
  - 每轮调用 `clarifyNextStep` serverFn
  - action=`ask`：渲染 AI 文案 + chip 建议 + 「跳过」 + 自由输入框
  - action=`search`：`navigate('/results')`，走既有 `searchRestaurants` SSE
  - 保留 `LanguageToggle`、`FeedbackPanel`

- **`clarifyNextStep`**（写在 `src/lib/echo.functions.ts` 里，新 serverFn）
  - 入参：`{ city, chatHistory, currentIntent, skippedFields, roundIndex }`
  - 出参：`{ action: "ask"|"search", field?, question?, suggestions?: string[], allowSkip: boolean }`
  - 内部：Qwen `qwen-plus` + 确定性优先级栈兜底（品类→时间→预算→氛围→菜品→避雷）
  - 停止条件：字段全填 / 全跳过 / `roundIndex >= 4` → `action=search`

### 3.2 修改文件

- **`src/routes/index.tsx`**
  - 只保留城市输入（含 `city.functions.ts` 候选选择）
  - 提交按钮 → `navigate('/chat')`（而不是 `/cuisines`）
  - 删除品类相关跳转链接

- **`src/lib/store.ts`**
  - 新增：`chatHistory: {role,text}[]`、`intentDraft: Partial<ParsedRequirements>`、`skippedFields: string[]`、`reflectStage?: string`
  - 删除：`cuisines`、`autoInferCuisines`、`freeText`（被 chatHistory 取代）
  - `mode` 字段整段删除

- **`src/lib/echo.functions.ts`**
  - **`ParsedSchema`**：删掉 `mode` 字段
  - **`parseRequirements`** 改为累积模式
    - 每次把 `chatHistory` 拼成新的 `freeText` 重跑，同时把 `currentIntent` 作为「已知字段」传进 prompt，避免覆盖已填内容
    - 已跳过字段在 prompt 里标 `SKIPPED`，不再询问也不再推断
  - **`searchRestaurants`** 加 Reflection 循环
    - Pass-1 打完分后，若 `perfectCount + highCount < targetCount`：
      - 调 `reflectAndRetry`（新内部函数，Qwen `qwen-plus`），产出 `{ action: "retry"|"finish", strategy?: "expand_radius"|"add_synonym"|"relax_hard_filter" }`
      - retry ≤ 1 次，只重跑 recall + Pass-1，不重跑 parseRequirements
      - SSE 推 `{stage: "reflect", strategy}` 让前端可显示
  - **删除 quick 分支**：`searchRestaurants` 里所有 `if (mode === "quick") …` 分支删除，只保留 deep 路径
  - 新增 `clarifyNextStep` serverFn（见 3.1）

- **`src/routes/results.tsx`**
  - SSE 事件监听里增加 `stage === "reflect"` 的展示（一条状态行："结果偏少，正在扩大搜索…"）
  - 删除 mode 相关 URL 参数解析

- **`src/lib/i18n/dict.ts`**
  - 新增键：`chat.cuisineQ / visitTimeQ / budgetQ / vibeQ / dishQ / avoidQ / skip / orTypeYourOwn / reflectExpanding`
  - 删除键：`step2.*` `step3.*` `mode.quick` `mode.deep` 相关

- **`src/router.tsx` / route tree**
  - 通过新增/删除文件自动重生成 `routeTree.gen.ts`（不要手改）

### 3.3 删除文件

- `src/routes/cuisines.tsx`
- `src/routes/requirements.tsx`
- `src/components/NeedBubbles.tsx`（仅被 requirements 用到，如无他处引用一并删）
- `src/components/StepShell.tsx` 视情况（如果只服务 step2/3 就删）

---

## 4. 数据流

```
index (city)
  → chat
      loop:
        clarifyNextStep(city, chatHistory, intentDraft, skippedFields, round)
          → ask  → 用户点 chip / 跳过 / 输入 → 更新 chatHistory + intentDraft
          → search → parseRequirements(累积) → navigate('/results')
  → results
      searchRestaurants (SSE)
        recall → Pass-1 → 若不足 → reflectAndRetry → (可能重跑 recall+Pass-1) → 输出
```

## 5. Planner 决策规则（clarifyNextStep）

优先级栈（确定性 fallback，Qwen 不可用时也能跑）：

1. cuisine（未填 且 未跳过）
2. visitTime
3. budget
4. vibe / atmosphere
5. dishPreferences
6. negativeFilters（避雷）

每轮：
- 若栈里第一个未处理字段存在 → `ask` 那个字段
- 若全部处理完 或 `round >= 4` → `search`
- LLM 只用来产 `question` 文案 + `suggestions` chips（3–6 个），字段选择用确定性栈更稳

## 6. Reflection 决策规则（reflectAndRetry）

触发条件：Pass-1 结束后 `perfect+high < target(默认 5)` 且未重试过。

策略选择（LLM 判 + 兜底）：
- 候选池 < 15 → `expand_radius`
- 候选池 ≥ 15 但硬过滤刷掉大半 → `relax_hard_filter`
- 硬过滤没刷 但相关度差 → `add_synonym`

重试只重跑 recall + Pass-1，parseRequirements 不动。

## 7. 不改的部分

- 城市输入 & `city.functions.ts` 候选
- Google Places 8 路召回（`google-places.server.ts`）
- Tabelog / Yelp（`sonar/sonar-pro`）
- Pass-1 打分/matchDetails 主体逻辑
- 结果页卡片渲染
- 反馈、账号历史、admin 页

## 8. 验证清单

- [ ] 输入城市 → 进入 chat 页，第一轮问品类，有 chips + 跳过 + 输入
- [ ] "今晚9点300块想吃安静拉面" 一句话 → planner 跳到 search
- [ ] 4 轮之后强制 search
- [ ] 跳过品类后不再重复问
- [ ] 结果 < 5 时前端出现 "正在扩大搜索…" 状态行
- [ ] mode 字段在 URL / store / 类型里都搜不到
- [ ] typecheck 干净、旧路由不再被 Link 引用
