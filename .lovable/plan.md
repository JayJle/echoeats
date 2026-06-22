
# 修复"AI 排序一直走 slim fallback"

## 目标

让 `Output.object`（第一档）在长 prompt + 完整候选字段下也能稳定通过 zod 校验，从而：
- 平均每组 LLM 调用：2~3 次 → 1 次
- 长 prompt 场景排序耗时：200~270s → 30~60s
- `Output.object failed` 比例：~100% → <10%
- 不再因为模型漏 `matchScore` / `pros[].text` 整组返回空

## 范围

只改一个文件：`src/lib/echo.functions.ts`。
不动业务逻辑、不动评分公式、不动前端、不动数据库。

---

## 改动一：schema 加容错（最关键，第一档失败的根因在这里）

位置：`src/lib/echo.functions.ts` 第 738~753 行 `AiPickSchema`。

调整：

- `matchScore`：`z.number().min(0).max(100)` → `z.coerce.number().min(0).max(100).catch(0).default(0)`
  - 让模型漏字段时不再炸 zod，先给 0，后面打分逻辑（第 1963 行 `aiBase`）已经是 `(pick?.matchScore ?? 0) * 0.47`，本来就容忍 0。
- `aiSummary`：`z.string()` → `z.string().catch("").default("")`
- `placeId`：保持必填（这是唯一无法兜底的字段，必须靠 prompt 保证）。
- `verificationStatus`（schema 里目前没有这个字段，prompt 里写了但 schema 没读 —— 一致性问题）：要么从 prompt 里删掉，要么在 schema 里加上 `z.enum(["ok","unknown","fail"]).catch("unknown").default("unknown")`。建议加上，让 prompt 和 schema 对齐。
- `pros` / `cons` 里每个对象的 `text`：当前已经有 string→object 的 preprocess，再加一层缺 text 时 drop 该项的 filter（用 `.transform` 在 `z.array` 外层过滤掉 `text` 为空的项），避免模型给 `{source: "Google"}` 这种残缺对象直接挂 schema。

## 改动二：prompt 重写（采用用户上一条提供的版本，但要瘦身）

位置：`src/lib/echo.functions.ts` 第 1667~1723 行 `buildPromptForGroup` 的模板字符串。

采纳用户提供的新版结构（14 节、对照示例、完整 few-shot），但做两件事让它**更短**而不是更长：

- 删掉第 9 节"料理保真"和第 10 节"条件判断"里的重复枚举（这些细节已经在第 13 节 few-shot 里通过实例体现，规则文字砍掉一半）。
- 删掉第 12 节 pros/cons 那一长串"禁止"清单，浓缩成一句："pros/cons 只引用 reviewHighlights / realWorldReviews / tabelog / yelp 的真实文本，不要写用户需求或筛选条件本身。"
- 第 13 节 few-shot **保留完整**，这是最有效的一招。
- 第 14 节自检清单保留（模型对清单形式响应好）。

目标体积：比当前 prompt 略短或持平，不要变长。

## 改动三：raw fallback 的 JSON 解析更宽松

位置：第 1740~1745 行 `extractJson` 函数。

当前实现只剥一层 ` ``` ` 围栏 + 抓第一个 `{...}`，遇到模型多包一层、或在前面有解释文字时容易漏。改为：

- 先剥所有 markdown 围栏变体（` ```json ` / ` ``` ` / 中文引号包裹）。
- 找首个 `{` 和最末 `}`，截取中间。
- 加一层千分位数字修复（`"matchScore": "85"` → `85`，模型偶尔会输出带引号的数字 / 带千分位逗号的数字）。
- 解析失败时打印前 200 字符到 console，方便后续排查。

## 改动四：第一档去掉 `Output.object` 强约束（可选，A/B 二选一）

`Output.object` 用 schema 做 constrained decoding，schema 字段越多越容易触发 Gemini 的"too many states"或注意力分散。两个方案选一个：

- **方案 A（保守）**：保留 `Output.object`，靠改动一的 schema 容错兜底。命中率应该能到 80~90%。
- **方案 B（激进）**：第一档就用 raw text + zod safeParse，去掉 `Output.object`。命中率上限更高、token 消耗更少，但失去 schema 引导。

建议先上**方案 A**，观察一两天日志，如果第一档仍有 >20% 失败再切方案 B。

---

## 技术细节（给开发同事看）

### schema diff 示意

```ts
// 改前
matchScore: z.number().min(0).max(100),
aiSummary: z.string(),

// 改后
matchScore: z.coerce.number().min(0).max(100).catch(0).default(0),
matchTier: z.enum(["perfect","high","partial"]).catch("partial").default("partial"),
aiSummary: z.string().catch("").default(""),
verificationStatus: z.enum(["ok","unknown","fail"]).catch("unknown").default("unknown"),
pros: z.array(z.preprocess(
  (v) => (typeof v === "string" ? { text: v, source: null } : v),
  z.object({ text: z.string(), source: z.string().nullable().optional() }),
)).catch([]).default([])
  .transform(arr => arr.filter(p => p.text && p.text.trim().length > 0)),
// cons 同上
```

注意：`AiPickSchema` 被三个调用点引用（`Output.object` 的 schema、raw fallback 的 `JSON.parse`、slim fallback 的 `JSON.parse`），改一处全部受益。

### prompt 模板里的固定变量

```text
candidates.length = ${group.candidates.length}
hardFilters.length = ${hardFiltersList.length}
nonHardFilters.length = ${nonHardFilters.length}
```

用户上一条提供的 prompt 里 `cuisine / city / dateTime / humanLanguage / cuisineExpansion` 这些变量目前 `buildPromptForGroup` 还没有全部拼进去，要补齐拼接逻辑（不需要新增数据源，都是 `data.*` 已有字段）。

### extractJson 改造

```ts
const extractJson = (text: string): string => {
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  // 修复带引号的数字字段
  s = s.replace(/"(matchScore|confidence)"\s*:\s*"(\d+(?:\.\d+)?)"/g, '"$1": $2');
  return s;
};
```

---

## 验收

改完后跑一次"早午餐 + 西餐"这种长 prompt 场景，预期日志：

```
[Echo/AI-rank] "美式西餐" Output.object ok in ~30000ms, picks=8
[Echo/AI-rank] "法式西餐" Output.object ok in ~30000ms, picks=8
[Echo/AI-rank] all 14 group(s) done in ~50000ms
```

如果还看到 `raw fallback ok` 或 `slim fallback ok`，看具体哪个字段挂，再针对性补容错。

## 不做的事

- 不动评分公式（第 1962~2032 行的 weighted scoring）。
- 不动候选池筛选逻辑（hard filter 在 AI 之前已经跑过）。
- 不动前端展示。
- 不动 AI 模型选择（继续用 `google/gemini-2.5-flash`）。
- 不引入新的依赖。
