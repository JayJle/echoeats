# Echo Eats 架构与技术细节文档

> 目标：任何人拿到本文档 + 代码，都能完整复刻 Echo Eats 的产品逻辑与工程实现。
> 对应代码版本：`src/lib/echo.functions.ts`（3270 行）为主干；本文所有行为描述均与代码一一对应。

---

## 目录

1. [产品定位与整体架构](#1-产品定位与整体架构)
2. [技术栈与运行时](#2-技术栈与运行时)
3. [模型选型与 AI 网关](#3-模型选型与-ai-网关)
4. [外部 API 与数据源](#4-外部-api-与数据源)
5. [Workflow 全流程总览](#5-workflow-全流程总览)
6. [节点详解（输入 / 输出 / Prompt / 兜底）](#6-节点详解)
7. [Schema 定义汇总](#7-schema-定义汇总)
8. [评分模型（三层打分）](#8-评分模型三层打分)
9. [流式传输与前端消费](#9-流式传输与前端消费)
10. [数据库与埋点](#10-数据库与埋点)
11. [MCP / OAuth：对外 Agent 集成](#11-mcp--oauth对外-agent-集成)
12. [可观测性：日志规范](#12-可观测性日志规范)
13. [异常与降级策略总表](#13-异常与降级策略总表)
14. [复刻清单（Checklist）](#14-复刻清单)

---

## 1. 产品定位与整体架构

Echo Eats 是一个"美食礼宾（food concierge）"：用户用自然语言描述吃饭需求（城市 + 品类 + 自由文本），系统把需求结构化，多路召回真实餐厅，逐家核验、打分、写文案，最终每个品类给出 Top 5。

核心设计原则：

- **零幻觉**：所有餐厅事实（名称、地址、评分、营业时间、评论）来自 Google Places / Tabelog / Yelp 一手数据，模型只做"核验 + 归纳"，不允许发明事实。
- **职责单一的多段 Prompt**：核验、打分、文案拆成三次独立模型调用（Pass 1/2/3），单次输出 JSON 越简单，字段漏发率越低。
- **确定性优先**：能用代码算的（评分阈值、营业时间、价位档、贝叶斯评分）一律不交给模型。
- **全链路可降级**：任何一个外部依赖或模型调用失败，都有明确兜底值，不整体失败。

```text
┌────────────┐   ┌──────────────┐   ┌───────────────┐   ┌────────────┐
│  / 城市页   │→ │ /cuisines    │→ │ /requirements │→ │ /results   │
│ 城市校验    │   │ 品类选择/跳过 │   │ 自由文本+解析  │   │ 流式结果   │
└────────────┘   └──────────────┘   └───────────────┘   └────────────┘
       │                                    │                  │
       ▼                                    ▼                  ▼
 validateCity()                     parseRequirements()   searchRestaurants()
 (Places Autocomplete)              (Qwen 结构化)          (AsyncGenerator 流)
```

---

## 2. 技术栈与运行时

| 层 | 选型 |
| --- | --- |
| 框架 | TanStack Start v1（React 19 + Vite 7），文件式路由 `src/routes` |
| 运行时 | Cloudflare Workers（`wrangler.jsonc`，`nodejs_compat`），入口 `src/server.ts` |
| 服务端逻辑 | `createServerFn`（typed RPC）；HTTP 端点仅 `src/routes/api/transcribe.ts` |
| 样式 | Tailwind v4（`src/styles.css`） |
| 状态 | zustand + persist（`src/lib/store.ts`） |
| 国际化 | 自研 `src/lib/i18n`（zh / en） |
| 后端 | Lovable Cloud（Supabase）：`search_sessions`、`search_feedback`、`review_cache`、`tabelog_cache` |
| AI | 通义千问 DashScope（OpenAI 兼容）+ AI SDK `generateText` / `Output.object` |

关键运行时约束：

- Worker 不能跑 Node 原生扩展；所有外部调用都是 `fetch`。
- 长任务（Tabelog 抓取、AI 排序）必须**流式心跳**，否则边缘网关会因长时间静默切流（见 §9）。
- `process.env.*` 只能在 handler 内读取。

---

## 3. 模型选型与 AI 网关

`src/lib/ai-gateway.ts`：

```ts
createOpenAICompatible({
  name: "qwen",
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  headers: { Authorization: `Bearer ${QWEN_API_KEY}` },
});
```

全部 LLM 调用只有两个供应商：**阿里云 DashScope（通义千问）** 走 AI SDK（`@ai-sdk/openai-compatible` + `generateText`），**Perplexity** 走裸 `fetch`。项目里没有使用 Lovable AI Gateway / OpenAI / Gemini（`ai-gateway.ts` 里的 `createLovableAiGatewayProvider` 只是指向 `createQwenProvider` 的历史别名）。

密钥：`QWEN_API_KEY`（`echo.functions.ts:423`、`1549` 读取后透传给 server 模块）、`PERPLEXITY_API_KEY`、`GOOGLE_PLACES_API_KEY`、`ELEVENLABS_API_KEY`，均只在 server 端 `process.env` 读取。

| 节点 | 文件 / 行 | 模型 | 输出方式 | maxOutputTokens |
| --- | --- | --- | --- | --- |
| 需求结构化 `parseRequirements` | `echo.functions.ts:624` | `qwen-plus`；两类重试都换 `qwen-max`（首轮抛错重试 `:800`；品类只返回兜底词时 forceInfer 重试 `:674`） | `Output.object`（`LooseParsedSchema`，之后再 `ParsedSchema.parse`） | 8000 |
| 语义聚类去重 `semanticClusterMerge` | `echo.functions.ts:270` | `qwen-plus`（无重试，失败直接返回原 parsed） | `Output.object`（`SemanticClusterOutput`） | 2000 |
| 品类本地化扩展 `expandCuisineQueries` | `cuisine-expand.server.ts:42` | `qwen-turbo`（无重试，失败回落 `primary=原文`、同义词/反例为空） | `Output.object` | 400 |
| Pass 1 核验 `rankVerifyGroup` | `echo.functions.ts:2431` | `qwen-plus` | **纯文本 raw JSON + `extractJson` + `AiVerifyGroupSchema.parse`**；解析失败追加"严格 JSON"提示重试 1 次 | 10000 |
| Pass 2 打分 `rankScoreGroup` | `echo.functions.ts:2532/2555/2577` | `qwen-plus` | `Output.object` → miss-only 定向重试 → raw JSON 兜底 → 全量回落 60 | 2000 / 重试 1000 / raw 3000 |
| Pass 3 文案 `rankCopyGroup` | `echo.functions.ts:2729/2746` | `qwen-plus` | `Output.object` → raw JSON 兜底 → 该批返回空 picks | 4000 / raw 6000 |
| Tabelog 抓取 | `tabelog.server.ts:329` | Perplexity `sonar` → 失败/字段空升级 `sonar-pro` | `response_format: json_schema` | `max_tokens` 400 / 700 |
| Yelp 抓取 | `yelp.server.ts:306` | 同上，且按 URL 置信度决定起始档（high→`sonar`，low→直接 `sonar-pro` 且强制核验） | `response_format: json_schema` | `max_tokens` 400 / 700 |
| 语音转写 | `routes/api/transcribe.ts:67` | ElevenLabs `scribe_v2`（非 LLM） | multipart form | — |

三个 Pass 共用同一个 provider 实例与同一模型 `qwen-plus`（`echo.functions.ts:2145-2146`），拆分的是 prompt 与 schema，不是模型。所有调用都不设 `temperature`/`topP`，用 DashScope 默认值。

**选型理由（与代码一致）**
- `qwen-plus`：主力。中文需求理解 + 长 prompt（Pass 1 每批含全部候选证据）性价比最好，是解析、聚类、三段 Pass 的默认模型。
- `qwen-max`：只作为 `parseRequirements` 的跨模型重试，避免同模型以同样方式再次失败或再次返回兜底品类。
- `qwen-turbo`：只用于 `expandCuisineQueries` 这种短输入短输出、可失败可降级的辅助调用，最快最省。
- Perplexity `sonar` / `sonar-pro`：需要联网检索 Tabelog / Yelp 页面并给出 URL，Qwen 无联网能力，所以这一层保留 Perplexity；先便宜的 `sonar`，只在结果不可用时升级 `sonar-pro`。

**为什么 Pass 1 不用 `Output.object`**：Pass 1 的 schema 最复杂（嵌套 `hardFilterChecks` + `matchDetails`），受约束解码时模型会偶发返回空响应（"No output generated"），触发 25–40s 的 raw fallback。改为直接 `generateText` + `extractJson` + `Zod.parse`，并对解析失败做一次"严格 JSON"重试，稳定性最好。Pass 2 / Pass 3 的 schema 足够扁平，保留 `Output.object` 并各自带 raw 兜底。

---

## 4. 外部 API 与数据源

| 数据源 | 用途 | 封装 |
| --- | --- | --- |
| Google Places API (New) `places:autocomplete` | 城市校验 / 城市联想 | `src/lib/google-places.server.ts#autocompleteCities` |
| Google Places `places:searchText` | 餐厅召回（含 rating / reviews / periods / photos） | `#searchPlaces`，FieldMask 见文件 |
| Google Places Photo media | 图片 URL 解析（`skipHttpRedirect=true`，内存缓存） | `#resolvePhotoUrl` |
| Perplexity | 日本站 Tabelog 抓取、欧美站 Yelp 抓取 | `tabelog.server.ts` / `yelp.server.ts` |
| ElevenLabs | 需求页语音输入转写 | `src/routes/api/transcribe.ts` |

所有外部 fetch 走 `src/lib/retry.server.ts#withRetry`：仅对 5xx / 429 / abort / 网络错误重试，指数退避 + 抖动，单次 timeout 由调用方指定。4xx 不重试。

Places 请求参数：`includedType: "restaurant"`，`maxResultCount ≤ 20`，`languageCode` 由 `guessLanguageCode(city)` 推断（日文假名/日本城市→`ja`，韩→`ko`，中文→`zh-CN`，否则 `en`），`regionCode` 由 `guessRegionCode(city)` 推断。

**地理越界过滤** `isPlaceClearlyOutsideTargetRegion`：地址里的国别标记与目标区域冲突，或经纬度落在区域盒子外（JP/HK/SG/KR/TW 各有 bbox），东京另有 Greater Tokyo bbox（lat 34.9–36.2 / lng 138.8–140.6）→ 剔除。

---

## 5. Workflow 全流程总览

```text
[1] 城市校验 validateCity           (Places Autocomplete + 中国大陆拦截)
        │  confirmed / choose / not_found / invalid / unsupported_region / unavailable
        ▼
[2] 品类选择（可跳过 → AI 推断 1–2 个）
        ▼
[3] 需求结构化 parseRequirements    (Qwen 结构化抽取，禁止在本步去重)
        ▼
[4] 语义聚类去重 semanticClusterMerge (同诉求合簇，取最高 weight)
        ▼
[5] 品类本地化扩展 expandCuisineQueries (primary / synonyms / negativeKeywords)
        ▼
[6] 八路召回 (Google Places textSearch × ≤8 query / cuisine)
        ▼
[7] 料理保真过滤 + 地理越界过滤 + 跨品类去重（best-fit）
        ▼
[8] 时间硬筛 isOpenAt + 规则初筛（businessStatus / priceLevel / 评分阈值）
        ▼
[9] 证据补充：Google 一手 reviews（基线）＋ Tabelog(JP) / Yelp(欧美)
        ▼
[10] 候选池截断 POOL_CAP=30，按 rating × log10(reviews+10) 排序
        ▼
[11] Pass 1 核验（batch=8/12，逐 cuisine 并行）
        ▼
[12] Pass 2 打分（仅 placeId + matchScore；miss-only 重试；兜底 60）
        ▼
[13] JS 三层打分 → 每 cuisine Top 5 分桶（ok / partial / failed）
        ▼
[14] Pass 3 文案（仅 Top 5，aiSummary + pros + cons）
        ▼
[15] 图片解析 + 结果 yield + 会话落库 + 反馈收集
```

---

## 6. 节点详解

### 6.1 城市校验 `validateCity`（`src/lib/city.functions.ts`）

- **输入**：`{ city: string }`，Zod 限制 `1–80` 字符且只允许 `\p{L}\p{M}\p{N}` + `,.'’()-·` 和空格。
- **处理**：
  1. `isMainlandChinaCity()` 命中 → 直接 `unsupported_region`（港澳台不受影响）。
  2. `autocompleteCities()` 取前 5 个城市候选。
  3. 过滤中国大陆候选（`isMainlandChinaRegion`）。
  4. 归一化（NFKC + 小写 + 去标点空白）后精确匹配唯一 → `confirmed`；否则 `choose`。
- **输出**：`confirmed | choose | not_found | invalid | unsupported_region | unavailable`。
- **兜底**：任何异常 → `unavailable`（前端提示重试，不阻断）。

### 6.2 需求结构化 `parseRequirements`

- **输入**：`{ city, cuisines[], autoInferCuisines, date, freeText, uiLanguage }`。
- **两层 schema 策略**：先用 `LooseParsedSchema`（字段全 optional、数组元素 `z.unknown()`）让 AI SDK 生成极宽松 JSON Schema，避免 `weight:"0.8"` / `hhmm:"7:00"` 这类脏数据在 SDK 内部直接判失败；拿到对象后再用严格 `ParsedSchema` 配合 `WeightCoerced` / `HhmmCoerced` / `.catch()` 救回。
- **Prompt 的核心规则块**（全文见 `echo.functions.ts` L447–L616）：
  - **语言强制**：所有人类可读字段按 `uiLanguage` 写；`language` 字段（BCP47）按城市本地语言；`visitTime.evidence` 保留用户原文。
  - **品类级 vs 餐厅级约束**：用餐时长、同行人结构、食量口味、氛围、场景 → 进 `cuisineLevelConstraints` **并**复制进 `softPreferences`，**禁止**进 `hardFilters`（否则地图文本搜索直接查空）。用户未选品类时据此产出 1–2 个品类。
  - **hardFilters 判定**：强制词（必须/一定/不能/只/禁止…）、数值上下限、明确可验证属性、陈述式可核实条件。
  - **softPreferences 判定**：模糊形容词或弱化词（最好/希望/尽量…）。
  - **权重表**：1.0 务必绝对；0.9 必须/不能/只；0.8 需要/明确数值上下限；0.6 最好/希望；0.4 尽量；0.3 随口一提。类别先验：预算/人数/可预约/营业时间 ≥ 0.8；氛围/装修/服务 ≤ 0.7。
  - **否定保留**：`negativeFilters[].text` 必须以否定词开头，且 `→` 右侧标准化结论也必须保留否定语气。代码侧 `ensureNegationPrefix()` 再兜一层并打 `[neg-prefix]` 日志。
  - **禁止本步去重**：同一诉求的多次表达必须各自单条输出（"环境稍好"/"环境好"/"环境一定要好" → 三条），交由 §6.3 聚类合并；否则更强的那次表达会丢失。
- **时间修正**：`inferWeekdayFromText` / `inferMealPeriod` / `inferExplicitClock` + 半日制修正（"6:30 PM" 不会被解析成 06:30）。
- **兜底链**：`qwen-plus` 失败 → `qwen-max`（`forceInfer`）→ 仍失败则返回带默认值的 `ParsedSchema`（空数组 + `mode:"deep"`）。

### 6.3 语义聚类去重 `semanticClusterMerge`

- **输入**：把 `hardFilters / softPreferences / negativeFilters` 打平编号（`id\t[bucket\tw=0.90]\t文本`）+ `dishPreferences` 编号列表。条目 ≤1 时直接跳过调用。
- **Prompt 判定原则**：同诉求不同措辞/强度/肯否等价改写 → 同簇；相反方向（安静 vs 热闹）不合并；不同维度（环境 / 服务 / 菜品）不合并；价位方向相反（不能低端 vs 不要太奢华）不合并；Google 评分不同阈值同簇（后续取更严格）；菜品同义词/中日英对照同簇。
- **输出**：`{ clusters: [{ids:[...]}], dishClusters: [{ids:[...]}] }`，每个 id 恰好出现一次。
- **代码合并规则**：每簇取 `weight` 最高的条目为代表，bucket 跟随该条目。
- **兜底**：调用失败 → 只做 `dedupeParsedConditions()` 的严格字符串去重。

### 6.4 品类本地化扩展 `expandCuisineQueries`（`cuisine-expand.server.ts`）

- **输出**：`{ primary, synonyms[≤5], negativeKeywords[≤8] }`，按 `(cuisine, language)` 内存缓存。
- **用途**：`primary` 作主查询词；`synonyms` 扩召回；`negativeKeywords` 用于 `filterByCuisineRelevance`——**只有命中反例且没命中 primary/synonyms 才剔除**（混合店保留）。
- **兜底**：失败时 `primary = 用户原词`，同义词与反例为空（等于不过滤）。

### 6.5 八路召回

每个 cuisine 最多 8 条 query（`pushRoute` 去重且封顶 8），每条 `maxResults: 20`：

| tag | query 模板 | 触发条件 |
| --- | --- | --- |
| `primary` | `{primary} {city}` | 总是 |
| `recommend` | `{primary} {city} {おすすめ/推荐/best}` | 总是 |
| `synonym:X` | `{synonym} {city}` | 前 2 个同义词 |
| `dish:X` | `{dish} {city}` | 每个 dishPreference（deep 模式） |
| `scene:X` | `{primary} {city} {包间/一人飯/デート/ファミリー/宴会/静かな}` | 条件文本命中场景正则 |
| `time:late-night` / `time:brunch` | `{primary} {city} {深夜営業 / ブランチ}` | `visitTime.hhmm` ≥22 或 <5 / 10–11 点 |
| `budget:high` / `budget:low` | `{primary} {city} {高級 / 安い}` | 硬条件命中高端/低价词或数值阈值 |

`quick` 模式只跑 `primary` 一路。

- **合并**：`Promise.allSettled` → `placeId` 去重；每个 placeId 记录命中它的 tag 集合（`recallSources`，后续多路召回加分）。
- **失败**：某路失败只记 `firstError`；某 cuisine 全空才 push warning；所有 cuisine 全空才整体返回错误 + `fallbackSuggestions`。

### 6.6 跨品类 best-fit 去重

同一家店可能被多个品类召回。按 `(命中路数 hits ↓, 该品类内排名 rank ↑, 品类顺序 idx ↑)` 选出最合适的品类，其余品类中删除。删除后做 sanity check：唯一 placeId 数量必须与去重前一致，否则打 `DEDUP BUG` 错误日志。

### 6.7 时间硬筛与规则初筛

- `isOpenAt(periods, weekday, hhmm)`：`periods` 缺失 → `unknown`（保留）；命中区间 → `open`；否则 `closed`（剔除）。支持跨日/跨周营业（`close <= open` 时 +7 天）。
- 规则初筛（只用 Places 直接字段）：
  1. `businessStatus !== "OPERATIONAL"` → 剔除；
  2. 明确高端诉求且 `priceLevel` rank ≤1、或明确低价诉求且 rank ≥4 → 剔除（无数据不剔除）；
  3. 存在 `weight ≥ 0.85` 的 Google 评分阈值条件、且该店 `reviews ≥ 30` 且 `verifyGoogleRatingFilter` 判 fail → 剔除。

`verifyGoogleRatingFilter` 是确定性的评分核验器：只在文本出现明确评分锚点（评分 / rating / score / stars / ⭐，或 谷歌+分/星//5）时才生效，并在锚点附近抽阈值，避免把"步行 5 分钟"里的 5 当成 5 星要求。

### 6.8 证据补充

1. **Google 一手 reviews → `ReviewSummary`**（`googleReviewsToSummary`）：`rating ≤ 2` 的进 `commonComplaints`（≤3），其余进 `reviewHighlights`（≤5），每条截断 80 字；sentiment 由两者数量关系推出。零幻觉基线。
2. **Tabelog（country=JP 且 deep 模式，并发 8）**：
   - Stage 0 多变体 `/search` 预搜（`"name" area site:tabelog.com`，可加 city+cuisine），按"店名 token 命中率 + 都道府县路径命中 + cuisine 命中 + 多变体重复出现"打分，取最高分作 `preUrl`。
   - Stage 1 `sonar` + `search_domain_filter=["tabelog.com"]`；Stage 2 `sonar-pro` + `site:` 提示（仅 Stage 1 失败时）。
   - 只接受店铺详情页 URL（正则 `tabelog.com/<pref>/A\d+/A\d+/\d+/`），列表/搜索页一律丢弃。
   - 输出 `{rating, reviewCount, url, priceRange, priceJPY, summary}`，`priceJPY` 由 `parseTabelogPriceJPY` 解析（支持 `￥6,000〜￥7,999` / `￥10,000～` / `～￥3,000` / 单值）。
   - 兜底：任一阶段失败或字段读不到 → `null`，不影响主流程。
3. **Yelp（US/CA/FR/IT/DE/ES/GB）**：同构两阶段（`sonar` 补字段 → `sonar-pro` 核验），带 `confidence: high|medium|low`。

### 6.9 候选池截断

`AI_BATCH_SIZE = 8`（构造 prompt 分批），`POOL_CAP = 30`（每 cuisine 进 AI 的硬上限）。排序键 `rating × log10(reviewCount + 10)`，截尾并打日志 `pool capped N → 30`。

### 6.10 Pass 1 — 核验 `rankVerifyGroup`

- **角色**：餐厅核验分析师，**不打分、不写文案**。
- **输入**：城市 / 日期 / 品类 / 硬条件（带 weight JSON）/ 软偏好 / 避雷 / 菜品偏好 / 料理保真信息（primary、synonyms、negativeKeywords）/ 本批候选 JSON（placeId、name、address、rating、userRatingCount、priceLevel、priceFromReviews、openNow、primaryType、editorialSummary、realWorldReviews、tabelog、yelp）。
- **硬约束**：
  - `hardFilterChecks.length` 必须严格等于硬条件数且顺序一致；
  - `matchDetails.length` 必须严格等于 `nonHardFilters` 数（顺序 = 软偏好【偏好】→ 避雷【避雷】→ 菜品【菜品】）；
  - 每条判定给 `confidence 0–100`（85+ 证据充分 / 70–84 合理 / 40–69 模糊 / <40 猜测）；
  - Google 评分是确定性事实，有数值不允许 unknown；
  - 料理保真：命中反例且未命中主词/同义词 → 该硬条件 fail；
  - 避雷条目语义方向：`ok` = 成功避开（好），`fail` = 踩雷（坏），label 必须保留否定语气；
  - 禁止横向比较、跨条引用、幻觉、同义重复、输出 matchScore、泄露内部字段名；label/note 20–40 字；
  - **每条 matchDetail 只核验它对应的那一条**，禁止把多个维度杂交进一句。
- **verificationStatus 判定法**：任一 `weight ≥ 0.85` 的硬条件 fail → `fail`；否则任一 unknown → `unknown`；否则 `ok`。
- **输出**：`{ picks: [{ placeId, verificationStatus, hardFilterChecks[], matchDetails[] }] }`，纯 JSON。
- **调用方式**：`generateText`（无 `Output.object`）+ `extractJson()`（剥 ```json 围栏 / 抓首个 `{...}`）+ `AiVerifyGroupSchema.parse`。`finishReason === "length"` 视为截断报错。
- **兜底**：第一次解析失败 → 追加 STRICT_JSON_SUFFIX 重试一次 → 仍失败则该批 `ok:false`，picks 为空（下游该批候选走"核验未完成 → unknown"路径）。

### 6.11 Pass 2 — 打分 `rankScoreGroup`

- **输入**：Pass 1 结果精简版（placeId / name / rating / userRatingCount / verificationStatus / hardFilterChecks / matchDetails）+ 条件权重。
- **评分刻度（绝对刻度、逐家独立）**：90–100 硬条件全 ok+软偏好多命中+口碑顶级；75–89 硬全 ok+软部分命中；60–74 硬全 ok+软证据不足；50–69 有 unknown；40–55 非 blocking fail 或多条 unknown；0–39 blocking fail 或 verificationStatus=fail。
- **输出铁律**：`scores.length` 必须等于候选数；每项只有 `placeId` 和 `matchScore`（JSON number）；禁止 null/字符串/缺字段/额外字段；不确定也必须给数字。
- **三级兜底**：
  1. `Output.object` 成功但有漏 → **miss-only 定向重试**（只把缺失的 placeId 重新组批再跑一次），合并结果；
  2. `Output.object` 抛错 → raw JSON fallback（追加纯 JSON 提示，`maxOutputTokens: 3000`）；
  3. 仍失败 → 全批 `matchScore = 60`，状态 `failed`。
- **状态**：`ok`（无兜底）/ `partial`（部分兜底 60，日志列出 missing id）/ `failed`（整批 60）。

### 6.12 JS 三层打分 → Top 5 分桶

见 §8。分桶规则：先按 `admitted` 再按 `finalScore` 降序，取前 5，然后：

- `restaurants`：`admitted && verificationStatus === "ok"`
- `partialRestaurants`：`admitted && verificationStatus === "unknown"`
- `failedRestaurants`：`!admitted || verificationStatus === "fail"`

用户跳过品类时组名替换为「为你推荐」/「Recommended for you」。

### 6.13 Pass 3 — 文案 `rankCopyGroup`

- **只对每个 cuisine 的 Top 5 跑**，且**刻意不告诉模型用户需求**（避免"符合您的 XX 需求"这类回扣式空话与暗示性幻觉）。
- **输入**：`placeId / name / address / googleReviews(≤3) / tabelogSummary / yelpSummary`。
- **规则**：pros/cons 每条必须来自真实评论文本并标 `source`（Google / Tabelog / Yelp）；`aiSummary ≤ 80 字`；同主题评论 <2 条就返回空数组（宁缺毋滥）；禁止横向比较、跨店引用、回扣用户需求、用非评论字段（地址/营业时间/评分数值/primaryType/editorialSummary）拼凑；pros 与 cons 不得写同一件事；每条 ≤30 字，各最多 3 条。
- **兜底**：`Output.object` 失败 → raw JSON（6000 tokens）→ 仍失败则该组 picks 为空，餐厅保留占位文案「XX 因资料不足暂时保留，具体条件尚未完全核实。」

### 6.14 图片与收尾

对所有结果餐厅并行解析最多 6 张 `photoNames` → `resolvePhotoUrl(name, 800)`（`skipHttpRedirect=true`，只在成功时写内存缓存，避免毒化）。最后 yield `result`，附 `error`（缺失品类提示）、`suggestions`、`warnings`。

---

## 7. Schema 定义汇总

### 7.1 `ParsedSchema`（需求结构化产物，同时是 `searchRestaurants` 的入参）

```ts
{
  city: string;
  cuisines: string[];
  dateTime: string;
  hardFilters: { text: string; weight: number /*0–1*/ }[];
  softPreferences: { text: string; weight: number }[];
  negativeFilters: { text: string; weight: number }[];   // text 必须以否定词开头
  dishPreferences: string[];
  cuisineLevelConstraints: { text: string; weight: number }[];
  cuisinesInferred: boolean;
  searchStrategy: string[];
  country: string;          // ISO 3166-1 alpha-2
  language: string;         // BCP 47
  mode: "quick" | "deep";   // 默认 deep
  visitTime: { mentioned, evidence, weekday: 0-6|null, hhmm: "HH:MM"|null, raw } | null;
  uiLanguage: "zh" | "en";
}
```

宽松化处理器：`WeightCoerced`（接受字符串、0–10 自动 /10、缺失→0.7，夹到 0.1–1）、`HhmmCoerced`（`7:00`→`07:00`，非法→null）、`WeekdayCoerced`（越界→null），数组字段全部 `.catch([])`。

### 7.2 AI Pass Schema

```ts
AiVerifyPickSchema = { placeId, verificationStatus?, hardFilterChecks[], matchDetails[] }
AiScorePickSchema  = { placeId, matchScore: coerce number 0–100 }
AiCopyPickSchema   = { placeId, aiSummary, pros[], cons[] }
```

`MatchDetailSchema` / `HardFilterCheckSchema` 都带 `z.preprocess`：字符串输入自动包成对象；label 依次从 `label|text|filter|condition|requirement|note|reason|evidence|summary` 里取第一个可读值；`status` 非法值 `.catch("unknown")`；`confidence` 默认 50。这层容错让"模型格式略歪"不至于整批作废。

### 7.3 `RestaurantSchema`（对外结果）

`id / name / localName / cuisine / address / googleMapsUri / websiteUri / primaryType / matchScore / matchTier / openNow / reservable / needsReview / verificationStatus / ratings[] / aiSummary / matchDetails[] / pros[] / cons[] / links[] / photoUrls[] / tabelog / yelp / weekdayDescriptions / visitTimeMatch / scoreBreakdown[] / recallSources[]`

`ResultsSchema = { groups: [{ cuisine, restaurants[], partialRestaurants?, failedRestaurants? }] }`

---

## 8. 评分模型（三层打分）

先做**确定性覆盖**：若某硬条件是 Google 评分阈值 → 用 `verifyGoogleRatingFilter` 的结果**覆盖** AI 判定；否则取 AI 判定，且 `confidence < 70` 时状态降级为 `unknown`；AI 完全缺该条 → `unknown`（"核验未完成"）。

**Layer 1 准入（一票否决）**——任一命中即 `admitted=false`，最终分被压到 ≤30：

- 存在 `weight ≥ 0.85` 的硬条件 fail（blocking fail）
- 存在 `weight ≥ 0.85` 的避雷条目 fail
- 贝叶斯评分不达标：`reviews ≥ 50` 且 `adjRating < 3.5`
- `businessStatus !== "OPERATIONAL"`

**Layer 2 基础分（0–20）**：贝叶斯平滑 `adjRating = (rating × n + M × C) / (n + C)`，`baseScore = clamp(adjRating × 4, 0, 20)`。

**Layer 3 匹配分（0–80）**：

| 项 | 公式 | 上限 |
| --- | --- | --- |
| AI 匹配分 | `pass2.matchScore × 0.47` | ~47 |
| 硬条件扣分 | fail `−w × 10.7`；unknown `−w × 2.7` | — |
| 软偏好命中 | ok `+w × 6.7` | +20 |
| 软偏好未中 | fail `−w × 4` | — |
| 避雷命中 | fail `−w × 13.3` | — |
| 菜品命中 | 每条 ok `+5.3` | +16 |
| 多路召回 | 路数 0/1/2/3/4+ → `0/0/4/8/13` | +13 |

`finalScore = clamp(baseScore + clamp(matchScore,0,80), 0, 100)`，未准入再 `min(finalScore, 30)`。

**Tier**：`admitted && ≥80 → perfect`；`admitted && ≥65 → high`；否则 `partial`。
`needsReview = !admitted || verificationStatus !== "ok" || rating == null`。

每一项都写进 `scoreBreakdown`，前端可展开查看，用于解释"为什么这家排第一"。

---

## 9. 流式传输与前端消费

`searchRestaurants` 是 `createServerFn` + **async generator**，yield 的 chunk 类型：

```ts
{ type: "stage", stage: "places"|"places-done"|"tabelog"|"rank"|"photos", ... }
{ type: "heartbeat", stage: string }
{ type: "result", payload: SearchResponse }
```

- `withHeartbeat(promise, stage, 4000)`：长阶段每 4s 吐一个心跳块，防止边缘网关因静默切流。Tabelog 抓取、Pass 1/2、Pass 3、图片解析全部包在心跳里。
- `asCompleted()`：按完成顺序消费并发 promise（用于逐步渲染）。
- 客户端 `consumeSearchStream(iter, onProgress)` 收集最终 `result`，`onProgress` 驱动 `/requirements` 的动态进度条与已解析需求标签（只展示结构化标签，不回显原文）。

---

## 10. 数据库与埋点

| 表 | 用途 | 访问方式 |
| --- | --- | --- |
| `search_sessions` | 每次搜索的城市、品类、解析结果、结果快照、UA、语言、结果数、错误阶段 | `createSearchSession`（server fn，`supabaseAdmin`） |
| `search_feedback` | 评分 1–5、选择的餐厅、勾选原因、是否推荐、联系方式、自由评论 | `submitSearchFeedback` |
| `review_cache` / `tabelog_cache` | 外部抓取缓存 | 服务端 |

所有表 RLS 对 `anon`/`authenticated` **全部 deny**，只能通过服务端 `supabaseAdmin` 读写；`/admin/feedback` 用 `ADMIN_PASSWORD` + `ADMIN_SESSION_SECRET` 做服务端会话校验。

---

## 11. MCP / OAuth：对外 Agent 集成

- SDK：`@lovable.dev/mcp-js` + `mcpPlugin()`（vite），端点 `/mcp`，manifest 落在 `.lovable/mcp/manifest.json`。
- 鉴权：`auth.oauth.issuer({ issuer: https://<project-ref>.supabase.co/auth/v1, acceptedAudiences: "authenticated" })`；同意页 `src/routes/[.]lovable.oauth.consent.tsx`（beta 命名空间通过 `src/lib/supabase-oauth.ts` 包装）；登录页 `/login`（邮箱密码 + Google）。
- 暴露的工具（**不暴露完整 searchRestaurants**，因为整条流水线远超 MCP 客户端超时）：
  - `suggest_cities(input)` → Places Autocomplete 城市候选；
  - `find_restaurants(city, query, maxResults≤15)` → Places TextSearch 的名称/地址/评分/价位/营业时间/官网/样例评论。
- 两个工具都先 `ctx.isAuthenticated()` 校验，未登录返回 `isError`。

---

## 12. 可观测性：日志规范

统一前缀 `[Echo/<stage>]`，三态：

```text
[Echo/places]  start cuisines=2 country="JP"
[Echo/places]  ok in 3821ms total=57 perCuisine={"寿司":30,"烧肉":27} errors=0
[Echo/pipeline] failed in 91234ms reason="..." atStage="AI-score"
```

- `_currentStage` 游标贯穿整个 handler，未捕获异常时写进 `atStage`，可以直接定位断点。
- 每个 AI 批次单独日志：`[Echo/AI-verify] batch=寿司#n=12 ok in 8421ms picks=12`、`[Echo/AI-score] batch=... PARTIAL ... fallback60=2 missing=[...]`、`[Echo/AI-copy] batch=... FAILED ...`。
- 其它专用前缀：`[recall]`（每 cuisine 路数与 tag）、`[rules-prefilter]`（各类剔除数）、`[visitTime]`、`[score]`（pool / admitted / top5 均分）、`[retry:<label>]`、`[Tabelog/search|sonar|sonar-pro]`、`[neg-prefix]`、`[places/location]`、`DEDUP BUG`。

排障套路：先看 `[Echo/pipeline] ok/failed` 总耗时 → 按 stage 逐个看 `ok in Xms` 找长尾 → 命中 AI 批次日志看 `PARTIAL/FAILED` 与 `missing` → 再看 `[retry:*]` 判断是外部依赖还是模型格式问题。

---

## 13. 异常与降级策略总表

| 节点 | 失败表现 | 降级动作 |
| --- | --- | --- |
| 城市校验 | Places 异常 | `unavailable`，前端可重试 |
| parseRequirements | qwen-plus 失败 | 换 `qwen-max`；再失败用 schema 默认值 |
| 语义聚类 | 调用/解析失败 | 退化为严格字符串去重 |
| 品类扩展 | 调用失败 | `primary=原词`，不做保真过滤 |
| 某一路召回 | 该 query 失败 | 其余路照常；该 cuisine 全空才 warning |
| 全部召回为空 | — | 返回 `error` + `fallbackSuggestions` |
| Tabelog / Yelp | 超时 / 无匹配 / 非详情页 | 字段置 null，不影响排序主流程 |
| Pass 1 | JSON 解析失败 | STRICT 提示重试 1 次；再失败该批放弃（下游标 unknown） |
| Pass 2 | 漏 id | miss-only 定向重试 → raw fallback → 全批 `matchScore=60` |
| Pass 3 | 失败 | 占位 aiSummary，pros/cons 为空 |
| 图片解析 | 单张失败 | 跳过该图（不写缓存） |
| 未捕获异常 | — | `echoLog.fail("pipeline", …, atStage)` + 返回带 error 的空结果 |

---

## 14. 复刻清单

1. 配置密钥：`QWEN_API_KEY`、`GOOGLE_PLACES_API_KEY`、`PERPLEXITY_API_KEY`、`ELEVENLABS_API_KEY`、`ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET`。
2. 建表 + RLS 全 deny（`search_sessions` / `search_feedback` / `review_cache` / `tabelog_cache`），服务端用 admin client 访问。
3. 实现 `google-places.server.ts`（autocomplete / searchText / photo）与 `retry.server.ts`。
4. 实现 `parseRequirements`（双层 schema + 权重表 + 否定保留 + 禁止本步去重）与 `semanticClusterMerge`。
5. 实现 `expandCuisineQueries` + `filterByCuisineRelevance`。
6. 实现八路召回 + 跨品类 best-fit 去重 + 越界过滤 + 时间/规则初筛 + `POOL_CAP=30`。
7. 实现三段 Prompt（核验 / 打分 / 文案）与各自的兜底链，严格照抄 §6.10–6.13 的约束条目。
8. 实现三层打分与 Top 5 分桶（§8 权重表）。
9. 用 async generator + 心跳做流式输出，前端消费 `stage/heartbeat/result`。
10. 铺 `[Echo/<stage>] start|ok|fail` 日志与 `_currentStage` 游标。
11. 需要对外 Agent 时，只暴露"原子快工具"，不要暴露整条流水线。
