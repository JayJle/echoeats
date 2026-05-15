# 给需求加权重

## 目标

把现在的 hard / soft / neg 三类纯字符串数组，升级为「每条带 0-1 权重」的对象。权重由 parseRequirements 的 AI 根据用户原话语气推断，下游打分阶段使用权重决定扣分力度和是否真的硬剔除。

## 1. 数据结构改造（`src/lib/echo.functions.ts` + `src/lib/store.ts`）

把三个数组从 `string[]` 改成 `WeightedCondition[]`：

```ts
type WeightedCondition = {
  text: string;       // 原来的「原话片段 → 标准化条件」字符串
  weight: number;     // 0.1 - 1.0，保留 1 位小数
};
```

- `ParsedSchema.hardFilters / softPreferences / negativeFilters` 改为 `z.array(z.object({text: z.string(), weight: z.number().min(0).max(1)}))`。
- `store.ts` 的 `ParsedRequirements` 类型同步更新。
- `dishPreferences` 不加权重（它是事实清单，不是判定条件）。

## 2. parseRequirements 提示词加权重生成规则

在现有 hardFilter / softPreference / negativeFilter 判定规则后加一节「权重判定」：

```
## 权重判定（每条都要打 weight 0.1-1.0）

按用户原话语气强度打分：
- 1.0：务必/必须/一定/绝对/只能/拒绝/禁止 + 强调副词（"务必必须"、"绝对不要"）
- 0.9：必须 / 一定 / 不能 / 不要 / 只 / 仅
- 0.8：要 / 需要 / 得 + 明确数值上下限（"15000 以内"无强制词也算 0.8，因为是可验证硬约束）
- 0.6：最好 / 希望 / 偏好 / 优先
- 0.4：如果可以 / 尽量 / 有的话更好
- 0.3：随便提一句、轻描淡写

类别先验（与语气结合，取较高值）：
- 预算上限 / 人数 / 可预约 / 营业时间 这类「可验证硬属性」基线 ≥ 0.8
- 氛围 / 装修 / 服务态度 这类主观偏好基线 ≤ 0.7
- 避雷条目按语气：「不要 X」=0.7，「绝对不要 X」=1.0

示例输入："两个人预算 15000 日元以内，不要游客店，适合聊天，最好有蟹刺身，可以预约。"
- hardFilters: [{text:"两个人 → 人数=2", weight:0.9}, {text:"预算 15000 日元以内 → ≤15000 JPY", weight:0.9}, {text:"可以预约 → 支持预约", weight:0.8}]
- softPreferences: [{text:"适合聊天", weight:0.7}, {text:"最好有蟹刺身", weight:0.6}]
- negativeFilters: [{text:"不要游客店", weight:0.7}]
```

兜底分支（AI 失败时）创建空数组即可。

## 3. searchRestaurants 提示词与打分逻辑

排序提示词（lines ~896-943）改动：

- 把硬条件传成 `[{text, weight}]`，提示词里写明 weight 含义。
- **硬剔除规则改为**：只有当 `status="fail"` 且对应条目 `weight >= 0.85` 时才直接剔除；`weight < 0.85` 的硬条件 fail 不剔除，但在 matchDetails 标 warn 并在打分时减去 `weight * 25` 分。
- 软偏好和避雷在打分时按权重加减：
  - soft 命中 → `+ weight * 12`
  - soft 未命中 → 不扣分（默认）
  - neg 命中 → `- weight * 30`
- AI 仍输出 `matchScore`（0-100），但服务端会在 AI 给的分基础上再做权重调整（避免 AI 自己估算偏差），因此让 AI 输出 `componentScores`：
  ```
  hardFilterChecks: [{filter, status, note, weight}]   // weight 由服务端回填，AI 只判 status
  softMatches: [{text, hit: bool}]                      // AI 判每条 soft 是否命中
  negMatches: [{text, hit: bool}]                       // AI 判每条 neg 是否命中
  ```
- 服务端在 lines ~1008-1078 的合并循环里，根据 weight + hit 重算 `matchScore`：
  ```
  base = 60
  + Σ(hard ok ? weight*15 : (status==="fail" ? -weight*25 : -weight*5))
  + Σ(soft hit ? weight*12 : 0)
  + Σ(neg hit ? -weight*30 : 0)
  clamp 0-100
  ```
- 硬剔除条件改为：`checks.some(c => c.status === "fail" && c.weight >= 0.85)`。

## 4. UI（暂不展示给用户）

按"AI 自动生成、不展示"先做。`src/routes/results.tsx` 里的硬条件 detail（`✓ 硬条件：${f}`）继续显示文字，不显示数字权重，避免界面噪音。后续如要可视化再单开任务。

## 5. 类型与 store 同步

`store.ts` `ParsedRequirements` 改为对象数组后，所有读取 `.hardFilters` 当字符串数组的地方都要改：搜索一遍 `hardFilters`、`softPreferences`、`negativeFilters` 的访问点（主要在 echo.functions.ts 内部 + results.tsx 的"编辑需求"回填），把 `.join(...)` 改成 `.map(c => c.text).join(...)`。

## 验证

1. 输入「两个人务必必须 15000 以内，不要游客店，最好能预约」→ 硬条件 weight 应该 ≥ 0.9，"最好能预约" 进 soft 且 weight ~0.6。
2. 输入「随便点的预算 5000」→ 预算硬条件 weight ~0.8（可验证硬属性基线），不会因为"随便"降到 0.3。
3. 一家店人均超预算但 weight=0.8（不是 0.9+） → 不剔除，进 partial 并扣分；如果 weight=1.0 → 直接剔除。
4. results 页面"编辑需求"按钮回填 freeText 仍正常。

## 风险

- store 是 sessionStorage 持久化，旧结构（string[]）残留会让重载后页面崩。需在 `store.ts` 的 persist 加 `version: 2` + `migrate` 函数把字符串数组升级成 `[{text, weight: 0.8}]` 默认值。
- AI 偶发不给 weight：用 zod `.default(0.7)`。
