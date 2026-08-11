# Echo Eats

AI 美食礼宾（food concierge）—— 用自然语言说清城市、料理、时间、预算、氛围、偏好和避雷点，系统召回真实餐厅、阅读多源点评、逐家核验打分，最终每个品类给出 Top 5 推荐。

> 在线体验：<https://echoeats.lovable.app>
> 完整架构与节点级细节（Prompt / Schema / 兜底策略）见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## 核心能力

- **城市校验**：Google Places Autocomplete 校验并规范化城市，附带联想候选
- **需求结构化解析**：AI 把自由文本拆成硬性条件 / 软性偏好 / 负向避雷，并赋权重；解析失败换模型重试
- **语义聚类去重**：合并语义重复的需求意图，保留最高权重；负向需求保留否定语气（`[AVOID]`）
- **多路召回**：每个品类最多 8 路查询（primary / synonym / dish / scene / time / budget），跨品类按 `placeId` 做最佳归属去重，候选池上限 30
- **零幻觉真实数据**：店名、地址、营业时间、Google 评分、照片全部来自 Google Places API
- **区域差异化点评源**：日本店追加 Tabelog，US/CA/GB/FR/IT/DE/ES 追加 Yelp（均通过 Perplexity 分级读取公开页面 + 结果缓存）
- **三段式 AI 排序**：Pass 1 核验与硬条件检查 → Pass 2 匹配分 → Pass 3 文案（亮点 / 槽点 / 推荐理由）
- **三层打分**：基础分（贝叶斯评分等）+ AI 匹配分 + 因子调整，能用代码算的绝不交给模型
- **流式结果**：`AsyncGenerator` 边算边推，长任务带心跳，避免边缘网关切流
- **中英双语 + 语音输入**：自研 i18n（zh / en），需求页支持 ElevenLabs 语音转写
- **反馈闭环**：内置反馈面板 + 带鉴权的 `/admin/feedback` 管理后台
- **对外 Agent 集成**：MCP 服务（`suggest_cities`、`find_restaurants`）+ OAuth 授权登录与同意页

---

## 技术栈

| 层 | 选型 |
|---|---|
| 前端框架 | React 19 + TanStack Start v1（SSR + 文件路由） |
| 构建 | Vite 7 |
| 样式 / UI | TailwindCSS v4 + shadcn/ui |
| 状态 | Zustand（sessionStorage 持久化） |
| 数据获取 | TanStack Query |
| 后端运行时 | Cloudflare Workers（`@cloudflare/vite-plugin` + `nodejs_compat`） |
| 服务端逻辑 | `createServerFn`（typed RPC）+ 文件路由 server handler |
| 数据库 / 鉴权 | Lovable Cloud（托管 Supabase）：`search_sessions`、`search_feedback`、`review_cache`、`tabelog_cache` |
| AI 调用 | 阿里云 DashScope（通义千问，OpenAI 兼容协议）+ Vercel AI SDK |

---

## 模型选型

全部 LLM 调用只有两个供应商：**DashScope（通义千问）** 走 AI SDK，**Perplexity** 走裸 `fetch`。`src/lib/ai-gateway.ts` 里的 Lovable AI Gateway 命名只是指向 Qwen provider 的历史别名。

| 节点 | 模型 | 说明 |
|---|---|---|
| 需求解析 `parseRequirements` | `qwen-plus` → `qwen-max` | 抛错或只返回兜底品类时换 `qwen-max` 重试 |
| 语义聚类去重 `semanticClusterMerge` | `qwen-plus` | 失败直接返回原始 parsed |
| 品类本地化 / 同义词扩展 | `qwen-turbo` | 短输入短输出，失败回落原文 |
| 排序 Pass 1 核验 | `qwen-plus` | raw JSON + `extractJson` + Zod 校验，失败追加严格 JSON 提示重试 1 次 |
| 排序 Pass 2 打分 | `qwen-plus` | `Output.object` → miss-only 定向重试 → raw 兜底 → 回落 60 |
| 排序 Pass 3 文案 | `qwen-plus` | `Output.object` → raw 兜底 → 该批空 picks |
| Tabelog / Yelp 页面读取 | Perplexity `sonar` → `sonar-pro` | 先便宜档，字段空或核验失败再升级 |
| 语音转写 `/api/transcribe` | ElevenLabs `scribe_v2` | 非 LLM |

---

## 外部服务与数据源

> 除 Google Places 之外，**Tabelog、Yelp 都没有使用官方 API**，而是通过 Perplexity 让模型读公开页面并给出可核验 URL。

- **Google Places API (New)** — 唯一的官方店铺数据源：`places:autocomplete`（城市）、`places:searchText`（餐厅召回，含 rating / reviews / periods / photos）、Photo media（图片 URL 解析）
- **Perplexity** — Tabelog / Yelp 页面检索与字段补全
- **ElevenLabs** — 需求页语音输入转写

所有外部 fetch 统一走 `src/lib/retry.server.ts#withRetry`：只对 5xx / 429 / abort / 网络错误重试，指数退避 + 抖动，4xx 不重试。

---

## 页面与路由

| 路由 | 说明 |
|---|---|
| `/` | 城市输入与校验 |
| `/cuisines` | 品类选择（可跳过，交给 AI 推断，最多 2 个） |
| `/requirements` | 自由文本 + 语音输入，展示解析出的需求标签与动态进度 |
| `/results` | 流式结果，按品类分组给出 Top 5 |
| `/login` | 登录（管理后台 / OAuth 授权用） |
| `/admin/feedback` | 反馈管理后台（需鉴权，支持单条删除与清空） |
| `/mcp` | MCP 服务端点（`suggest_cities`、`find_restaurants`） |
| `/api/transcribe` | 语音转写 HTTP 端点 |

---

## 工作流概览

```text
/ 城市页 ──▶ /cuisines 品类 ──▶ /requirements 需求 ──▶ /results 结果
   │              │                    │                    │
validateCity  expandCuisine      parseRequirements    searchRestaurants
(Autocomplete)   (qwen-turbo)   + semanticClusterMerge  多路召回 → 代码硬过滤
                                                       → Pass 1 核验
                                                       → Pass 2 打分
                                                       → JS 三层打分
                                                       → Pass 3 文案（Top 5）
```

节点级输入 / 输出 / Prompt / 兜底策略见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 本地运行

```bash
bun install
bun dev
```

环境变量见 `.env`（Lovable Cloud 自动注入 Supabase URL / Key）。需要在 Cloud Secrets 配置：

- `QWEN_API_KEY`（DashScope）
- `GOOGLE_PLACES_API_KEY`
- `PERPLEXITY_API_KEY`
- `ELEVENLABS_API_KEY`

---

## 版本更新计划

### v1 — 端到端骨架
多步输入（城市 → 品类 → 需求）+ 结果页；Zustand + sessionStorage 管理跨页状态；服务端以 `createServerFn` 为主干；AI 把自然语言解析成硬性条件 / 软性偏好 / 负向避雷并赋权重。

### v2 — 真实数据底座与三层打分
接入 **Google Places API** 提供真实店名、地址、营业时间、评分、照片；加入地理越界过滤（国别标记冲突 + 区域 bbox，东京另有 Greater Tokyo 盒子）；硬性条件（评分阈值、营业时间、价位档）全部代码化过滤；建立「基础分 + AI 匹配分 + 因子调整」的三层打分模型。

### v3 — 区域点评源与召回扩展
日本店追加 **Tabelog**、欧美站追加 **Yelp**，均通过 Perplexity `sonar` → `sonar-pro` 分级读取并写入缓存表；新增品类本地化 / 同义词扩展；建立多路召回（primary / synonym / dish / scene / time / budget，每品类最多 8 路，已移除 recommend 路）；跨品类按 `placeId` 做最佳归属去重，候选池上限 30，控制 token 与耗时。

### v4 — 三段式排序与稳定性治理
把排序拆成三次独立模型调用：Pass 1 核验与硬条件检查、Pass 2 只出 `matchScore`、Pass 3 只写文案，降低单次 JSON 复杂度以减少字段漏发；Pass 1 改为 raw JSON + `extractJson` + Zod 校验并带一次严格 JSON 重试，规避受约束解码的空响应；Pass 2 采用 miss-only 定向重试 → raw 兜底 → 回落 60；统一 `retry.server.ts` 的重试 / 超时 / 退避；全链路分阶段日志（`start` / `ok` / `partial` / `fail` + 耗时 + 关键指标 + 失败阶段游标）。

### v5 — 体验优化与对外集成
需求语义聚类去重（合并重复意图、保留最高权重）+ 否定语气保留（`[AVOID]`，避免负向条件被反转）；修正半日制时间解析（如 6:30 PM 不再被读成 06:30 AM）；需求页动态进度与解析标签展示；全站 zh / en 双语 + ElevenLabs `scribe_v2` 语音输入；反馈面板 + 带鉴权的 `/admin/feedback`（单条删除 / 一键清空）；上线 MCP 服务（`suggest_cities`、`find_restaurants`）与 OAuth 授权登录 + 同意页；补齐 `docs/ARCHITECTURE.md` 架构文档。

---

## License

Private project built on [Lovable](https://lovable.dev).
