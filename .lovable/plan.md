## 现状（先把"现在怎么处理 hard / neg"摊清楚）

文件：`src/lib/echo.functions.ts` 候选打分段（约 L2020–2169）。

### Hard filter 不满足
1. **准入层**：`weight >= 0.85` 且 status=fail → `admitted=false` → finalScore 压到 ≤ 30 → 进 **failedRestaurants** 桶（不展示在正常列表里）。
2. **扣分**：fail 扣 `weight × 10.7`；unknown 扣 `weight × 2.7`。
3. **verificationStatus**：fail → "fail"；unknown → "unknown"；都没有 → "ok"。
4. **needsReview**：由 verificationStatus 派生。

### Negative filter 命中（当前，不一致）
1. 准入层阈值同样是 `weight >= 0.85`，会让 `admitted=false`。✓ 这一档已经一致。
2. **扣分系数不同**：fail 扣 `weight × 13.3`（比 hard 重），unknown **不扣**。
3. **不进 verificationStatus**：哪怕 neg fail 也只显示 "ok"，UI 上看起来"明明命中避雷却没被标 ✗"。
4. 因此 needsReview 也不会因 neg 命中而触发。

→ 这就是你看到的"hard 不符的店还在列表里"那种感觉的来源之一：当 neg 命中、weight < 0.85 时，店仍然 admitted，且 verificationStatus 仍标 "ok"。

## 修改目标

把 negative 完全按 hard 的同一套流程处理；hard 怎么算分、怎么进桶、怎么显示，neg 就一字不差跟上。

## 改动

文件：`src/lib/echo.functions.ts`

1. **扣分对齐**（L2130–2138）
   - neg fail：`weight × 13.3` → `weight × 10.7`
   - neg unknown：新增 `weight × 2.7`
   - 标签拆成"避雷命中扣分 / 避雷待核实扣分"，与"硬条件扣分 / 硬条件待核实"同构。

2. **verificationStatus 把 neg 纳入**（L2041–2045）
   - `hasBlockingFail` 改为：hard fail(≥0.85) **或** neg fail(≥0.85)。
   - `hasUnknown` 改为：hard unknown **或** neg unknown。
   - 这样 needsReview 自动跟着触发，UI 桶分（ok / unknown / fail）也自动一致。

3. **准入层不变**：现在 hard 和 neg 都已经是 `weight >= 0.85 → admitted=false`，保持。

4. **桶分不变**：不满足硬条件的店现在是放进 `failedRestaurants`（不是物理剔除），neg 命中走同一条路。这是你说的"按 hard 怎么处理就怎么处理"。

## 不在本次范围

- 不调"是否物理剔除 vs 进 failed 桶"的策略（用户说先按 hard 一致即可，hard 现状是进 failed 桶）。
- 不调 0.85 这个准入阈值。
- 不动 AI prompt 中 neg/hard 的拆分规则。

## 验证

跑一组同时含 hard 和 neg 的输入（例：`必须可预约；不要游客店`），观察：
- 命中避雷的店 verificationStatus 显示 "fail" / "unknown"，与硬条件不满足的店表现一致。
- scoreBreakdown 里 neg 扣分系数与 hard 同档（10.7 / 2.7）。
- 重 weight (≥0.85) neg 命中的店落入 failed 桶。