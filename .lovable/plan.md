# 三段式 AI 流水线改造方案

把原来的 Pass1（核验+打分+文案）拆成三段独立调用，每段单独 schema、单独日志、单独兜底。目标：彻底解决 `matchScore` 漏发，并让任何一段失败都能精确定位。

## 一、Pass 拆分

### Pass1 —— 纯核验
- 输入：候选餐厅基础信息 + 用户硬条件/软偏好
- Schema `AiVerifyPickSchema`：仅 `placeId` / `verificationStatus` / `hardFilterChecks[]` / `matchDetails[]`
- 不再输出 `matchScore` / `aiSummary` / `pros` / `cons`
- prompt 重点：硬条件证据加权 → `fail / unknown / ok`，禁止跨候选比较，禁止幻觉

### Pass2 —— 纯打分（新增）
- 输入：Pass1 的核验结果 + 候选基础信息
- Schema `AiScoreSchema = z.object({ scores: z.array(z.object({ placeId: z.string(), matchScore: z.number().int().min(0).max(100) })) })`
- prompt 极简：只让模型输出整数分，禁止任何其它字段、禁止字符串/null/"unknown"
- 输出后回填到 Pass1 的 picks

### Pass3 —— 文案（原 Pass2 不动）
- 仅在 Pass2 完成、`matchScore` 已回填后，对 Top N 生成 `aiSummary / pros / cons`

## 二、Pass2 失败兜底（按你确认）

| 情况 | 兜底 |
|---|---|
| Pass2 整段失败（超时/解析失败/schema 失败） | 该 batch 所有候选 `matchScore = 60`，verification 保留，继续进入 Pass3 |
| Pass2 部分缺失（partial） | 缺失的 placeId 兜底 `matchScore = 60`，其余正常 |
| 兜底命中时 | 该 pick 打 `scoreFallback: true` 标记（仅日志/调试用，不影响前端展示） |

60 是中性值，避免兜底数据把好的挤掉或把差的捧上来，对排序影响最小。

## 三、全节点失败日志（关键）

每一段调用都打三条日志：start / 结束 / 异常，包含 batchId、候选数、耗时。

```text
[Echo/AI-verify] batch=<id> n=<count> start
[Echo/AI-verify] batch=<id> ok in <ms>ms picks=<n>
[Echo/AI-verify] batch=<id> FAILED in <ms>ms reason=<schema|timeout|parse|http> err=<msg>

[Echo/AI-score]  batch=<id> n=<count> start
[Echo/AI-score]  batch=<id> ok in <ms>ms scored=<n>
[Echo/AI-score]  batch=<id> PARTIAL in <ms>ms scored=<n>/<expected> missing=[placeId...]
[Echo/AI-score]  batch=<id> FAILED in <ms>ms reason=<...> err=<...>  → 全量兜底 60

[Echo/AI-copy]   batch=<id> n=<topN> start
[Echo/AI-copy]   batch=<id> ok in <ms>ms
[Echo/AI-copy]   batch=<id> PARTIAL missing=[placeId...]
[Echo/AI-copy]   batch=<id> FAILED reason=<...> err=<...>
```

额外汇总日志（一次 echo 请求结束时）：

```text
[Echo/Summary] req=<id> batches=<n> verify(ok/fail)=a/b score(ok/partial/fail)=a/b/c copy(ok/partial/fail)=a/b/c fallback60=<n>
```

→ 以后任何 batch 出问题，直接 grep 一行就能定位是哪一段挂的、挂在哪几个 placeId。

## 四、改动范围

仅改 `src/lib/echo.functions.ts`：
1. 拆 prompt：`buildVerifyPromptForGroup`（去掉 matchScore 相关段）/ 新增 `buildScorePromptForGroup` / 保留 `buildCopyPrompt`
2. 拆 schema：`AiVerifyPickSchema`（去 matchScore）/ 新增 `AiScoreSchema` / 保留文案 schema
3. 拆调用：`runVerifyPass()` → `runScorePass()` → `runCopyPass()`，串行
4. `expandToFullPick` 临时 `matchScore=0`，等 Pass2 回填；Pass2 失败/缺失则回填 60
5. 全节点日志按上文格式插入

不改：业务打分公式、批次并发、模型、前端、Supabase。

## 五、预期效果

- Pass2 输出只有 2 个字段，模型几乎不可能漏 → matchScore 漏发问题根治
- 任一段失败都不再"整 batch 丢"：verify 失败才丢整批，score/copy 失败都有兜底
- 日志可逐段追责，下次再出问题能直接说"是 Pass2 在 batch X 超时，已兜底 60"

待你批准后开始实施。
