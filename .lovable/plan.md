## 目标
当用户跳过料理选择，由 AI 从需求中推断出 cuisines 时，在结果页清楚标注「AI 识别的品类」，并展示对应的品类级约束（cuisineLevelConstraints），让用户一眼看出哪些品类是被推断出来的、为什么。

## 改动范围

### 1. `src/lib/echo.functions.ts`（后端 parse）
- 在 `ParsedSchema` 增加 `cuisinesInferred: z.boolean().catch(false).default(false)`。
- 在 `parseRequirements.handler` 末尾：当传入 `data.cuisines` 为空且最终 parsed.cuisines 非 `["餐厅"]` 兜底时，设 `cuisinesInferred = true`；用户传了 cuisines 则永远为 false。
- `LooseParsedSchema` 同步加 `cuisinesInferred: z.unknown().optional()` 以兼容旧响应。

### 2. `src/lib/store.ts`
- `ParsedRequirements` 类型加 `cuisinesInferred?: boolean` 和 `cuisineLevelConstraints?: WeightedCondition[]`（后者后端已有，前端类型补齐）。
- `migrate` 中无需特殊处理，缺省值即可。

### 3. `src/routes/results.tsx`（展示）
在条件卡头部 `{parsed.city} · {parsed.cuisines.join(" / ")}` 区域：
- 若 `parsed.cuisinesInferred` 为 true：
  - 在标题右侧加一个浅色 badge：`✨ AI 识别的品类`（用 `bg-primary/10 text-primary border-primary/20`）。
  - 在标题下方新增一行小字说明：`根据你的需求自动匹配`，并在其下渲染 `cuisineLevelConstraints` 作为 chips（样式同 softPreferences，但带 ✨ 前缀），让用户看到推断依据。
- 若用户显式选了 cuisines：保持现有展示，不加 badge。

编辑模式（`editing` 状态下）也要传递 `cuisinesInferred`，`mergeWeighted` 区域无变化。

## 不动的地方
- prompt、searchRestaurants、Google Places 调用链、UI 其它组件、Supabase。
- cuisineLevelConstraints 仍然同时复制进 softPreferences（保留排序倾斜逻辑），新 UI 只是额外展示来源。

## 验证
- 跳过 cuisine + 输入「东京、用餐 1 小时内、想轻一点」→ 结果页出现 `✨ AI 识别的品类` badge，下方列出「用餐 1 小时内」「想轻一点」chips。
- 选择「寿司」+ 同样描述 → 无 badge，cuisines 显示「寿司」。
- `bunx tsc --noEmit` 通过。
