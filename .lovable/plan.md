## 改动总览
把"匹配详情"的图标判定从**关键词复核**改为 **AI 自己给的置信度分**；AI 写的解释文案**原样展示**，不再二次改写。

## 具体改动（都在 `src/lib/echo.functions.ts`）

### 1. AI 输出结构升级
- `MatchDetailSchema` 和 `HardFilterCheckSchema` 各加一个 `confidence` 字段（0–100），默认 50。
- 在给 AI 的 prompt 里新增铁律：每条 matchDetails 和 hardFilterChecks **必须**返回 `confidence` 整数（0–100），表示对自己这条判断的把握度；只有非常确定（≥85）才给高分，资料不足/猜测请给低分（≤60）。

### 2. 用置信度决定最终图标
- 删掉所有 `reconcileEvidenceStatus(...)` 调用（关键词复核逻辑保留函数体但不再调用，避免影响其他地方）。
- 新规则（仅用于非硬条件 + 非评分类硬条件）：
  - `confidence >= 70` → 沿用 AI 给的 status（ok/fail/unknown）
  - `confidence < 70` → 一律强制为 `unknown`
- **评分类硬条件不变**：`verifyGoogleRatingFilter` 用真实数字直接判定，AI 说什么都不算。

### 3. 文案不再二次改写
- 保留最基础的清理：去 emoji、过长截断、去掉条件前缀重复 —— 不动语义。
- AI 写的 evidence 句子原样展示。

## 不动的部分
- 候选店检索、清单顺序与条数、pros/cons 模块、Google 评分硬比对 —— 全部不变。

## 验收
重跑你那条 "thick cut beef" 案例：AI 应自评低置信度 → 显示 ⚠️ 而不是 ✅。