# 添加 README.md 介绍产品与更新历史（已对照源码修正）

新增 `README.md`（项目根目录）。Lovable 与 GitHub 双向同步，保存即自动推送。

## 已核对的事实
- 唯一的"官方店铺数据 API"是 **Google Places API**。
- **Tabelog / Yelp / 大众点评都没用官方 API**，全部通过 Perplexity (`sonar` / `sonar-pro`) 让模型读公开页面，Dianping 再叠加 Firecrawl 抓 `review_all` 分页 markdown。
- Dianping **仍然在用**（`country === "CN"` 走 Dianping 分支），不是"下线"。
- 语音转写走 **ElevenLabs `scribe_v2`**（`/api/transcribe`）。
- 模型：`parseRequirements` 主 `google/gemini-2.5-flash`、回退 `openai/gpt-5-mini`；`cuisine-expand` 与排序也走 Lovable AI Gateway 上的 Gemini 系列。
- 后端运行时 Cloudflare Workers + nodejs_compat；数据库 Lovable Cloud（Supabase）。

## 文档结构

### 1. 产品介绍
Echo Eats — AI 餐厅发现 Agent。一句话描述城市 / 料理 / 时间 / 预算 / 氛围 / 偏好 / 避雷点，系统拉取真实餐厅、AI 阅读多源点评、按匹配度排序输出。

### 2. 核心能力
- 多步引导输入（城市 → 料理 → 时间 → 自由描述）+ ElevenLabs 语音输入
- AI 解析为结构化硬性 / 软性 / 负向需求（带权重）
- 区域差异化点评源：日本 Tabelog、英美法德意西加 Yelp、中国大陆 Dianping
- 中英双语界面，跟随浏览器并可手动切换
- 用户反馈面板 + 管理后台（查看 / 删除 / 一键清空）

### 3. 技术栈
- **前端**：React 19、TanStack Start v1（SSR + 文件路由）、Vite 7、TailwindCSS v4、shadcn/ui、Zustand（sessionStorage）、TanStack Query
- **后端运行时**：Cloudflare Workers（`@cloudflare/vite-plugin` + nodejs_compat），逻辑写在 `createServerFn` / 文件路由 server handler
- **数据库 / 鉴权**：Lovable Cloud（Supabase 托管），`search_sessions` / `search_feedback` / 管理员鉴权
- **AI 网关**：Lovable AI Gateway（OpenAI 兼容协议，`@ai-sdk/openai-compatible` + Vercel AI SDK）

### 4. 使用的模型
| 任务 | 模型 |
|---|---|
| 需求解析 `parseRequirements` | `google/gemini-2.5-flash`（主），`openai/gpt-5-mini`（回退） |
| 料理本地化 / 同义词扩展 | Lovable AI Gateway 上的 Gemini |
| 餐厅排序与 AI 总结 | `google/gemini-2.5-flash` |
| 语音转写 `/api/transcribe` | **ElevenLabs `scribe_v2`** |
| Tabelog / Yelp / Dianping 页面读取 | Perplexity `sonar` / `sonar-pro`（+ Dianping 再叠加 Firecrawl 抓评论 markdown） |

### 5. 外部服务
- **Google Places API**（唯一真正的店铺数据 API：店名、地址、营业时间、Google 评分、照片）
- **Perplexity**（统一作为「让 LLM 读 Tabelog / Yelp / 大众点评 / 美团 / 小红书等页面」的通道，含 `/search` 与 `/chat/completions`）
- **Firecrawl**（仅 Dianping 路径，抓 `review_all` 分页 markdown）
- **ElevenLabs**（语音转写）

### 6. 更新历史（5 个版本，反复试错合并为最终结论）

**v1 — MVP 端到端骨架**
4 步输入（城市 / 料理 / 日期 / 自由描述）、需求确认页、分组结果页；Zustand 状态、AI 解析需求、AI 生成候选餐厅 + 总结 + pros/cons + 匹配分。

**v2 — 真实数据底座 + 加权打分**
弃用「AI 凭空想餐厅」，改为 Google Places API 提供真实店名、地址、营业时间、照片、Google 评分；建立 `Restaurant` 数据模型与硬过滤 / 软偏好 / 负向过滤的加权评分。

**v3 — 区域差异化点评源（全部走 Perplexity）**
按 `country` 分流：日本店追加 Tabelog 详情（Perplexity 读 `tabelog.com` 店铺页 + 价位区间）；US/CA/GB/FR/IT/DE/ES 追加 Yelp（Perplexity Search 召回候选 → 打分 → `sonar`/`sonar-pro` 核验补字段）；中国大陆走 Dianping 专用管线：Perplexity 拉店列表 + Firecrawl 抓 `review_all` 多页评论 + Perplexity sonar-pro 聚合 pros/cons。

**v4 — 国际化 + 语音 + 模型稳定化**
全站 zh/en 双语（`src/lib/i18n/`），首访跟随浏览器、可手动切换；首页接入 ElevenLabs `scribe_v2` 语音输入；NeedBubbles 推荐气泡；解析模型从早期 preview 模型稳定到 `gemini-2.5-flash` + `gpt-5-mini` 回退，schema 改为宽松解析 + 规范化层，杜绝 `No object generated` 崩溃。

**v5 — 反馈闭环 + 管理后台 + 可靠性**
用户反馈面板 → Supabase；`/admin/feedback` 带登录鉴权，支持单条删除与一键清空；新增 `retry.server.ts` 统一重试 / 超时 / 退避；首页加入双语提示，告知大陆点评源因反爬效果有限、建议优先海外城市。

### 7. 本地运行
```bash
bun install
bun dev
```
环境变量见 `.env`（Lovable Cloud 自动注入 Supabase URL / Key）；需要在 Cloud Secrets 配置：`GOOGLE_PLACES_API_KEY`、`PERPLEXITY_API_KEY`、`FIRECRAWL_API_KEY`、`ELEVENLABS_API_KEY`、`LOVABLE_API_KEY`（Lovable AI Gateway，通常自动注入）。

---

## 🧒 白话方案
在仓库根目录加一份 README.md，介绍产品 / 技术栈 / 模型 / 5 阶段演进。这次照源码核对过：Tabelog 和 Yelp 都没有用官方 API，都是通过 Perplexity 让模型读公开页面；大众点评还在用（Perplexity + Firecrawl）。保存后 Lovable 自动推 GitHub。

## 👀 用户视角变化
GitHub 仓库出现正式 README；应用本身无任何变化。

## 💰 成本与副作用
- **金钱 / 性能**：0。纯文档。
- **副作用**：无。不改任何代码 / 路由 / 数据库。
- **风险**：无。
