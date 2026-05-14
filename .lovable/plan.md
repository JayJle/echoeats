## 目标

在**不把"明确不符合要求"的店加进结果**的前提下，尽可能扩大输出数量。核心原则：
- `fail`（明确证伪）→ 剔除
- `ok`（明确符合）→ 进 ok 区
- `unknown`（信息缺失、无法证伪）→ 不丢，进 partial 区

## 修改清单（仅 `src/lib/echo.functions.ts`，不动 UI）

### 1. 扩大 Google 候选池

- `searchPlaces.maxResults`：15 → **20**（Google API 单次上限）。
- 每个料理发 **2 条查询**并按 `placeId` 去重合并：
  - 主查询：`"${cuisine} ${city}"`
  - 语义补充查询：
    - 日语城市 → `"${cuisine} ${city} おすすめ"`
    - 中文城市 → `"${cuisine} ${city} 推荐"`
    - 其它 → `"best ${cuisine} ${city}"`

预计每组候选从 ~15 提到 ~30+。

### 2. 网评覆盖率提升

- Perplexity 抓取从 top5 → **top10**（按 Google 评分降序）。让更多店拿到 `realWorldReviews`，减少"因没数据被判 unknown"。
- 用 `Promise.allSettled` 包裹，单次失败不影响整组。

### 3. AI prompt 调整（关键，防止误剔）

- 数量上限：**"尽可能多挑出符合的店，最多 15 家，不要刻意压缩数量"**（替换原 "3-8 家"）。
- 强化 fail / unknown 边界，在铁律加一条：
  > **"fail 仅在候选数据或 realWorldReviews 明确证伪时使用（例如：明确写了'仅晚市'但用户要午餐 → fail）。一切'数据里没说'、'网评没提'、'无法核实'的情况一律 unknown，禁止凭推测打 fail。"**

### 4. 输出上限扩容

- AI picks slice：12 → **20**（`:655`）
- ok 区 slice：8 → **15**（`:728`）
- partial 区 slice：6 → **15**（`:729`）

### 5. partial 区噪声控制

不加分数门槛（怕误伤）。但在合并时按 `matchScore` 降序排，保证用户看到的前几家是 AI 最有把握的。

## 不改的部分

- 价格"只信网评"的规则保留：没有 review price 时，含预算硬条件 → unknown（落 partial），不回退到 Google `$/$$`。
- "任一 fail 直接剔除" 的判定保留（`:676`）—— 这正是"不把不符合要求的店加进来"的护栏。
- 前端 UI（results.tsx）不动；已有的 partial 区分栏 + "✓/？硬条件"标注复用。

## 风险与对策

- **Perplexity 调用数翻倍**（每组 5→10）：成本上升，但显著降低 unknown 比例，值得；用 allSettled 兜底失败。
- **AI 候选输入变大**（每组 ~30 个候选 × maxOutputTokens=6000）：可能触顶。若实测 AI 输出被截断，再把 `maxOutputTokens` 提到 **10000**。
- **第二条查询可能返回大量重叠**：靠 placeId 去重，最终池子大小不会爆炸。

## 涉及文件

- `src/lib/echo.functions.ts`：候选池扩容、双查询、Perplexity top10、prompt 调整、slice 扩容、partial 排序。
