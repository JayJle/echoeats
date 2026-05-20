## 目标

在 `/admin/feedback` 页面：
1. 每条记录支持**单条删除**（用于清掉自己的测试数据）。
2. 顶部加一个**一键清空**按钮（清空全部反馈 + 全部搜索会话）。
3. 删除/清空后，列表与顶部统计卡片**自动刷新**。

## 改动范围

- `src/lib/admin.functions.ts`：新增 3 个 server fn。
- `src/routes/admin.feedback.tsx`：每行加删除按钮、顶部加"一键清空"按钮、删除后重拉数据。
- 不动数据库 schema。`search_feedback` / `search_sessions` 的 RLS 是 deny-all，删除全部走 `supabaseAdmin`（服务端），安全闭环。

## 技术方案

### 1. 新 server fn（`src/lib/admin.functions.ts`）

- `adminDeleteFeedback({ feedbackId })`：删除指定的 `search_feedback` 行。同时把该行关联的 `session_id` 一起删（删 `search_sessions` 对应行）—— 这样一条"测试反馈 + 对应搜索会话"一次清干净。
- `adminDeleteSession({ sessionId })`：直接按 session 删除会话；同时删掉该 session 下所有 `search_feedback`（外键无约束，手动两步 delete）。
- `adminClearAll({ confirm: "CLEAR_ALL" })`：先 delete `search_feedback`，再 delete `search_sessions`。要求传字面量 `"CLEAR_ALL"` 作为二次确认，防止误调用。
- 三个 fn 全部 `await requireAdmin()` 守卫。

返回 `{ ok: true, deleted: { feedback: n, sessions: m } }` 便于前端 toast。

### 2. UI（`src/routes/admin.feedback.tsx`）

- 每条 `FeedbackCard` 右上角加一个小垃圾桶按钮 → 弹 `AlertDialog` 二次确认 → 调 `adminDeleteFeedback` → 成功后从本地 state 移除该项 + 重新拉 `adminGetStats`。
- 顶部统计卡片旁边加一个 **"清空所有数据"** 按钮（红色 destructive variant）→ 弹 `AlertDialog`（文案：「确认清空全部反馈和搜索会话？此操作不可撤销」） → 调 `adminClearAll({ confirm: "CLEAR_ALL" })` → 成功后清空本地 items + 重拉 stats，toast 显示删除条数。
- 删除过程中按钮 disable + loading 状态。

### 3. 没有破坏性影响

- 不动既有 query/list 行为。
- `chosen_from_results` / `chosen_external_name` 这些字段被一起删，因为反馈本来就是依附会话存在的。

---

## 技术小白版描述

现在的 admin 后台只能"看"反馈和搜索记录，不能"删"。这次加两个东西：
- **每条记录右上角加一个垃圾桶按钮**：点了再确认一次就能删掉，专门用来清你自己测试时产生的脏数据。
- **顶部加一个"清空所有数据"按钮**：一次性把所有反馈 + 搜索记录全部清掉（会要求二次确认，防止手抖）。
- 删完之后页面会自动刷新，数字和列表立刻更新，不用手动 F5。

## 用户视角的效果

- 看到自己测试时留下的反馈/搜索记录，点垃圾桶 → 确认 → 这条立刻消失，上方的"近 7 天"统计也同步更新。
- 想从零开始统计真实数据时，点"清空所有数据" → 输入确认 → 整个表都干净了。
- 普通终端用户完全感受不到变化（admin 页面只有你自己能进）。

## 可能存在的负面效果

- **不可撤销**：删了就没了。一键清空尤其要小心 —— 用 `AlertDialog` 二次确认 + 要求传魔法字符串 `"CLEAR_ALL"` 来防误触，但**没有回收站**。如果以后需要"软删除"可以再加 `deleted_at` 列，本次不做以保持简单。
- 删除是按 feedback / session 整体删，不支持"只删反馈、保留会话"这种细粒度（如果有需要可以再加）。
- 若两张表后续接入其它分析视图（目前没有），清空后那些视图也会归零。

## 成本

- 新增 3 个 server fn，零新增依赖、零新增表、零外部 API 调用。
- 删除是 Supabase 直连 SQL，单次成本可忽略不计。
- 不影响 Perplexity / Google Places / Lovable AI 用量。
