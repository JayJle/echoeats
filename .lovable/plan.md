## 目标

把 Tabelog 从「与 Google 并列的双信号」降级为「仅作参考的辅助信号」：Match Score 主要由 Google 数据 + realWorldReviews 决定，Tabelog 不参与打分，只在 UI 上作为可展开的补充信息呈现。

## 1. Match Score 逻辑（`src/lib/echo.functions.ts` 第 904 行附近的 prompt）

把当前关于 Tabelog 的那条铁律改写成更明确的「辅助、不参与打分」语义：

- **Tabelog 不参与 matchScore 打分**：matchScore 的依据只能是 Google 数据（rating / userRatingCount / priceLevel / editorialSummary / openNow）+ realWorldReviews（reviewHighlights / commonComplaints）+ 用户硬条件/偏好的核对结果。
- **Tabelog 仅作辅助参考**：当 Google 已能得出明确判断时，Tabelog 不改变结论；只有当 Google 信号薄弱（如评分缺失、评论极少）时，Tabelog 评分才能作为信心补充，**最多影响 ±2 分**，不得用 Tabelog 评分单独抬高或压低 tier。
- **冲突时以 Google 为准**：若 Tabelog 与 Google 评分/价格/口碑出现明显冲突，aiSummary / pros / cons 以 Google + realWorldReviews 为主，Tabelog 数据可在 aiSummary 中以「Tabelog 上则…」形式轻提一句，但不影响打分与 tier。
- **Tabelog 不进 matchDetails**：matchDetails 只反映用户硬/软条件相关项，Tabelog 评分本身不出现在 matchDetails 里（避免给用户「Tabelog 也参与匹配」的误导）。
- 保留：aiSummary 可在末尾轻提 Tabelog 信号作为交叉验证文案，但「网友说」之类表述仍只能引用 realWorldReviews。

不动：Tabelog 抓取流程、缓存、字段、`candidatesForPrompt` 里 tabelog 字段照常传入。

## 2. Tabelog 卡片折叠（`src/routes/results.tsx` 第 266-397 行）

把整个 Tabelog 区块改成默认折叠的 `<details>` / 自定义 collapsible：

- 折叠态（默认）只显示一行摘要：`食べログ  ★3.62 (412)  夜 ¥6k–8k  招牌：江戸前寿司 …` + 右侧「展开 ▾」。  
  各字段缺失则跳过（评分缺失就只显示「食べログ 补充信息 ▾」）。
- 展开态：保持现有完整布局（评分 / 荣誉 / 预算 / 场景 / 招牌菜 / summary / 好评亮点 / 差评提醒 / 食客原话 / 在 Tabelog 查看 →）。
- 视觉上把背景从 `bg-accent/20` 弱化为 `bg-muted/20`，淡化存在感，避免与 Google 主信息抢戏。
- 用原生 `<details><summary>` 实现，零依赖、SSR 友好；`summary` 自定义样式去掉默认三角，用 `▾ / ▴` 文本指示。

## 3. 不做的事

- 不改 Tabelog 抓取范围/字段/缓存。
- 不改 Google Places 调用、不改非 Tabelog 的排序逻辑。
- 不动反馈面板、不动其他平台（大众点评 / 小红书）逻辑。
- 不改 Ratings 区块里 Tabelog 那一行（保留以便快速看到分数）。

## 4. 验证

- 用东京样例搜索：确认 Tabelog 卡默认折叠，点击能展开看到完整字段。
- 同一查询下，去掉 tabelog 字段做对比，matchScore 变化应 ≤2 分（说明 Tabelog 已基本不参与打分）。
- 检查 server log `[Tabelog]` 行无报错，已缓存数据照常渲染。

## 技术细节

- prompt 改动只动 904 行附近这一段铁律，同时把 905 行 tier 阈值保留不变。
- `<details>` 的 `open` 属性不设，默认折叠；`summary` 加 `cursor-pointer list-none [&::-webkit-details-marker]:hidden` 去掉浏览器默认箭头。
- 折叠摘要里的字段拼接顺序：评分 → 夜预算（或 priceRange 兜底）→ 第一道招牌菜，最多三段，避免单行过长。