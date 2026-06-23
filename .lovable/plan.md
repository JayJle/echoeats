# 修复 AI-score PARTIAL fallback60（最小改动）

## 现象
上次 brunch 日志里出现 2 个 batch PARTIAL：
- `法式西餐#n=10` → scored 10/10 fallback60=1 missing=["ChIJB0t…"]
- `早餐店#n=8` → scored 8/8 fallback60=1 missing=["ChIJI0t…"]

含义：`Output.object` 成功返回了一个 score 数组，但里面**少了 1 个 place_id**，缺的那家被一刀切判 60 分。

## 根因
Gemini 在 schema 约束下偶尔会漏 1 个数组元素（不是 schema 错、不是解析错，就是"忘了写"）。当前代码只要 Output.object 不 throw 就直接 finalize → 漏的全部 60 分兜底。

## 方案（不改 prompt、不改 schema）
在 `src/lib/echo.functions.ts` `rankScoreGroup`（~2093-2180）里，**在 finalize 判定 PARTIAL 之前插一次 miss-only 重试**：

1. Output.object 首发拿到 `parsed.scores`
2. 算 `missingIds = expectedIds.filter(id => !returnedMap.has(id))`
3. 如果 `missingIds.length === 0` → 走原 finalize（ok）
4. 否则用**同一个 prompt 构造函数**对一个子 group 跑一次 Output.object：
   ```ts
   const retryGroup = {
     cuisine: group.cuisine,
     candidates: group.candidates.filter(c => missingIds.includes(c.placeId))
   };
   const retryPrompt = buildScorePromptForGroup(retryGroup);
   const retry = await generateText({ model, prompt: retryPrompt, maxOutputTokens: 1000, output: Output.object({...}) });
   ```
5. 合并 `retry.output.scores` 进首发结果数组，再调 finalize
   - modeLabel 改成 `"Output.object+miss-retry"` 便于日志区分
6. 还缺的（极少概率） → finalize 内部继续 60 分兜底（保留现有逻辑）
7. 重试本身如果 throw → 吞掉错误，直接走原 finalize（partial），不阻塞主流程

外层 `catch (e1)` 的 raw-fallback / `fallbackAll` 路径**完全不动**。

## 不动的部分
- buildScorePromptForGroup（prompt 一字不改）
- AiScoreGroupSchema
- Output.object 调用方式
- rankVerifyGroup / Pass2 文案 / AI-copy
- 日志格式（仅 modeLabel 加后缀 `+miss-retry`）

## 预期效果
- 漏 1-2 个 id 的 PARTIAL 大概率被补齐（typical retry 成功率 ~95%+）
- 极端情况仍 fallback60（兜底安全网保留）
- 单次重试只针对 missing 子集（1-2 家），<1s 额外延迟，无明显成本

## 验证
跑一次 brunch / 任意多 cuisine 查询，看日志：
- 期望大部分 batch 仍是 `ok (Output.object)`
- 出现 missing 时变成 `ok (Output.object+miss-retry)`
- `PARTIAL (Output.object+miss-retry)` 极少出现，`fallback60=0` 占比显著上升
- `[Echo/AI-rank]` 汇总行 `fallback60=` 数应从 ~2/batch 降到 ~0
