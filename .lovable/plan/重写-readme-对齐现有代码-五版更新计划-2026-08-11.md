# 重写 README（对齐现有代码）+ 五版更新计划

## 为什么要改

现在的 `README.md` 与代码已经不一致，实测核对结果：

- 写着模型是 `google/gemini-2.5-flash` / `openai/gpt-5-mini` / Lovable AI Gateway —— 实际全部 LLM 走阿里云 DashScope 通义千问（`qwen-plus` 主力、`qwen-max` 仅重试、`qwen-turbo` 仅品类扩展），网关文件 `src/lib/ai-gateway.ts` 里的 Lovable 命名只是历史别名。
- 写着"中国大陆走大众点评 + Firecrawl 评论抓取"、依赖 `FIRECRAWL_API_KEY` / `LOVABLE_API_KEY` —— 全仓已无 firecrawl / 大众点评 相关代码，这两个密钥也不再使用。
- 没有提到当前已存在的能力：三段式排序（Pass 1 核验 / Pass 2 打分 / Pass 3 文案）、多路召回 + 跨品类去重 + 候选池上限、语义聚类需求去重、否定语气保留、流式结果、MCP + OAuth 对外 Agent 集成、`docs/ARCHITECTURE.md`。

## 新 README 结构

1. 项目简介 + 在线地址
2. 核心能力（按现有代码逐条：城市校验、需求结构化解析、语义去重、多路召回、真实数据、区域点评源、三段 AI 排序、三层打分、流式输出、双语、语音输入、反馈闭环 + 管理后台、MCP 集成）
3. 技术栈表（TanStack Start v1 / React 19 / Vite 7 / Tailwind v4 / zustand / Cloudflare Workers / Lovable Cloud）
4. 模型选型表（qwen-plus / qwen-max / qwen-turbo / Perplexity sonar·sonar-pro / ElevenLabs scribe_v2，各自用在哪个节点）
5. 外部服务与数据源（Google Places、Perplexity、ElevenLabs；说明只有 Google Places 是官方店铺 API）
6. 页面与路由一览（`/`、`/cuisines`、`/requirements`、`/results`、`/login`、`/admin/feedback`、`/mcp`、`/api/transcribe`）
7. 工作流一句话流程图（引用 `docs/ARCHITECTURE.md` 看细节）
8. 本地运行 + 需要的 Secrets（只保留 `QWEN_API_KEY`、`PERPLEXITY_API_KEY`、`GOOGLE_PLACES_API_KEY`、`ELEVENLABS_API_KEY`）
9. 版本更新计划（见下）
10. License

## 版本更新计划（重写为 5 版，只写"现在依然存在"的改动）

- **v1 — 端到端骨架**：多步输入（城市 → 品类 → 需求）+ 结果页；zustand + sessionStorage 跨页状态；服务端 `createServerFn` 主干；AI 结构化解析需求（硬性 / 软性 / 负向 + 权重）。
- **v2 — 真实数据底座与三层打分**：Google Places 提供店名 / 地址 / 营业时间 / 评分 / 照片；地理越界过滤；硬性条件代码化过滤（评分、营业时间、价位）；基础分 + AI 匹配分 + 因子调整的三层打分。
- **v3 — 区域点评源与召回扩展**：日本追加 Tabelog、欧美追加 Yelp（均通过 Perplexity `sonar` → `sonar-pro` 分级读取 + 缓存表）；品类本地化 / 同义词扩展；多路召回（primary / synonym / dish / scene / time / budget，最多 8 路，已移除 recommend 路）；跨品类按 placeId 最佳归属去重 + 候选池上限 30。
- **v4 — 三段式排序与稳定性治理**：把排序拆成 Pass 1 核验 / Pass 2 打分 / Pass 3 文案三次独立调用；Pass 1 改为 raw JSON + `extractJson` + Zod 校验并带一次严格 JSON 重试，规避受约束解码空响应；Pass 2 miss-only 定向重试 → raw 兜底 → 回落 60；统一 `retry.server.ts` 重试 / 超时 / 退避；全链路分阶段日志（start / ok / partial / fail + 耗时 + 关键指标）。
- **v5 — 体验与对外集成**：需求语义聚类去重（合并重复意图、保留最高权重）+ 否定语气保留（`[AVOID]`）；时间解析半日制修正；需求页动态进度与解析标签展示；zh / en 双语 + ElevenLabs 语音输入；反馈面板 + 带鉴权的 `/admin/feedback`；MCP 服务（`suggest_cities`、`find_restaurants`）+ OAuth 授权登录与同意页；补齐 `docs/ARCHITECTURE.md`。

## 技术细节

- 只改 `README.md` 一个文件，不动任何源码或文档以外内容。
- 所有能力描述与模型 / 密钥名逐条以 `src/lib/echo.functions.ts`、`ai-gateway.ts`、`cuisine-expand.server.ts`、`tabelog.server.ts`、`yelp.server.ts`、`routes/api/transcribe.ts`、`src/lib/mcp/*` 为准；不写代码里不存在的东西。
- 语言保持中文，格式沿用现有 README 的表格 + 分节风格。
