## 目标

优先通过**优化 prompt**，让首跑（`Output.object`）直接通过 schema 校验，不再触发后面 60–90 秒的 raw / slim 兜底，也不再触发模糊复核的第二次调用。

不动 schema、不动兜底链结构、不动并行/超时逻辑。如果 prompt 改完日志还是经常掉到兜底，再考虑结构性改动。

---

## 现状（基于代码 + 日志）

`buildPromptForGroup`（L1810–L1876）现在的"输出说明"只有最后一行：

```text
输出 JSON 格式：{ "picks": [{ "placeId": "...", "verificationStatus": "ok", "matchScore": 88, ... }] }
（注：此处 picks 数组应包含所有核验过的餐厅，不仅仅是推荐的）
```

但实际 schema（`AiPickSchema`, L788）有 8 个字段，其中**模型经常漏的两个**就是日志里反复报错的：
- `matchScore`（必须 0–100 整数）—— 模型有时只给 `matchTier` 不给分
- `pros[i].text` / `cons[i].text`（每项必须是 `{text, source?}` 对象）—— 模型常返回纯字符串数组

prompt 里 `## pros / cons 写作规范` 那一段全在讲"写什么内容"，**完全没说"输出结构是 {text, source} 对象"**，所以模型按自然语言习惯输出字符串数组。`matchScore` 也只在最后那行示例里一笔带过，没强调"必填、整数、0–100"。

`Output.object` 用的是 Gemini constrained decoding，但 Gemini Flash 在长 prompt + 复杂嵌套 schema 下仍会偶发漏字段——这种情况**只能靠 prompt 强约束 + few-shot 示例来压低概率**。

---

## 改动方案（只动 `buildPromptForGroup`）

### 1. 在 prompt 末尾追加"输出结构硬约束 + 完整示例"段

替换现有最后两行（L1874–L1875）为一段**自包含的输出契约**，包含：

- 每个 pick **必填字段清单**（8 个），逐条说明类型与取值范围
- `matchScore` 单独强调：**必填 0–100 整数；缺失或写成字符串都会被判失败**
- `pros / cons` 单独强调：**每一项必须是 `{"text": "...", "source": "Google" | "Tabelog" | "Yelp" | null}` 对象，禁止写成纯字符串**
- 一段**完整的 1-pick 示例 JSON**（含 hardFilterChecks 一项、matchDetails 一项、pros 一项、cons 一项），让模型有 few-shot 锚点
- 一句"在返回前自检：每个 pick 是否都包含 matchScore、pros/cons 是否都是对象"

### 2. 把"输出契约"提到 prompt 中部、紧跟候选数据之后

现在输出规范散落在三处：L1819（开头一句）、L1865–L1872（pros/cons 写作）、L1874（末尾示例）。Gemini 在长 prompt 下对**末尾几百字**注意力最高。把完整结构契约 + 示例放在 prompt 最末（在"铁律"和"pros/cons 规范"之后），让模型生成 JSON 之前最后看到的就是结构示例。

### 3. 给 `pros / cons 写作规范` 段补一条结构约束

在现有那段开头加一句：
> **结构铁律**：pros / cons 数组的每一项必须是 `{"text": "评论原话或概括", "source": "Google" | "Tabelog" | "Yelp" | null}` 对象；禁止写成纯字符串数组。

### 4.（可选小幅改动）`rerankSuffix` 同步约束

复核分支也容易触发同样的 schema 错误。在 `rerankSuffix` 末尾追加一句"输出结构同首跑要求，不要省略 matchScore 和 pros/cons 的 text 字段"。

---

## 验证方式

改完后无需 schema 改动，直接观察 published worker 日志（关键词 `Echo/AI-rank`）连续 5–10 次搜索：

| 指标 | 现状 | 目标 |
|---|---|---|
| `Output.object ok` 直接命中率 | 偶发失败（韩国料理这次 0/3 batch 通过首跑）| ≥ 80% batch 一次通过 |
| `raw fallback failed (matchScore Required …)` warn | 反复出现 | 消失 |
| `raw fallback failed (pros[*].text Required …)` warn | 反复出现 | 消失 |
| 整轮 `all N group(s) done in …` | 158s | ≤ 60s |

若改完后仍频繁掉到 raw/slim，再来谈第二步（跳过 raw fallback / 缩小复核范围 / 单组预算超时）。

---

## 不在范围（本轮）

- 不改 `AiPickSchema` / `AiPickGroupSchema`
- 不改 `rankOneGroup` 的兜底链结构与重试次数
- 不改 fuzzy 复核触发条件
- 不改 batch 大小 / 并行度
- 不改去重、hard/negative filter 处理

## 风险

- prompt 加长可能挤压模型输出 token —— 现在 `maxOutputTokens: 12000` 充足，新增内容预计 < 500 token，可忽略。
- few-shot 示例可能让模型"模仿示例语气"而不是真核验数据 —— 示例里的店名/字段值用明显占位符（如 `"placeId": "<示例占位>"`、`"text": "示例：多位食客称赞…"`）规避。

确认后我就只改 `buildPromptForGroup` 这一个函数，跑一轮日志再回来对齐下一步。
