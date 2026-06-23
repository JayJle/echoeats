## 问题判断

上一次失败的直接原因是：Pass1 核验节点输出的 JSON 里，部分候选缺少必填字段 `matchScore`。因为结构化输出校验要求每个 `pick` 都必须有 `matchScore`，所以整批被判定为 schema 不匹配，随后进入 raw fallback；fallback 再次解析时仍然缺字段，于是该 batch 返回空 picks，导致耗时被拉长且该组结果质量下降。

## 关于“能不能从 prompt 根治漏 matchScore”

不能 100% 根治。原因是模型生成不是传统程序执行，prompt 可以显著降低漏字段概率，但无法数学保证每次都不漏。真正的工程保证仍然需要 schema / 解析 / 兜底 / 超时这些防护。

但这次按你的要求，先不动兜底和超时逻辑，只把 prompt 里的 `matchScore` 要求凸显到非常明确，让模型在输出前自检：

- 每个 `pick` 必须包含 `matchScore`
- `matchScore` 必须是 JSON number，不允许字符串、不允许 null、不允许省略
- 不确定时也必须给估算分，而不是跳过
- `verificationStatus` 和 `matchScore` 要成对输出
- 输出前逐条检查：候选数 = picks 数，且每个 pick 都有 placeId / verificationStatus / matchScore / hardFilterChecks / matchDetails

## 实施范围

只修改 `src/lib/echo.functions.ts` 里 Pass1 的 `buildVerifyPromptForGroup` prompt 文案。

## 具体修改

1. 在 `# 规则约束` 的 `必须做（DO）` 部分新增高优先级条款：
   - `matchScore` 是强制字段
   - 每家候选都必须给
   - 没有足够证据也要按评分指引给保守分
   - 禁止因为不确定而省略

2. 在 `# 输出约束` 的 Schema 前新增醒目的“字段完整性铁律”：
   - 缺 `matchScore` 等于整个输出无效
   - `matchScore` 必须为 0–100 整数 JSON number
   - 不允许 `"matchScore": "88"`、`"matchScore": null`、漏写字段

3. 在 `matchScore 评分指引` 下面增加“不确定时如何给分”：
   - 硬条件 ok、软偏好不明确：60–74
   - 硬条件 unknown：50–69
   - blocking fail / 料理保真 fail：0–39
   - 不允许因为无法精确评分而省略字段

4. 在 Few-shots 前增加“最终自检清单”：
   - picks 数量必须等于本批候选数
   - 每条 pick 必须含 `placeId`、`verificationStatus`、`matchScore`、`hardFilterChecks`、`matchDetails`
   - 每个 `matchScore` 必须是数字

5. 保持之前“两段 prompt / Pass1 核验 + Pass2 文案”的结构不变，不改变下游 scoring、batch 并发、fallback、模型和业务逻辑。

## 预期效果

这会降低模型漏发 `matchScore` 的概率，并让模型在 prompt 层更重视字段完整性；但它不是绝对保证。如果修改后日志仍然出现漏字段，就说明仅靠 prompt 不够，下一步应再加宽松 schema、batch 超时，或换更稳定的模型。