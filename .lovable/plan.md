## 目标
从 Tabelog 抓取更丰富的信号，让结果页的 Tabelog 区块从「评分 + 一句话摘要」升级到能真正帮用户决策。

## 现状
当前 `fetchTabelogInfo` 只抓 5 个字段：`rating / reviewCount / url / priceRange / summary`，其中 `priceRange` 只有一个数字段，`summary` 只有 1-2 句话。前端展示也很简洁。

## 计划

### 1. 扩展抓取字段（`src/lib/tabelog.server.ts`）

在 `TabelogInfo` 类型 + Perplexity 的 JSON schema + prompt 里新增：

- `dinnerBudget` / `lunchBudget` — 分别对应 Tabelog 的「夜の予算」「ランチ予算」（旧 `priceRange` 合并字段拆开，更准确）
- `topDishes` — 食客高频提到的招牌菜，最多 4 个，字符串数组
- `goodPoints` — 高频好评要点（食材/服务/氛围），最多 3 条，每条 ≤ 25 字
- `badPoints` — 高频差评/吐槽，最多 3 条，每条 ≤ 25 字（无则空数组，禁止编造）
- `reviewQuotes` — 1-2 条简体中文翻译过的真实食客原话节选，每条 ≤ 40 字
- `awards` — Tabelog 是否标注百名店 / The Tabelog Award / Bronze 等荣誉，字符串或 null
- `recommendedScene` — 适合场景（约会/家庭/接待/独食），字符串或 null

保留 `rating / reviewCount / url / summary`。`priceRange` 字段保留以兼容已缓存数据，但优先使用拆分后的 dinner/lunch。

### 2. Prompt 与抓取逻辑

- 更新 system prompt：明确要求只总结 Tabelog 页面上真实出现的口コミ和店铺信息，禁止跨站补全，找不到一律返回 null/空数组。
- 把 `max_tokens` 从 400 提到 ~900 以容纳更多字段。
- 在缓存键不变的前提下，校验和清洗每个新字段（去 HTML、限长、限数组长度）。
- 验收条件保持「只要有 tabelog.com URL 就保留」。

### 3. 前端展示（`src/routes/results.tsx` 内 Tabelog 区块）

把 Tabelog 卡片重构成更有层次的一块：

```text
Tabelog 补充信号                            食べログ
─────────────────────────────────────────────
评分 3.62 (412)        荣誉 百名店 2024
夜の予算 ￥6,000–7,999  ランチ ￥1,000–1,999
适合场景 约会 / 接待

招牌菜：江戸前寿司 / 海胆军舰 / 玉子焼 / 椀物

“摘要一句话总结。”

好评亮点
+ 食材新鮮度极高
+ 师傅讲解贴心
+ 氛围安静

差评提醒
− 价格偏高
− 预约难

食客原话
“…翻译过的引用 1…”
“…翻译过的引用 2…”

在 Tabelog 查看 →
```

字段缺失时整段隐藏，不显示空标题。文案保持简体中文。

### 4. 不做的事

- 不直接爬 Tabelog（继续用 Perplexity + `search_domain_filter`）。
- 不把 Tabelog 信号并入 Match Score 或推荐排序。
- 不修改非日本城市的分支。
- 不改反馈相关逻辑。

### 5. 验证

- 用一个东京/大阪样例搜索，确认结果对象里 `tabelog` 至少出现 `dinnerBudget` 或 `topDishes` 之一。
- 确认旧缓存条目（只有 priceRange）仍能正常渲染。
- 检查 server log `[Tabelog]` 行无新增报错。
