# 跨平台证据感强化方案

## 目标
让用户在每张餐厅卡片上**一眼看出**：
1. 这条结论来自哪几个平台（覆盖广度）
2. 每条 pros / cons 是哪个平台的网友说的（可溯源 / 证据感）

**约束**：不新增独立区块，不让卡片变高。复用现有 `pros` / `cons` / 头部区域。

---

## UI 改动（仅 results.tsx，纯前端展示层 + 一个 schema 字段）

### 1. 卡片头部加一行"数据来源徽章带"
位置：在 `#index` 那一行的右边、或紧贴店名下方的一行小徽章。
内容：一组迷你 chip，按本次实际命中的平台动态显示：
```
来源： [G Google] [点 大众点评] [食 Tabelog] [小 小红书]
```
- 每个 chip ~20px 高，单行显示，整行约 24px，不显著增高
- 命中（有评论或评分）才显示，不命中灰掉或隐藏
- chip 可点击 → 跳转该平台对应链接（Tabelog 用 `tabelog.url`，Google 用 `googleMapsUri`，点评用 `links` 里的对应项）

### 2. 每条 pros / cons 末尾加来源小标签
现状：
```
+ 食材新鲜，性价比高
```
改为：
```
+ 食材新鲜，性价比高  · 大众点评
− 上菜慢            · Google
```
- 来源标签用 `text-[10px] text-muted-foreground` 同行尾部，不另起一行 → 零增高
- hover/tap 可显示原句（如果有），用 `title` 属性即可，最低成本

### 3. AI Summary 区块加一行轻量"综合自"行
现状底部 AI 总结已经在 prompt 里要求追加"（综合大众点评、小红书等网友评价）"，但是塞在正文里不显眼。
改：从 `aiSummary` 字符串里把这段提取出来（或单独从新字段读），渲染成总结下方一行 11px 灰字 `综合自：Google · 大众点评 · Tabelog`。

---

## 后端改动（src/lib/echo.functions.ts，最小侵入）

### Schema 扩展
给 `pros` / `cons` 增加可选 `source` 字段，但**保持向后兼容**（字符串数组也能解析）：
```ts
const ProConItem = z.union([
  z.string(),                                       // 旧格式
  z.object({ text: z.string(), source: z.string().optional() }) // 新格式
]);
pros: z.array(ProConItem).default([]),
cons: z.array(ProConItem).default([]),
```
前端归一化后渲染。

### Prompt 调整（echo.functions.ts 约 1433 行附近）
在描述 pros/cons 输出格式时追加一句：
> 每条 pros/cons 必须以 `{ text, source }` 对象输出，`source` 取值范围：`"Google"` / `"大众点评"` / `"Tabelog"` / `"小红书"` / `"综合"`（多平台一致时）。来源必须可在 `realWorldReviews` 中找到对应依据，禁止编造。

### 顶部"来源命中"判定
不需要 AI 输出，前端基于现有数据直接算：
- Google: `r.ratings` 里 Google 分数非 null **或** `realWorldReviews` 含 Google
- 大众点评: `r.ratings` 里点评分数非 null **或** `links` 含 dianping.com
- Tabelog: `r.tabelog != null`
- 小红书: `links` 含 xiaohongshu.com 或 aiSummary 文本提到

---

## 不做的事
- ❌ 不给每个平台像 Tabelog 那样开独立大区块（会过度冗长，且 Google/点评没有完整摘要内容支撑）
- ❌ 不改进度条 / 检索阶段 UI
- ❌ 不动 ratings 现有的两列网格（它本身就是跨平台展示，只是太静态）

## 范围
- `src/routes/results.tsx`：头部徽章带、pros/cons 渲染、AI summary 下方加一行
- `src/lib/echo.functions.ts`：`pros`/`cons` schema + prompt 一段话
- `src/lib/store.ts`：`Restaurant` 类型 `pros`/`cons` 改为 `(string | { text; source })[]`
- i18n：`results.dataSources` 等 3-4 个新 key

## 预期效果
- 卡片纵向增高约 24px（仅顶部徽章带），其余改动均为同行内补充
- 用户一眼看到顶部"来源：G 点 食"三个徽章 → 感知覆盖广
- 看 pros/cons 时每条尾部有"· 大众点评"→ 感知有据可查
