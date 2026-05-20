## 目标

1. `/cuisines` 步骤上，用户点"跳过"时弹确认：
   - **是，自动识别** → 标记 `autoInferCuisines=true`，后端**必须**尝试推断；推断不出来才兜底"餐厅"。
   - **否，搜全部品类** → 直接把 cuisines 设为通用兜底词，后端跳过 AI 推断。
2. 后端在 `autoInferCuisines=true` 时强制推断：第一次 AI 返回兜底词 → 立刻跨模型重试一次更激进的 prompt；两次都失败才走"餐厅"。

## 改动文件

### 1. `src/lib/store.ts`
- `QueryState` 新增 `autoInferCuisines: boolean`（默认 `true`，向后兼容老用户）。
- `reset()` 重置为 `true`。
- 新增 setter。

### 2. `src/routes/cuisines.tsx`
- 把 `onSkip` 改为打开 shadcn `AlertDialog`，两个按钮：
  - **是，自动识别**：`setCuisines([])` + `setAutoInferCuisines(true)` → `/requirements`
  - **否，搜全部品类**：按 `lang` 取兜底词（zh→"餐厅"，en→"restaurants"，ja→"レストラン"，ko→"음식점"），`setCuisines([fallback])` + `setAutoInferCuisines(false)` → `/requirements`
- 用户**显式填了**品类点 Next 时：`setAutoInferCuisines(false)`（已选就不用 AI 推）。

### 3. `src/lib/i18n/dict.ts`
新增 4 条 key：
- `cuisines.skipDialog.title`：「跳过料理选择？」/「Skip cuisine selection?」
- `cuisines.skipDialog.body`：「让系统从你的「其它需求」自动识别品类？选"否"将按所有品类搜索。」
- `cuisines.skipDialog.auto`：「是，自动识别」/「Yes, auto-detect」
- `cuisines.skipDialog.all`：「否，搜全部品类」/「No, search all」

### 4. `src/lib/echo.functions.ts`

**(a) 入参 schema 增字段**
- `RequirementsInputSchema`（第 6-13 行附近）新增 `autoInferCuisines: z.boolean().default(true)`。

**(b) `parseRequirements` 内强制推断守卫**（在第 261-276 行 `runOnce` 调用之后、`sanitizeVisitTime` 之前）：

```text
const userProvidedCuisines = data.cuisines.length > 0;
const wantsInfer = !userProvidedCuisines && data.autoInferCuisines !== false;
const fallbackSet = new Set(["餐厅","restaurants","レストラン","음식점","食堂"]);
const isAllFallback = (arr) => arr.length > 0 && arr.every(c => fallbackSet.has(c.trim().toLowerCase()));

if (wantsInfer && isAllFallback(parsed.cuisines)) {
  console.warn("[parseRequirements] 用户要求 AI 识别但首轮偷懒返回兜底词，跨模型重试");
  // 用第二个模型 + 追加强制指令重跑
  const parsed2 = await runOnce("openai/gpt-5-mini", { forceInfer: true });
  if (!isAllFallback(parsed2.cuisines)) parsed = parsed2;
  // 两次都失败 → 保留兜底，但 cuisinesInferred=false（前端能识别）
}
```

`runOnce` 第二个参数 `{forceInfer:true}` 时，在 prompt 末尾追加：
> 用户已**明确要求**自动识别料理品类。即使「其它需求」线索很弱，也必须给出 1-3 个最相关的具体品类（菜品、口味、人群、场景、时段、价位都可作为推断依据）。**禁止**返回 `["餐厅"]/["restaurants"]/["レストラン"]/["음식점"]` 等通用兜底词。

**(c) 后端兜底链路**（第 796-809 行）保持不动 —— 它现在已经能正确接受任何 cuisines 输入。但要把 `cuisinesAutoFilled` 的判断改成"cuisines 为空 **AND** 不是用户主动选了「搜全部」"，避免重复套兜底词；其实更简单：保留现有逻辑即可，因为前端"否"的分支已经把 cuisines 设成了非空兜底词，不会进入这条兜底支路。

**(d) prompt 措辞微调**（第 109 / 117 行）
- 第 109 行括号说明改成："（用户跳过了料理选择${data.autoInferCuisines ? '并要求 AI 识别' : '并选择搜索全部品类'}…）"
- 第 117 行 cuisines 字段说明的"若用户跳过（输入为空）"那一句保留，但加一句："如果用户已勾选'搜全部'，cuisines 会在前端直接预填兜底词，AI 会原样回传。"

## 影响

- 用户主动跳过时多一次确认；语义明确。
- 用户选"是"：第一次失败会自动重试（多一次 LLM 调用，仅在偷懒时触发）。
- 用户选"否"：完全跳过 AI 推断，省一次 LLM 往返，并按"餐厅"做地图搜索。
- 老用户（localStorage 里没有 `autoInferCuisines` 字段）默认走"是"，行为不退化。
- 不动数据库、不改路由结构。

## 不在范围
- 不改 ParsedSchema 输出结构。
- 不改 `/requirements`、`/results`。
- 不动 Tabelog / Perplexity 相关代码。
