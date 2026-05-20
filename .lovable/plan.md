## 目标

把 Tabelog 那套「Perplexity 代抓 → 严格 JSON → 进卡片」的架构原样复用到 Yelp，覆盖海外用户的真实点评信号。

**决策汇总（已确认）**：
- 数据源：Perplexity（和 Tabelog 同构，不接 Yelp Fusion 官方 API）
- 触发国家：`US / CA / FR / IT / DE / ES / GB`
- 价格信号：**只展示，不参与硬过滤**（不像 Tabelog 的 priceJPY 会 fail 候选）
- 执行：deep 模式 + 并发 8（和 Tabelog 完全一致）
- 无数据时：**不展示 Yelp 名片行**（和 Tabelog 当前行为一致）

---

## 实现步骤

### 1. 新建 `src/lib/yelp.server.ts`

照 `tabelog.server.ts` 复刻，差异点：

- **类型** `YelpInfo`：`rating: string | null`、`reviewCount: number | null`、`url: string | null`、`priceLevel: "$"|"$$"|"$$$"|"$$$$"|null`、`summary: string | null`（去掉 priceJPY / priceRange 数字解析）
- **URL 正则**：`/https?:\/\/(?:www\.)?yelp\.[a-z.]+\/biz\/[a-z0-9\-]+/i`（兼容 yelp.com / yelp.fr / yelp.co.uk 等地区域名）
- **`extractArea(address)`**：抽 city + region（US/CA 抽 city + state；EU 抽 city + 邮编前缀），替代 `extractJPArea`
- **两阶段 Perplexity**：
  - Stage 1：`sonar` + `search_domain_filter:["yelp.com","yelp.fr","yelp.it","yelp.de","yelp.es","yelp.co.uk","yelp.ca"]`
  - Stage 2：`sonar-pro` + 显式 `site:yelp.com "店名" "city"` 提示
- **Prompt 规则**（参考 Tabelog Stage1/Stage2 模板，改成 Yelp 语境）：
  - 必须返回 `yelp.*/biz/<slug>` 详情页，禁止 search/list/category 页
  - 店名+地址必须能合理对应；同名不同店 → 全 null
  - rating / reviewCount / priceLevel / summary 取不到 → null，禁止编造
  - summary 1-2 句，UI 语言跟随用户（中文用户用简体中文，≤60 字；英文用户用英文，≤80 chars）
- **JSON schema** 五字段强约束（同 Tabelog 套路）
- **进程内 Map 缓存**（同 key 规则 `name|address` 小写）

### 2. `src/lib/echo.functions.ts` 接入点改动

不重写大段，只做这些**外科手术**：

- 顶部 import `fetchYelpInfo, type YelpInfo from "./yelp.server"`
- 新增常量 `const YELP_COUNTRIES = new Set(["US","CA","FR","IT","DE","ES","GB"])`
- `searchRestaurants` 内：紧跟 Tabelog 那段后，加一段**完全对称**的 Yelp 分支
  - `if (YELP_COUNTRIES.has(country) && mode !== "quick")` 触发
  - `yield { type: "stage", stage: "yelp", total }` + 心跳 4s + 并发 8（`p-limit` 或现有 helper）
  - 结果存 `yelpById: Map<string, YelpInfo>`
- `Stream` 联合类型加 `{ type: "yelp-progress"; done: number; total: number }`
- 候选构造（1123、1435、1508 三处）：每处加一行 `const yelp = yelpById.get(p.placeId) ?? null` 并塞进候选 JSON 的 `yelp` 字段（rating/reviewCount/priceLevel/summary/url）
- AI 排序 prompt（1232-1244 附近）：在「Tabelog 信号」段后追加一段「Yelp 信号（仅 US/CA/西欧店铺可能有）：所有字段只作展示，**不参与硬过滤**；yelp 为 null 时不扣分」
- `SOURCE_ENUM` 已含 "Yelp"，无需改
- `candidateRatings()`（663-695）扩参 `yelp: YelpInfo | null`，仿照 tabelog 逻辑：`if (yelp?.rating != null) rows.push({ platform: "Yelp", score: ... })`；**yelp 为 null 时不 push**（即不展示名片行，符合用户期望）
- 候选输出 `links` 数组：仅当 `yelp?.url` 存在时 push `{ label: "Yelp", url: yelp.url }`（不存在时不放 fallback 搜索链，避免假名片）

### 3. 心跳与超时

照搬 Tabelog 模式：4s 心跳 progress event、单次 Perplexity 20s timeout、整体 stage 不强制 deadline。

### 4. 不动的部分

- `parseRequirements`、UI、i18n、`store.ts`、Tabelog 相关全部不动
- 不新增 secret（Perplexity key 已有）
- 不动数据库（无持久化需求，进程内缓存够用）

---

## 技术细节

### Perplexity Stage 1 prompt 草稿（中文用户）

```
查找 Yelp 上的店铺：
- 店名：${name}
- 地址：${address}
- 城市：${city}
- 地区提示：${area}

要求：
- 必须是 yelp.com / yelp.<地区域名> 上真实存在的店铺详情页（URL 形如 https://www.yelp.com/biz/<slug>）。绝对不要返回搜索/列表/分类页。
- 店名和地址必须合理对应；同名不同店一律算找不到，宁可全部返回 null。
- url: 找到即返回；评分/评论数/价位/摘要可单独 null。
- rating: Yelp 综合评分（数字字符串如 "4.3"，0-5 范围）。读不到 → null。
- reviewCount: 评论数（整数）。读不到 → null。
- priceLevel: "$" / "$$" / "$$$" / "$$$$" 之一（Yelp 页面显示的 Price 字段）。读不到 → null。
- summary: 1-2 句简体中文，归纳 Yelp 评论口碑（具体菜品/服务/氛围），≤ 60 字。读不到 → null。

只输出 JSON。找不到匹配店铺时所有字段返回 null。
```

英文用户走同模板英文版，summary 用英文。

### 风险与回退

- **Yelp 在西欧覆盖弱于北美**：Stage1 命中率预计 60-70%（vs Tabelog JP 80%+），Stage2 兜底能拉到 75%。剩下 25% 自动不展示名片，无副作用。
- **Yelp.fr / Yelp.de 等地区域名 URL 也合法**：正则做了兼容，summary 强制中/英不会出现法语德语。
- **不阻塞主流程**：Yelp stage 整体失败也只是 yelpById 为空，rank 阶段完全可用。
