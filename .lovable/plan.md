# 项目架构技术细节文档

产出一份中文技术文档，目标是「别人照着它能复刻 Echo Eats」。文档位置：`docs/ARCHITECTURE.md`（新建 `docs/` 目录）。

内容全部从现有代码逐行核对后写入，不凭记忆描述；涉及 Prompt 的部分原文摘录，涉及 Schema 的部分按代码里的 zod 定义写。

## 文档结构

1. 产品概述与技术栈
   - TanStack Start v1 + React 19 + Vite + Tailwind v4、Cloudflare Workers 运行时、Lovable Cloud（Supabase）
   - 目录结构说明（`src/routes` 页面与 API、`src/lib/*.functions.ts` 服务端 RPC、`*.server.ts` 服务端专用模块）
2. 端到端 Workflow 总览
   - 文字流程 + ASCII 流程图：城市校验 → 需求对话/解析 → 语义去重 → 品类扩写 → 8 路召回 → place 去重与 POOL_CAP=30 → 前置硬过滤 → 外部点评抓取（Tabelog / Yelp / Perplexity）→ 三段式 AI（Verify / Score / Copy）→ JS 综合打分 → Top 结果页 → 反馈落库
3. 逐节点详解（每节统一小标题）
   对每个节点写：所在文件与函数、输入 / 输出 Schema、调用的模型或 API、Prompt 原文、执行规则、并发与超时、失败与兜底策略、日志字段
   - 城市校验与自动补全（`city.functions.ts` + `google-places.server.ts` autocomplete）
   - 需求解析 `parseRequirements`（Qwen、raw JSON + 手动 zod 校验、self-repair、`applyHalfPeriodFix` 时间修正、否定语气保留）
   - 语义聚类去重 `semanticClusterMerge`（合并同义意图、保留最高权重、`[AVOID]` 前缀规则）
   - 品类扩写 `cuisine-expand.server.ts`（qwen-turbo）
   - 8 路召回（各路 query 模板、Google Places Text Search 参数、语言/地区推断）
   - 跨品类 place_id 去重与最佳品类归属、POOL_CAP=30
   - 确定性硬过滤（含 `checkGoogleRatingFilter` 的评分正则与「X 分钟」误判防护）
   - 点评抓取层：`tabelog.server.ts`、`yelp.server.ts`、Perplexity（sonar / sonar-pro）、`review_cache`、`retry.server.ts` 重试策略
   - Pass 1 Verify（raw `generateText` + 手动解析、verificationStatus、matchDetails、JSON 重试）
   - Pass 2 Score（只输出 `{placeId, matchScore}`、miss-only 重试、缺失回落 60）
   - Pass 3 Copy（Top 5 文案：summary / pros / cons）
   - JS 综合打分与排序、照片补全
   - 结果页与反馈（`results.tsx`、`feedback.functions.ts`、`search_sessions` / `search_feedback`）
   - 管理后台 `admin.functions.ts` / `admin.feedback.tsx`
4. Schema 汇总
   - 前后端共享的解析结果结构、三段 AI 的输入/输出 Schema、Google Places 归一化结构、数据库表结构（含 RLS/GRANT 说明）
5. 模型选型与网关
   - `ai-gateway.ts`：DashScope/Qwen 接入方式；qwen-plus / qwen-max / qwen-turbo 各自用途与理由；Perplexity 的保留原因；为什么用 raw JSON + 手动 zod 而不是结构化输出
6. 外部工具与 API 清单
   - Google Places (New)、Perplexity、DashScope、Firecrawl/抓取、ElevenLabs（`api/transcribe`）、所需 Secret 名称
7. 可观测性与运维
   - `echoLog` 日志规范（stage / start / ok / fail、`_currentStage` 游标）、耗时统计口径、常见故障与定位方法
8. MCP / Agent 集成
   - `/mcp` 端点、`suggest_cities` 与 `find_restaurants` 工具定义、OAuth（Supabase 授权服务器 + `/login` + `/.lovable/oauth/consent`）
9. 复刻清单
   - 从零搭建的步骤顺序、必需环境变量、数据库迁移要点、验证方式

## 技术细节

- 只新增 `docs/ARCHITECTURE.md`，不改任何运行代码。
- Prompt 摘录保持与代码一致（含 emoji 标记的铁律段落），如有截断会标明出处行号。
- 文档内所有函数引用带 `文件:行号` 便于对照。
