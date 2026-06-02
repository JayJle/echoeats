# Echo Eats

AI 餐厅发现 Agent — 一句话描述城市、料理、时间、预算、氛围、偏好和避雷点，系统拉取真实餐厅、阅读多源点评、按匹配度排序输出推荐。

> 在线体验：<https://echoeats.lovable.app>

---

## 核心能力

- **多步引导输入**：城市 → 料理 → 时间 → 自由描述（含语音输入）
- **结构化需求解析**：AI 把自然语言拆成硬性条件 / 软性偏好 / 负向避雷，并赋权重
- **真实数据**：店名、地址、营业时间、Google 评分、照片均来自 Google Places API，杜绝幻觉
- **区域差异化点评源**：日本店追加 Tabelog，US/CA/GB/FR/IT/DE/ES 追加 Yelp，中国大陆走大众点评 + Firecrawl 评论抓取
- **AI 排序与总结**：为每家店生成匹配分、亮点 / 槽点、推荐理由
- **中英双语**：跟随浏览器语言并支持手动切换
- **用户反馈闭环**：内置反馈面板 + 带鉴权的 `/admin/feedback` 管理后台

---

## 技术栈

| 层 | 选型 |
|---|---|
| 前端框架 | React 19 + TanStack Start v1（SSR + 文件路由） |
| 构建 | Vite 7 |
| 样式 / UI | TailwindCSS v4 + shadcn/ui |
| 状态 | Zustand（sessionStorage 持久化） |
| 数据获取 | TanStack Query |
| 后端运行时 | Cloudflare Workers（`@cloudflare/vite-plugin` + nodejs_compat） |
| 服务端逻辑 | `createServerFn` + 文件路由 server handler |
| 数据库 / 鉴权 | Lovable Cloud（托管 Supabase） |
| AI 网关 | Lovable AI Gateway（OpenAI 兼容协议 + Vercel AI SDK） |

---

## 使用的模型

| 任务 | 模型 |
|---|---|
| 需求解析 `parseRequirements` | `google/gemini-2.5-flash`（主）+ `openai/gpt-5-mini`（回退） |
| 料理本地化 / 同义词扩展 | Gemini（Lovable AI Gateway） |
| 餐厅排序与 AI 总结 | `google/gemini-2.5-flash` |
| 语音转写 `/api/transcribe` | **ElevenLabs `scribe_v2`** |
| Tabelog / Yelp / 大众点评页面读取 | Perplexity `sonar` + `sonar-pro` |

---

## 外部服务

> 除 Google Places 之外，**Tabelog、Yelp、大众点评都没有使用官方 API**，而是通过 Perplexity 让 LLM 读公开页面、必要时叠加 Firecrawl 抓 markdown。

- **Google Places API** — 唯一的官方店铺数据 API（店名、地址、营业时间、评分、照片）
- **Perplexity** — 统一通道，让 LLM 读 Tabelog / Yelp / 大众点评 / 美团 / 小红书等页面（`/search` + `/chat/completions`）
- **Firecrawl** — 仅大众点评路径使用，抓取 `review_all` 多页评论的 markdown
- **ElevenLabs** — 语音转写（`scribe_v2`）
- **Lovable AI Gateway** — 统一调用 Gemini / GPT 系列

---

## 更新历史

### v1 — MVP 端到端骨架
4 步输入（城市 / 料理 / 日期 / 自由描述）+ 需求确认页 + 分组结果页；Zustand 管理跨页状态；AI 解析需求 + 生成候选餐厅 + 总结 + pros/cons + 匹配分。

### v2 — 真实数据底座与加权打分
弃用「AI 凭空想餐厅」的做法，改为 **Google Places API** 提供真实店名、地址、营业时间、照片和 Google 评分；建立 `Restaurant` 数据模型，引入硬性过滤 / 软性偏好 / 负向避雷的加权打分体系。

### v3 — 区域差异化点评源（全部走 Perplexity）
按 `country` 分流：日本店追加 **Tabelog**（Perplexity 读 `tabelog.com` 店铺页 + 价位区间）；US/CA/GB/FR/IT/DE/ES 追加 **Yelp**（Perplexity Search 召回候选 → 打分 → `sonar` / `sonar-pro` 核验并补字段）；中国大陆走 **大众点评专用管线**（Perplexity 拉店列表 + Firecrawl 抓 `review_all` 多页评论 + `sonar-pro` 聚合 pros / cons）。

### v4 — 国际化、语音输入与模型稳定化
全站 zh / en 双语化（`src/lib/i18n/`），首访跟随浏览器、可手动切换；首页接入 **ElevenLabs `scribe_v2`** 语音输入；新增推荐气泡 NeedBubbles；需求解析模型从早期 preview 稳定到 `gemini-2.5-flash` 主 + `gpt-5-mini` 回退，schema 改为宽松解析 + 规范化层，杜绝 `No object generated` 崩溃。

### v5 — 反馈闭环、管理后台与可靠性
新增用户反馈面板 → 写入 Lovable Cloud；`/admin/feedback` 带登录鉴权，支持单条删除与一键清空；新增 `retry.server.ts` 统一上游重试 / 超时 / 退避；首页加入双语提示，告知大陆点评源因反爬效果有限、建议优先海外城市。

---

## 本地运行

```bash
bun install
bun dev
```

环境变量见 `.env`（Lovable Cloud 自动注入 Supabase URL / Key）。需要在 Cloud Secrets 配置：

- `GOOGLE_PLACES_API_KEY`
- `PERPLEXITY_API_KEY`
- `FIRECRAWL_API_KEY`
- `ELEVENLABS_API_KEY`
- `LOVABLE_API_KEY`（Lovable AI Gateway，通常自动注入）

---

## License

Private project built on [Lovable](https://lovable.dev).
