# 证据补齐大改：Perplexity 只做「一手读取」，AI 自己分析

## 现状（已核对代码）
- 日本（Tabelog）和 US/CA/西欧（Yelp）：Perplexity 读店铺页后只返回 评分 / 评论数 / 价位 / 一句 ≤60 字中文摘要。输出上限 400（sonar）/ 700（sonar-pro）token。
- 官网：Google Places 已返回官网链接，但目前只用于展示，没有人去读官网内容。
- 其他地区只依赖 Google 评论和 Editorial Summary。
- quick 模式完全跳过 Perplexity。

## 新的三步证据补齐

```text
第 1 步 点评平台（必做）  Tabelog（日本）/ Yelp（欧美）
第 2 步 官网（必做）      介绍、菜单与招牌菜、价格、地址、营业时间
第 3 步 网络补充（按需）  只在前两步缺关键信息时触发
```

### 第 1 步：点评平台改为返回原文评论
- 保留现有的店铺页定位（预搜 + 打分挑 URL + sonar→sonar-pro），只改返回内容。
- 返回：评分、评论数、价位，加上 **6 条原文评论**（不翻译、不总结），每条带星级和日期，每条最多约 300 字。
- 选评论规则：尽量最新 + 好评差评都有（至少 1–2 条低分），避免只拿到好评。
- 删掉 Perplexity 写的摘要，改由我们的 AI 在核验和打分时直接读原文。

**为什么是 6 条**：Google 已经给了最多 5 条评论，加 6 条平台评论，每家约 11 条，足够判断「环境好不好、有没有某道菜」这类软需求；超过 8 条后边际收益小，而且会拖慢后面 AI 核验（30 家 × 每家多几千字）。

### 第 2 步：官网（新增，必做）
- 有 Google 官网链接：让 Perplexity 只读这个网站（限定域名），不用再搜。
- 没有官网链接，或链接是 Instagram/Facebook/订餐平台：用 Perplexity 搜一次「店名 + 地址 官网」，同样要求名称和地址对得上，否则视为没有。
- 返回：餐厅简介、菜单（菜名 + 价格，最多约 20 项）、招牌菜、价格区间、地址、营业时间、是否需要预约。
- 所有地区都做（不再只限日本 / 欧美），quick 模式仍跳过。

### 第 3 步：网络补充（按需）
- 只在以下情况触发：前两步都没有菜单信息，或用户的某条 hard 需求在所有证据中都找不到依据（例如「有包间」「可带宠物」）。
- 做法：一次通用搜索，只针对缺的那一项去找，返回原文片段 + 来源链接。
- 不满足条件就跳过，不花钱。

### 证据怎么用
- Pass 1 核验：Google 评论 + 平台原文评论 + 官网菜单/介绍 + 补充片段一起作为证据；每条 match detail 注明证据来自哪里（Google / Tabelog / Yelp / 官网 / 网络）。
- Pass 2 打分、Pass 3 文案：同样可以引用菜单和原文评论，例如「官网菜单有 X」「Tabelog 评论提到 Y」。
- 结果页：显示官网链接；能拿到菜单时展示几道招牌菜和价格。

## 成本估算（未验证，需上线后看实际账单）
- 第 1 步：调用次数不变，每次输出从约 400 token 涨到约 1,500 token。sonar 的输出很便宜，每家增加不到 0.2 美分；sonar-pro 兜底时会贵一些。
- 第 2 步：每家新增 1 次 sonar 调用（没有官网链接时 +1 次搜索）。30–60 家估计每次搜索多约 0.3–0.6 美元。
- 第 3 步：按需触发，预计只有少数餐厅用到。
- 省钱措施：继续按店名+地址缓存；官网调用只用 sonar，不升级 sonar-pro；第 3 步只做排名前 15 的餐厅。
- 速度：官网和点评平台并行抓取，预计总耗时增加不多，但 AI 核验阶段读的内容会变多，可能慢几秒。

## 验证方式
- 跑一次东京寿司、一次美国意大利菜：检查日志中每家餐厅原文评论条数、官网命中率、第 3 步触发次数、每步耗时和失败情况。
- 抽查几条 match detail，确认引用的评论/菜单原文真实存在。
- 记录 Perplexity 调用次数，作为成本对比依据。

## 技术细节
- `tabelog.server.ts` / `yelp.server.ts`：schema 去掉 `summary`，新增 `reviews: {text, rating, date}[]`（最多 6 条），max_tokens 调到约 1,800；解析时做长度截断与校验。
- 新增 `official-site.server.ts`：输入 `websiteUri`；排除社交/订餐域名；sonar + `search_domain_filter=[官网域名]`；schema `{url, intro, menu[{name, price}], signatureDishes[], priceRange, address, hours, reservation}`；缓存同上。
- 新增 `web-supplement.server.ts`：只在缺菜单 / hard 条件全部 unknown 时调用，返回 `{snippets[{text, sourceUrl}]}`。
- `echo.functions.ts`：Tabelog/Yelp 与官网改为同一个并发池并行（上限 8）；evidence 结构加入 `platformReviews`、`officialSite`、`webSupplement`；Pass 1/2/3 的 prompt 加入新证据块并要求标注来源；新增 `official_site`、`web_supplement` 阶段的 echoLog（start/ok/fail、命中数、耗时）。
- `results.tsx`：显示官网链接和招牌菜（有数据时）。
- 同步更新 README、`docs/ARCHITECTURE.md`、`roadmap.md`。
