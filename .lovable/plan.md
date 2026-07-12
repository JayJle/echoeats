## 目标

让项目更 agent 化：删掉硬性的"选品类"环节和第三页气泡引导，改成用户一句话输入后由一个 **Planner Agent** 判断结构化字段是否充分；不充分则在原地打开一个多轮澄清面板（语音优先 + 每轮 2-3 个 AI 推荐选项 + 跳过 + 自定义输入），并实时把新识别到的字段显示给用户。澄清结束后再走现有的搜索进度条。

## 流程改动

```text
旧: 城市 → 品类 → 需求(气泡) → 搜索进度 → 结果
新: 城市 → 需求(纯输入，语音优先，无气泡) → [Planner 判断] → 若需澄清则原地展开 chat 面板(≤5轮) → 搜索进度 → 结果
```

- StepShell 从 `step X / 3` 改成 `step X / 2`。
- `/cuisines` 路由删除；`/requirements` 从"第 3 步"变"第 2 步"。首页 `/` 提交后 `navigate({ to: "/requirements" })`。
- `NeedBubbles` 组件从 requirements 页移除（组件文件保留但不再引用，避免影响其他人）。
- `useQueryStore` 保留 `cuisines / autoInferCuisines` 字段（parseRequirements 仍读它们），但默认置空 + `autoInferCuisines: true`，由 planner/parser 自行推断。

## Planner Agent（新）

新增 `src/lib/planner.functions.ts`，导出 `plannerTurn` server fn（`requireSupabaseAuth` 不需要，与现有 parseRequirements 一致 public）。

**输入**：`{ city, uiLanguage, freeText, history: PlannerTurn[], parsed: ParsedRequirements | null, skippedFields: string[] }`

**输出（LLM 结构化 JSON）**：
```ts
{
  parsed: ParsedRequirements;          // 融合本轮新信息后的最新结构化需求
  newlyFilled: string[];               // 本轮新增/更新的字段名，用于前端高亮
  needsClarification: boolean;
  question?: {
    field: "cuisine" | "hardFilter" | "softPreference" | "mealTime" | "budget" | "ambiguity";
    prompt: string;                    // 追问文案，语言跟 uiLanguage
    reason: "missing" | "conflict" | "unparseable";
    suggestions: { label: string; value: string }[]; // 2-3 条 AI 基于已有信息推荐
    allowSkip: true;
    allowCustom: true;
  };
  done: boolean;                       // planner 认为可以进入搜索
}
```

**判定规则（LLM prompt 里表达；服务端再兜一层校验）**：
- 关键字段：`cuisines`、`hardFilters + softPreferences`（合并视为 preference）、`visitTime`（用餐时间）、`budget`（预算——从 hardFilters/softPreferences 里正则/关键词抽取）。
- **触发条件（用户答案的选择）**：以上任一关键字段缺失 → `needsClarification=true`。
- 已经在 `skippedFields` 中的字段：视为用户主动放弃，不再追问。
- 若用户新一轮回答**无法解析或与已有信息矛盾**，针对该字段以 `reason: "conflict" | "unparseable"` 再追问一次；用户再次跳过 → 加入 `skippedFields` 永久放弃。
- 上限 5 轮 或 `done=true` 或 `skippedFields` 覆盖所有关键字段 → 结束澄清。
- 每轮 `suggestions` 由 LLM 基于 city + parsed 上下文动态生成（例："东京 + 未指定品类" → ["寿司", "拉面", "居酒屋"]）。

**实现方式**：独立 planner server fn，每轮把完整 `history + parsed` 送给 LLM，LLM 一次输出上述 JSON（复用 `qwen-plus`/AI Gateway，超时 fallback）。这样 parser 逻辑不动，planner 只做"融合 + 追问"这一层。

## 前端：澄清面板

在 `/requirements` 页面新增内联组件 `<PlannerClarifyPanel />`：

- 位置：紧贴需求输入框下方展开，不跳路由。
- 结构（AI Elements）：
  - 顶部 `ParsedFieldsBar`：胶囊标签形式实时展示当前 `parsed` 里的 city / cuisines / hardFilters / softPreferences / visitTime / budget；`newlyFilled` 里的字段做 200ms fade-in + 高亮环。
  - 中部 `Conversation + Message`：显示 planner 追问和用户回答。
  - 每条 AI 追问下方：`suggestions` 渲染为 2-3 个大按钮 + "跳过此项" 按钮 + "自定义回答"（点开展开 PromptInput）。
  - 底部 `PromptInput`：语音按钮（复用现有 requirements 页的 MediaRecorder + `/api/transcribe` 逻辑，抽成 `useVoiceInput` hook 供两处共享）为主，textarea 为辅；提交后调用 `plannerTurn`。
  - 面板右上角"跳过全部澄清，直接搜索"。
- 状态：`turnCount`（≤5）、`skippedFields: Set<string>`、`history`、`parsed`。
- 每轮 planner 返回后：
  - `setParsed(next.parsed)`；对比 diff 得 `newlyFilled` 用于高亮。
  - 若 `done || turnCount>=5` → 关闭面板，`runSearch(freeText, "deep")` 走现有搜索进度条。
- 首次提交需求时，先跑 `parseRequirements` 得到 initial parsed（同时展示 ParsedFieldsBar），再本地判断是否任一关键字段缺失：
  - 不缺 → 直接进搜索。
  - 缺 → 用 initial parsed 作为种子调用 `plannerTurn` 展开面板。

## 保留 & 不动

- `parseRequirements` 逻辑、搜索进度条（parse/search/reviews/rank）、结果页、i18n 键位 —— 全部保留。
- 语音录音 / 转写路径 —— 抽到 `src/hooks/use-voice-input.ts` 复用。

## 文件变更清单

新增：
- `src/lib/planner.functions.ts` — `plannerTurn` server fn。
- `src/components/PlannerClarifyPanel.tsx` — 澄清面板 UI。
- `src/components/ParsedFieldsBar.tsx` — 实时字段胶囊条。
- `src/hooks/use-voice-input.ts` — 抽取现有 requirements 页录音/转写逻辑。

修改：
- `src/routes/index.tsx` — 提交后跳 `/requirements`。
- `src/routes/requirements.tsx` — StepShell 改 `step 2 / 2`；删除 `<NeedBubbles>`；接入 `<PlannerClarifyPanel />`；用 `useVoiceInput` 替换本地录音代码。
- `src/components/StepShell.tsx` — 支持 total=2（若目前硬编码 3）。
- `src/lib/store.ts` — 保留字段，但 `setCuisines`/`setAutoInferCuisines` 不再由 UI 主动调用。
- `src/lib/i18n/dict.ts` — 新增 planner/clarify 相关文案键（zh/en/ja/ko）。

删除：
- `src/routes/cuisines.tsx`（连带路由树自动重生成 `src/routeTree.gen.ts`）。
- 首页里指向 `/cuisines` 的 `navigate` 改到 `/requirements`。
- 不删 `NeedBubbles.tsx` 组件文件（避免误删），但从 requirements 页移除引用。

## 边界与验证

- Planner LLM 失败 → 前端提示"跳过澄清直接搜索"按钮，回退到旧路径。
- 5 轮上限硬性生效，即使 planner 还想追问也强制 done。
- `skippedFields` 存 sessionStorage，防止用户误刷。
- 手工验证：
  1. 输入"东京 想吃拉面 便宜点 明天中午"→ 关键字段齐 → 无澄清直接搜索。
  2. 输入"东京 找家餐厅"→ 触发澄清，AI 推荐 3 个品类；跳过 → 追问用餐时间；再跳过 → 追问预算；跳过全部 → 直接搜索。
  3. 澄清中回答"5分钟后就吃"→ visitTime 被填充，字段条高亮。
  4. 回答"预算 500 但要米其林三星"→ planner 识别矛盾 → 针对预算再澄清一次。
  5. `/cuisines` 直接访问 → 404（或重定向到 `/requirements`，二选一，倾向 404 自然）。
