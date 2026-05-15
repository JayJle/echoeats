## 目标
1. 当 Tabelog 拿到价位（priceRange）且用户填了预算硬条件 → **用 Tabelog 价位作为筛选依据**（优先级高于 Google priceLevel 和 Perplexity 网评价）。
2. Tabelog 其它字段（rating / reviewCount / summary）只作为附加展示，不参与硬过滤。
3. 显著提高 Tabelog 命中率，让更多日本店有评分/评论/价位/URL。

---

## 改动一：提高 Tabelog 命中率（`src/lib/tabelog.server.ts`）

### 1. 两阶段查询，失败自动升级
- **第一轮（现状保留）**：`sonar` + `search_domain_filter: ["tabelog.com"]`，快、便宜。
- **第二轮（新增，仅当第一轮返回 null 时触发）**：
  - 改用 `sonar-pro`（推理更强，引用更多）。
  - 去掉 `search_domain_filter`，改用 prompt 里的 `site:tabelog.com "店名" "区/市"` 显式约束。
  - 提示词强调：先按"店名 + 地址中的区/町"匹配 Tabelog 店铺页（URL 形如 `tabelog.com/<pref>/A.../...../...../`），再读评分/口碑数/价位。

### 2. 提示词增强
- 把 Google 地址里能提取到的 **都道府県 + 区/市/町** 显式拆出来塞进 prompt，要求 Tabelog 页地址必须落在同一行政区。
- 同时给出店名的 **平假名/片假名/汉字 + 罗马字** 两种写法（如果都能拿到则一起给），降低同名误匹配。

### 3. 放宽接受条件 + 写回 citations
- 现在已经实现"URL-only 也接受"，保留。
- 增加：第二轮即便没有 JSON URL，只要 `citations` 里出现一条 `tabelog.com/<pref>/A.../.../.../<digits>/` 的店铺页 URL，就把它当成 url 写回（当前只匹配到 `tabelog.com/`，会把列表页也算进来 → 收紧成"店铺页正则"，避免拿到搜索/分类页）。

### 4. 网络与缓存
- 超时 12s → 20s（第二轮 sonar-pro 偏慢）。
- 缓存键继续用 `name|address.toLowerCase()`，第二轮失败也写 `null` 入缓存避免重复扣费。
- 失败原因写日志（`http_status` / `no_citations` / `parse_error` / `wrong_url_shape`）方便后续定位。

### 5. 扩大覆盖面（`src/lib/echo.functions.ts`）
- 当前只查每组 Google 评分 **top 15**。改为：**该组所有候选都查 Tabelog**（候选已经过料理保真过滤，量级一般 ≤ 30/组）。
- 用 `Promise.allSettled` + 简单并发上限（如同时 ≤ 8）防止突发并发把 Perplexity 限流。

---

## 改动二：Tabelog 价位参与硬过滤

### 1. 解析 priceRange 为数字区间（`tabelog.server.ts`）
新增 `parseTabelogPriceJPY(priceRange)`：
- 识别 `"￥6,000〜￥7,999"` / `"¥6000～¥7999"` / `"￥10,000～"` / `"〜￥3,000"` 等常见写法。
- 输出 `{ low: number | null, high: number | null, currency: "JPY" } | null`。
- 同时保留原始字符串供前端展示。

`TabelogInfo` 类型新增字段 `priceJPY: { low, high } | null`，向下兼容（原 `priceRange` 字段保留）。

### 2. 把解析后的价位传给 AI
在 `candidatesForPrompt` 的每个候选里，新增字段：
```
tabelogPriceJPY: { low: 6000, high: 7999 } | null
```
仅在 region=JP 且 Tabelog 命中时存在。

### 3. AI prompt 价格规则升级（在原"价格判断"段插入新优先级）
新规则按以下优先级判断预算硬条件：
1. **`tabelogPriceJPY` 存在且用户预算币种是 JPY** → 必须用 Tabelog 价位判断（覆盖 Google / 网评价）：
   - `low > 用户预算上限` → fail
   - `high ≤ 用户预算上限` → ok
   - 区间跨过预算上限 → unknown（让用户自己看）
2. 否则回退到现有规则（`priceFromReviews` → Google `priceLevel`）。
3. Tabelog 评分/口碑数/summary **不参与硬过滤**，仅可写进 aiSummary / pros / cons 作为附加证据，且必须忠实于 `tabelog.summary` 原文。

### 4. 前端展示不变
- `ratings` 里的 "Tabelog" 项继续显示分数。
- `tabelog.priceRange` 原文仍显示在卡片里。
- 如果是因 Tabelog 价位 fail 被剔除，会自然落入 partial（unknown 时）或被剔除（fail 时），用户从 hardFilterChecks 的 note 里能看到"Tabelog ￥10,000~ > 预算 ¥8000 → fail"。

---

## 不做的事
- 不直接爬 Tabelog（ToS / 反爬）。继续走 Perplexity。
- 不把 Tabelog 评分和 Google 评分加权合并。
- 不影响中国大陆城市分支（`useDianping`）。
- 反馈数据继续不参与排序（保持你之前定的"反馈仅作摆设"约定）。

---

## 验证
1. 用东京/京都/札幌/福冈各搜一次，预期日志里 `[Tabelog]` 命中率明显上升（第二轮 sonar-pro 兜底命中）。
2. 在「其它需求」里写"预算 5000 日元以内"，搜索后：
   - Tabelog 价位 ≥ ￥6,000 的店应被剔除或落入 partial，hardFilterChecks 注明"Tabelog ￥6,000~7,999 > ¥5000"。
   - Tabelog 价位 ≤ ￥5,000 的店应稳定进 ok。
   - 没有 Tabelog 价位的店仍按 Google/网评回退判断（保持现状）。
3. 没有预算硬条件时，Tabelog 价位不应影响结果排序，只在卡片里展示。