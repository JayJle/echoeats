## 目标
让 Tabelog / Yelp 的 Perplexity 搜索命中率更高、字段更准：
1. **两边都新增** "店名 + 区域 + 城市 + cuisine" 的 query 变体（强制）。
2. 多变体若返回不同店铺页，需要判断哪个"最真实"再用。
3. Prompt 优先级重排：**评论 > 评分 > 价位**。

## 现状（核对过的代码事实）
- `yelp.server.ts`：Stage 0 已有 2-3 条变体（`name+city`、`name+street`、兜底 `name-only`），均无 cuisine；已有 `scoreCandidates` 多 batch 打分机制。
- `tabelog.server.ts`：**没有 Stage 0 多变体预搜**，直接进 sonar；没有候选打分逻辑。
- 调用点 `echo.functions.ts` L1485 / L1528 都没传 cuisine，但 cuisine 在外层 `placeResults` 循环里现成可用。

## 方案

### 1. 调用点传入 cuisine（`echo.functions.ts`）
两个 fetch 调用循环里把 `r.cuisine` 透传：
- `fetchTabelogInfo(p.name, p.address, data.city, r.cuisine)`
- `fetchYelpInfo(p.name, p.address, data.city, isEn, r.cuisine)`

`allTargets` 改为 `{ p, cuisine }[]`。

### 2. Yelp 多变体 + 真实性判定（`yelp.server.ts`）
- `fetchYelpInfo` / `preSearchYelp` 签名加 `cuisine?: string`。
- `preSearchYelp` 强制并发 3 条变体（cuisine 非空时 4 条）：
  - `"${name}" ${city} site:yelp.com`（已有）
  - `${name} ${street} site:yelp.com`（已有）
  - **新：`"${name}" ${area} ${city} ${cuisine} site:yelp.com`**
  - 全空兜底：`${name} site:yelp.com/biz`（已有）
- **真实性判定**：复用 `scoreCandidates` 并增强 —— 当 cuisine 非空时，对 snippet/title 命中 cuisine 关键词的候选额外 +1 分；多变体重复出现继续 +1。最终取 top1 即"最真实"的店铺页。

### 3. Tabelog 多变体 + 真实性判定（`tabelog.server.ts`）
新增 Stage 0 预搜（之前完全没有），与 Yelp 同构：
- 新增 `preSearchTabelog`：Perplexity `/search` 端点，并发 2-3 条变体：
  - `"${name}" ${area || city} site:tabelog.com`
  - **新：`"${name}" ${area || city} ${cuisine} site:tabelog.com`**（cuisine 非空时）
  - 兜底：`${name} site:tabelog.com`
- 用 `TABELOG_SHOP_URL_RE` 过滤候选，新增一个 `scoreTabelogCandidates`：
  - 店名 token 命中 URL 路径 → +2
  - URL 路径里的 prefecture / area code（`/tokyo/`、`/A1301/` 等）与 `extractJPArea(address)` 命中 → +2
  - snippet/title 命中 cuisine 关键词 → +1
  - 多变体重复出现 → +1
  - 取 top1 为 `preUrl`，传给后续 sonar/sonar-pro prompt 让模型"核验+读取该页面"。
- 预搜失败时退回原行为。

### 4. Prompt 字段优先级重排（两边一致）
两边 userPrompt 顶部加：

> **字段优先级（按顺序读）**：
> 1. **summary（评论口碑）**：最关键，必须基于真实评论文本归纳具体菜品/服务/氛围；评论读不通顺也宁可短，禁止空着。
> 2. **rating（评分）/ reviewCount（评论数）**：直接读页面字段。
> 3. **priceRange / priceLevel（价位）**：读到就给。
>
> 4 项都尽力读；读不到才返回 null，禁止编造。

### 5. 不动
- 评分公式 / admitted / 排序 / 评论排序 不变。
- 并发上限 8、超时、重试 不变。
- 缓存 key 仍是 `name|address`（cuisine 同一家店稳定，不进 key 避免碎片化）。

## 改动文件
| 文件 | 改动 |
|---|---|
| `src/lib/echo.functions.ts` | `allTargets` 携带 cuisine；两个 fetch 多传 cuisine |
| `src/lib/yelp.server.ts` | 加 cuisine 参数；强制新增 `name+area+city+cuisine` 变体；`scoreCandidates` 加 cuisine 命中加分；prompt 重排优先级 |
| `src/lib/tabelog.server.ts` | 加 cuisine 参数；新增 `preSearchTabelog` 多变体 + `scoreTabelogCandidates` 真实性打分；把 top1 作为 preUrl 传给现有 sonar 调用；prompt 重排优先级 |

## 一个确认
新增变体会让每家店多 1 次 Perplexity `/search` 调用（Tabelog 还会多一次预搜阶段）。这是**轻量端点**，但总调用量会上升 ~30-50%。确认接受这个代价换命中率？