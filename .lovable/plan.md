## 修正三点理解

1. **中国大陆地区**：拦截逻辑保留（首页一进来还是要拦截）。要抛开的是**拦截之后的业务链路**——parse / search / verify / score / copy 这些主流程里不再有任何"如果是大陆城市就走 XXX"的分支、特殊 prompt、特殊搜索路径。也就是说：拦截层完整保留，主 workflow 里完全没有大陆概念。
2. **JSON 模式全量启用**：所有模型步骤输出都是 JSON，所以每一步都强制走模型 JSON 模式，schema 来自集中合同文件，强制本地 Zod 校验兜底。Verify Pass 之前遇到的 structured output 空响应问题，通过缩小 batch + 简化 schema + 合同层 sanitize 来解决，而不是回落 raw JSON。
3. **Agent 内部有 planner**：Agent 拿到任务后先做拆解（planner），决定调用哪些 skill、以什么顺序、是否需要 retry/降级，然后执行，最后组装输出。Skill 是 Agent 的能力单元，不直接暴露给 workflow。

---

## 架构

```text
User Input
  ↓
[Region Guard]  ← 大陆城市拦截，只在这层出现
  ↓ (通过)
Workflow Orchestrator
  ├─ RequirementParsingAgent      (planner + skills)
  ├─ RestaurantSearchAgent         (planner + skills)
  └─ RestaurantRankingAgent        (planner + skills)
  ↓
FinalResult (合同校验后)
```

Region Guard 之后，链路里不再出现任何大陆地区判断。

---

## 集中合同文件（唯一事实源）

新增：

```text
src/lib/echo-contracts.ts
```

集中放：

- Workflow 输入/输出 Schema
- 每个 Agent 输入/输出 Schema
- 每个 Skill 的模型调用 Schema（输入 DTO + 输出 Schema）
- JSON 模式配置（每个 schema 显式声明是否用 `Output.object` + schema 名）
- 默认值规则
- sanitize / 兜底策略
- TypeScript 类型导出

原则：

- prompt 不再手写"请返回如下 JSON"，直接引用合同里的字段清单。
- 所有模型输出必须过合同 Zod parse，parse 失败进入合同定义的兜底策略。
- Schema 尽量小、扁平、无长 enum，避免 Gemini structured output 状态机爆炸。
- 候选池这种"动态列表"不塞进 schema enum，让 schema 保持稳定；ID 校验在 Zod 后置。

---

## Agent 通用结构（含 planner）

每个 Agent 文件结构类似：

```text
src/lib/agents/<agent-name>.server.ts

- AgentInput (from 合同)
- AgentOutput (from 合同)
- planner(input): 返回 skill 调用计划 (steps, batchSize, retryPolicy)
- executor(plan): 顺序/并发执行 skill
- assembler(results): 组装最终 AgentOutput
- 日志: agent.start / step.start / step.ok / step.fail / agent.ok
```

Skill 结构：

```text
src/lib/skills/<skill-name>.server.ts

- SkillInput / SkillOutput (from 合同)
- run(input): 单一职责执行
- 内部若调用模型：强制 JSON 模式 + 合同 Schema + Zod sanitize
```

---

## RequirementParsingAgent

Planner 决策：

- 输入长度 / 语种 → 决定是否需要语义去重
- 是否包含时间 → 是否需要 TimeNormalizationSkill
- 是否包含料理关键词 → 是否需要 CuisineInferenceSkill

Skills：

- `RequirementExtractionSkill`（JSON 模式）
- `SemanticDedupSkill`（JSON 模式）
- `TimeNormalizationSkill`（JSON 模式 + 代码半区兜底）
- `CuisineInferenceSkill`（JSON 模式，最多 1-2 个）

---

## RestaurantSearchAgent

Planner 决策：

- 城市 / 料理数 → 决定启用哪几路
- 候选池目标数 → 决定 POOL_CAP 和是否需要 enrichment
- 是否启用 Yelp / Tabelog（根据城市/语言）

Skills：

- `CuisineExpansionSkill`（JSON 模式）
- `MultiRouteSearchSkill`（Google Places 调用，规则）
- `EnrichmentSkill`（Yelp / Tabelog，规则）
- `GlobalDedupSkill`（规则，保证 placeId 不丢失）

---

## RestaurantRankingAgent

Planner 决策：

- 候选数 → verify batch size
- verify 结果分布 → 是否需要 score miss-only retry
- top N → copy pass 是否启用

Skills：

- `VerificationSkill`（JSON 模式，小 batch，schema 扁平）
- `MatchScoreSkill`（JSON 模式，schema 极小，缺失走 miss-only retry，最终兜底 60）
- `CopywritingSkill`（JSON 模式，仅 top N）
- `PhotoResolutionSkill`（规则）

---

## JSON 模式统一规则

全部模型调用一律：

- 使用 AI SDK `Output.object` + 合同 schema
- schema 保持小、扁平、无动态 enum、无 pattern/format/长度约束
- prompt 不再重复"必须返回 XXX 字段"，改为引用合同字段清单
- 输出后强制 Zod parse，parse 失败按合同定义兜底
- Verify Pass：减小 batch（例如 6/组）+ schema 去掉可选字段，保证 JSON 模式稳定
- Score Pass：schema 只有 `[{ placeId, matchScore }]`
- Copy Pass：schema 只有 `[{ placeId, aiSummary, pros, cons }]`

如果某个 batch JSON 模式仍失败：

- 记录 fail
- 触发合同定义的 fallback（miss-only retry / 缩小 batch retry / 兜底默认值）
- 不再走 raw JSON parse 分支，保持链路统一

---

## Workflow Orchestrator

新增：

```text
src/lib/echo-workflow.server.ts
```

职责：

- 顺序驱动三大 Agent
- 派发 progress event
- 记录每个 Agent、每个 Skill 的耗时 / 输入数 / 输出数 / 失败 / 兜底次数
- 所有节点失败都必须记录，不允许静默
- 最终结果统一过 `FinalResultSchema` 校验再返回

---

## 中国大陆地区处理（修正）

- 保留：入口 Region Guard 拦截（沿用现有拦截规则）。
- 拿掉：主 workflow 里所有大陆分支、特殊 prompt、特殊搜索路径。
- 拦截后不进入 workflow；进入 workflow 的输入一律视为国际城市。

---

## 日志

统一 helper：`src/lib/echo-observability.server.ts`

每个 skill 调用都要记录：

```text
workflowId / agent / skill / status / durationMs
inputCount / outputCount / missingCount / fallbackCount
jsonMode=on / schemaName / errorType / errorMessage
```

关键聚合日志：

```text
[Echo/workflow] start
[Echo/parse] ok ...
[Echo/search] ok routes=... unique=... lost=0
[Echo/verify] ok batches=... jsonModeFail=... fallback=...
[Echo/score] ok missing=... retryRecovered=... fallback60=...
[Echo/copy] ok topN=...
[Echo/workflow] ok totalMs=...
```

---

## 迁移策略

外部接口不变，内部替换：

1. 保留 `echo.functions.ts` 作为对外 server function 壳。
2. 内部改成调用新 workflow。
3. 前端 progress event 名称保持兼容或做映射。
4. 完成后旧代码路径逐步废弃。

---

## 实施顺序

1. `echo-contracts.ts` 合同文件（含所有 schema + JSON 模式声明）
2. `echo-observability.server.ts` 统一日志
3. Skill 层实现（每个 skill 单一职责，全部 JSON 模式）
4. 三个 Agent（含 planner）
5. Workflow Orchestrator
6. 把 Region Guard 保留在入口，workflow 内部彻底去除大陆判断
7. `echo.functions.ts` 改为调用新 workflow
8. 用 Brunch / Sushi / Ramen / Steak 等查询跑一遍验证日志、耗时、fallback

---

## 验证标准

- Region Guard 依旧能拦截大陆城市，且拦截后 UI 行为与现在一致
- workflow 内部代码搜索不到任何大陆关键词判断
- 所有模型调用日志都显示 `jsonMode=on`
- Verify / Score / Copy 每一步 schema 校验成功率显著提升
- Score Pass fallback60 明显下降
- Verify Pass 不再出现"No output generated" 之后 raw fallback 拖慢整体
- 前端结果结构不变