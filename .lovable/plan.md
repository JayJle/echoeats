# Echo Eats：Planner + Workflow 架构升级方案

## 1. 目标

把现在「城市 → 品类页 → 需求页 → 结果页」的固定 3 步流程，升级成一个由 **Planner（决策脑）** 驱动的对话式 Agent：

- 用户只输入城市
- AI 每轮只问 **一个** 需求字段，给候选按钮 + 跳过 + 自由输入
- 搜索结果不理想时，Planner 自动决定要不要扩大范围重搜
- 只保留 deep 搜索，quick 完全删除

## 2. 用户能看到的所有变化

**流程层面**
- 首页只留城市输入框（其他都删）
- 品类选择页消失
- 需求输入页消失
- 中间出现一个新的「对话页」，AI 一句一句提问
- 结果页保持原样

**对话体验**
- 每轮 AI 只问一件事，例如"想吃什么？"，下面给 4–6 个候选按钮 + 「跳过」按钮 + 「自己写一个」输入框
- 提问顺序固定：品类 → 时间 → 预算 → 氛围 → 想吃的菜 → 避雷
- 最多 4 轮，之后强制开始搜索
- 用户点「跳过」的字段不会再问第二次
- 用户如果在某一轮里一次说完好几件事（"今晚 9 点 300 块想吃安静拉面"），AI 会识别出来并跳过已回答的字段

**搜索体验**
- 「快速搜索 / 深度搜索」的选项彻底消失
- 结果偏少时，页面会短暂显示"正在扩大搜索…"，然后给出补搜后的新结果（最多补 1 次）

**收藏 / 反馈 / 历史 / 管理页**：不变

## 3. 是优化还是变差

**优化面**
- 用户心智负担更低：单次一问一答比一次填一大页表单轻松
- 品类不再是硬门槛：不知道吃什么也能开始
- 结果不足会自动补搜，不用用户手动重来
- 架构可扩展：以后加新数据源、新问题都不用改主流程

**代价面**
- 对话轮数从 1 次自由输入变成 3–4 轮（但每轮更轻）
- 每次搜索多一次 AI 调用做决策：延迟 +2–3 秒、成本 +8–15%
- 触发自动补搜时：额外 +8–15 秒、成本约翻倍
- 老用户需要适应新流程

**结论：产品体验是明确优化，工程成本和延迟是要付出的代价。**

---

## 4. 技术改动清单（供实施参考）

### 4.1 新增
- `src/routes/chat.tsx`：单页对话 UI
- `src/lib/echo.functions.ts` 里新增 `clarifyNextStep` serverFn
  - 入参：`{ city, chatHistory, currentIntent, skippedFields, roundIndex }`
  - 出参：`{ action: "ask" | "search", field?, question?, suggestions?, allowSkip }`
  - 用 Qwen `qwen-plus` + 确定性优先级栈兜底
  - 停止条件：字段全填 / 全跳过 / `roundIndex >= 4`
- `src/lib/echo.functions.ts` 里新增 `reflectAndRetry` 内部函数
  - Pass-1 后若 `perfect + high < 5` 且未重试过 → 判 `expand_radius` / `add_synonym` / `relax_hard_filter`
  - 最多 retry 1 次，只重跑 recall + Pass-1

### 4.2 修改
- `src/routes/index.tsx`：只保留城市输入 + 候选，提交后 `navigate('/chat')`
- `src/lib/store.ts`：
  - 新增：`chatHistory`, `intentDraft`, `skippedFields`, `reflectStage`
  - 删除：`cuisines`, `autoInferCuisines`, `freeText`, `mode`
- `src/lib/echo.functions.ts`：
  - `ParsedSchema` 删掉 `mode` 字段（第 108 行）
  - `parseRequirements` 改累积模式：`chatHistory` 拼成 `freeText` 重跑，`currentIntent` 作为已知字段传入 prompt，跳过字段标 `SKIPPED`
  - `searchRestaurants`：删除所有 `mode === "quick"` 分支（1652 / 1705 / 1902 / 1953 行），只留 deep 路径
  - `searchRestaurants` SSE 流末尾接入 Reflection：推 `{stage:"reflect", strategy}` 让前端显示
- `src/routes/results.tsx`：
  - 删除 URL 里的 `mode` 参数解析（226 / 231 行）
  - 监听 `stage:"reflect"` 显示状态行
- `src/lib/i18n/dict.ts`：
  - 新增：`chat.cuisineQ / visitTimeQ / budgetQ / vibeQ / dishQ / avoidQ / skip / orTypeYourOwn / reflectExpanding`
  - 删除：`step2.*` / `step3.*` / `mode.*`

### 4.3 删除
- `src/routes/cuisines.tsx`
- `src/routes/requirements.tsx`
- `src/components/NeedBubbles.tsx`
- `src/components/StepShell.tsx`（仅服务 step2/3）

### 4.4 数据流

```text
index (city)
 → chat
    loop:
      clarifyNextStep(...)
        → ask    → 用户点 chip/跳过/输入 → 更新 chatHistory + intentDraft
        → search → parseRequirements(累积模式) → navigate('/results')
 → results
    searchRestaurants SSE:
      recall → Pass-1
        → 若 perfect+high < 5 → reflectAndRetry
             → 可能重跑 recall + Pass-1（≤1 次）
        → 输出
```

### 4.5 Planner 优先级栈（确定性 fallback）

`cuisine → visitTime → budget → vibe → dishPreferences → negativeFilters`

LLM 只负责生成 `question` 文案 + 3–6 个 `suggestions`；字段选择由确定性栈决定（更稳、Qwen 挂了也能跑）。

### 4.6 不改的部分

城市输入 / `city.functions.ts` / Google Places 8 路召回 / Tabelog / Yelp（Perplexity）/ Pass-1 打分主体 / 结果卡片渲染 / 反馈 / 账号历史 / admin 页

### 4.7 验证清单

- 输入城市 → chat 页第一轮问品类，有 chips + 跳过 + 输入
- 一句话说多字段 → planner 直接进 search
- 4 轮之后强制 search
- 跳过品类后不再重复问
- 结果 < 5 时前端出现"正在扩大搜索…"
- `mode` 在 URL / store / 类型里都搜不到
- typecheck 干净、旧路由无 Link 引用
