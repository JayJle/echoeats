## 问题定位

你截图里两个问题是不同的根因，分开修。

### 问题 A：matching detail 全英文（中文模式下）

每条 matching detail 长这样：`{条件}：{证据}`。
- **条件**（"Google rating 4.0+"、"thick cut beef"）来自最初解析需求时存下来的 `hardFilters/dishPreferences` 文本。这些是你最初输入里就带的英文片段（或解析阶段没翻译），先按"用户原始输入"对待，不强行翻译。
- **证据**（"Reviews emphasize..."、"The address in Chuo Ward..."）来自 AI 详筛阶段的 `matchDetails[].label` 和 `hardFilterChecks[].note`。**这一段必须是中文，AI 现在没按要求翻译，是 prompt 不够严格的问题。**

对比中英两条语言指令：
- 英文（`isEn=true`）：写得很严，明令"零容忍 / 禁止 CJK 字符 / 给出 Bad vs Good 示例"。
- 中文（`isEn=false`）：只有一句"必须用简体中文撰写"——AI 看到候选里有大量日文/英文评论，就顺手照搬了原文。

### 问题 B：明明不符合，却显示 ✓（状态与文案不一致）

例：`thick cut beef：Reviews praise various aspects of meat but do not specifically mention thick-cut beef`，AI 给了 `status=ok`。

代码里有个 `reconcileEvidenceStatus` 函数本来是用来修正这种情况的，但它**只在 `status === "unknown"` 时才会触发**。也就是说：
- AI 说 unknown，但文案明确支持 → 修正为 ok ✓ （现在能修）
- AI 说 ok，但文案明确没提到/否定 → **不会被修**（当前 bug） ✗
- AI 说 ok，但文案表达不确定（"可能、未明确提及"）→ **不会被修** ✗

所以"显示 ✓ 但文案是否定/不确定"的组合一直漏掉。

---

## 修复方案

### 1. 加强中文模式的 langDirective（echo.functions.ts）

把中文版本改成跟英文版本同等严格的版本，包含：
- 强制语言："**所有人类可读字符串字段**（aiSummary、pros、cons、matchDetails[].label、hardFilterChecks[].note）必须用简体中文"
- 零容忍规则：禁止整段拉丁字符堆砌；如果原始评论是日文/英文，**必须转写为简体中文**，不要保留原文再翻译
- 给出 Bad vs Good 示例，告诉它"Reviews emphasize... → 评论强调..."、"The address in Chuo Ward... → 地址位于札幌中央区..."
- Rule of thumb：如果 matchDetails[].label 或 hardFilterChecks[].note 整句没有任何 CJK 字符，输出无效，必须重写

效果：让 AI 在中文模式下产出的证据稳定是中文。

### 2. 双向修正 `reconcileEvidenceStatus`（echo.functions.ts）

扩展逻辑，覆盖三种漏修方向：

| AI 给的 status | 文案模式 | 应修正为 |
|---|---|---|
| ok | 包含否定（"do not mention"、"未提及"、"没有提到"、"but...not"、"但...没"）→ **新增** | unknown |
| ok | 包含不确定（"可能/maybe/likely/未明确"）→ **新增** | unknown |
| ok | 包含明确反例（"does not match"、"明显不符合"、"contradicts"）→ **新增** | fail |
| unknown | 包含明确正向（已有逻辑） | ok |
| unknown | 包含否定/不确定（已有逻辑） | unknown（保持） |
| fail | 文案完全正向（"明确符合"）→ **新增**（罕见，作保险） | unknown |

核心改动：新增**否定/不确定关键词识别**，能从 `ok` 向 `unknown/fail` 降级。
中英文双语模式：
- 中文："未(明确|具体|直接|特别)?(提及|说明|提到|强调|确认)"、"没有(具体|明确|特别)?(提及|说明|提到)"、"但.{0,15}(没|未|不|无)"、"暂无"、"无法确认"
- 英文：`do(es)?(n't| not)\s+(specifically|directly|clearly|explicitly|particularly)?\s*(mention|state|confirm|note|reference)`、`no (specific|direct|clear|explicit)\s+(mention|reference)`、`but\s+.{0,20}\b(not|no)\b`、`however\s+.{0,20}\b(not|no)\b`、`fail(s)? to`、`without (specific|clear|direct)`

### 3. 应用到所有写入点

`hardFilterChecks` 在 1850 行已经调用了 reconcileEvidenceStatus，`matchDetails` 在 1875 行也调用了——只要把函数本身改强，两个入口都会一起修好，不需要改调用点。

---

## 文件改动

仅 1 个文件：

**`src/lib/echo.functions.ts`**
- 改 `langDirective`（约 1615-1617 行）：中文版重写为严格版（带 Bad/Good 示例 + 零容忍规则）
- 改 `reconcileEvidenceStatus`（约 859-875 行）：双向修正，新增否定/不确定/反例的关键词集合，允许从 `ok` 向 `unknown/fail` 降级

---

## 不在本次修复范围

- **条件文本里残留的英文**（"thick cut beef"、"Google rating 4.0+"）：这些是解析阶段就存下来的原始输入，属于"用户原话"的范畴。如果你也希望在中文模式下把这些条件文本也强制翻译成中文，可以另开一个任务，在 parseRequirements 的 prompt 里加一条"hardFilters/softPreferences/dishPreferences 内的中英文/日文混杂表达必须统一翻译为简体中文"。

- **AI 完全幻觉的状态判定**（证据正确但结论本身错）：本次只修"状态 vs 文案不一致"的机械性 bug；如果 AI 本身就误判了证据强度（比如把模糊评论当成强支持），属于模型判断力问题，得靠模型升级或多轮校验，不在这里处理。

---

## 验收

- 中文模式下重跑一次烤肉搜索，所有 matching detail 的证据部分应该是中文；
- 截图里 `thick cut beef：... do not specifically mention thick-cut beef` 这类条目应该显示为 ⚠（unknown）而不是 ✓。
