# 保留 negativeFilters 的否定语气

## 现象

用户原话是「不要路边摊感」（避雷），系统在餐厅卡上渲染出的标签是：

> 很路边摊：装修漂亮，服务良好，完全不符合路边摊的特点

「不要 / 避免」被剥掉了，只剩「路边摊」这个主题词。下游 AI 把它当作**要匹配的偏好**来评估（"不符合路边摊的特点" 听起来像 fail），语义完全反转。

## 根因（三处叠加）

1. **Step-1 抽取（`echo.functions.ts` parseRequirements prompt 490 附近）**：`negativeFilters[].text` 只有「不要游客店」这一个示例，模型经常写成 `"路边摊感 → 排除路边摊风格"`，把否定词丢进 `→` 右半边或直接省掉，`conciseCondition` 拿的是 `→` 左半边就没有了否定。
2. **语义聚类合并（`semanticClusterMerge` 274-294）**：一簇内取 weight 最高那条的 `text` 作为最终文案；如果这簇里同时有 soft 正向表述和 neg 负向表述，且正向那条 weight 更高，最终 bucket 会随赢家推到 neg 时用的仍是**正向那条的 text**，标签就没有否定语气。
3. **Pass-1 核验 prompt（2084-2094、2139）**：`nonHardFilters` 把 soft/neg/dish 拉平只序列化 `text`，模型看到 `"路边摊感"` 时不知道它是 avoidance，写出的 `matchDetails[].label` 会用"很/挺/符合"这种正向语气收尾。

## 改动方案

只改 `src/lib/echo.functions.ts`（步骤 1-4）和 `src/routes/results.tsx`（步骤 5，UI 兜底）。不动打分逻辑、召回逻辑、其它节点。

### 1. Step-1 prompt 强化 negation-preservation（parseRequirements）

在现有"边界"段（474 行附近）追加硬约束，并补两条示例：

- `negativeFilters[].text` **必须以否定前缀开头**（中文：`不要/避免/排除/不喜欢/不接受`；英文：`Avoid/No/Not/Exclude`），并在 `→` **右半边同样保留否定语气**（例：`"不要路边摊感 → 排除装修简陋、街边摊风格"`，禁止 `"路边摊感 → 路边摊风格"`）。
- 新示例：
  - `"不要装修像路边摊 → 排除路边摊/大排档风格的店"`, weight 0.7
  - `"不喜欢连锁店 → 排除连锁品牌"`, weight 0.8

### 2. Parser 兜底：`ensureNegationPrefix`（新工具函数）

在 `exactDedupe` 之后、`semanticClusterMerge` 之前，对 `negativeFilters` 每条跑一次：

```ts
const NEG_ZH = /^(不要|不想|不喜欢|避免|排除|拒绝|讨厌|不接受|别|勿)/;
const NEG_EN = /^(avoid|no |not |exclude|without|don'?t|dislike)/i;
function ensureNegationPrefix(text: string, isEn: boolean): string {
  const [left, right] = text.split(/\s*(?:→|->|=>)\s*/);
  const fix = (s: string) =>
    !s ? s : (NEG_ZH.test(s) || NEG_EN.test(s)) ? s : (isEn ? `Avoid ${s}` : `不要${s}`);
  return right ? `${fix(left)} → ${fix(right)}` : fix(left);
}
```

`→` 两半各自独立检查。命中就跳过，缺失就补，日志打一行 `[neg-prefix] auto-prepended`。

### 3. 聚类合并保留否定语气（`semanticClusterMerge` 274-294）

修改选 winner 逻辑：当**最终 bucket = neg** 时，优先从簇里选一条**原本就是 `neg` 且 text 已带否定前缀**的条目作为文案来源；只有找不到才 fallback 到当前的按权重选（并对 fallback text 再跑一次 `ensureNegationPrefix`）。伪代码：

```ts
if (finalBucket === "neg") {
  const negCandidate = entries.find(e => e.bucket === "neg" && HAS_NEG_PREFIX(e.item.text))
                    ?? entries.find(e => e.bucket === "neg");
  if (negCandidate) winner = negCandidate; // 保留权重仍取 maxWeight
}
const finalText = finalBucket === "neg"
  ? ensureNegationPrefix(winner.item.text, isEn)
  : winner.item.text;
```

### 4. Pass-1 核验 prompt 改造（2084-2094、2139）

- `nonHardFilters` 序列化改成显式标注：avoidance 项的 `text` 前缀加 `【避雷/AVOID】`，dish 加 `【菜品/DISH】`，soft 加 `【偏好/PREFER】`。
- 在 langDirective 后追加一条铁律（zh/en 双版本）：

  > 对 kind="avoidance"（【避雷】开头）的条件：`status="ok"` = **餐厅不具备**该特征（成功避雷）；`status="fail"` = **餐厅命中**该特征（踩雷）。`label` 必须写成「避免 X：...」「未见 X 特征...」这类**保留否定语气**的表述，禁止写"很 X / 符合 X / 具备 X"。

这样 Pass-1 输出的 `matchDetails[].label` 天然带否定语气，`conciseCondition` 就不会再丢。

### 5. 前端渲染兜底（`src/routes/results.tsx` 361-365 + 卡片上的 matchDetails）

标签本身已经在 `displayedNegativeFilters` 里，加一个 `renderNegText` helper：如果 text 没有否定前缀，前端展示时自动补一个 `✕ ` 图标 + `不要`/`Avoid`（不改 store 数据，只改 UI）。同样应用到餐厅卡上 `matchDetails` 里 status 属于避雷条目的行。

只做展示兜底，不代替步骤 2-4；防止再有历史 session 缓存里落库的旧数据展示错误。

## 不改动

- 打分公式、`negFailHeavy` 判定、召回 8 路、Tabelog/Yelp 抓取
- `applyHalfPeriodFix` / 时间解析
- Reflect/repair 机制（上一轮的讨论）

## 验证

跑三条用例，看 `parsed.negativeFilters[].text`、卡片标签、matchDetails：

1. 「不要路边摊感觉」→ neg 里 text 以 `不要` 开头；标签渲染为 `不要路边摊感 · 0.7`；命中的餐厅 matchDetails 显示"避免路边摊：装修精致、未见街摊风格 · ok"。
2. 「装修不能太简陋」→ neg 保留「不能」；卡片不出现正向措辞。
3. 「Avoid touristy places」→ neg 保留 `Avoid`；英文 UI 下 matchDetails 用 "Avoid touristy: ..." 句式。

历史用例回归：`"不要游客店"` 保持不变（已经带否定前缀，跳过 auto-prepend）。
