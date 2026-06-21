## 问题

结果页"匹配详情"下方的"高频好评 / 高频差评"目前会掺杂匹配性判断（例如"评论提到了厚切牛肉"、"位于市中心"这种围绕用户条件转的句子），但用户的预期是：**好评/差评只反映这家店本身在各平台（Google / Tabelog / Yelp）上的真实口碑，与"是否匹配你的需求"完全脱钩**——匹配性已经在上方的"匹配详情/硬条件"里讲过了，不要重复。

根因：`src/lib/echo.functions.ts` 的 ranking prompt（`buildPromptForGroup`，约 1665–1706 行）里没有对 `pros / cons` 的语义边界做任何约束，模型自然会把"是否符合用户条件"也写进去。

## 修复方案（只动 prompt，不改 UI、不改 schema）

在 `src/lib/echo.functions.ts` 的 `buildPromptForGroup` 里，新增一段"pros/cons 写作规范"硬约束，明确：

1. **数据源限定**：只能基于候选数据里的 `googleReviews / tabelog / yelp / realWorldReviews / reviewHighlights` 等真实平台评价；没有平台评论就返回空数组，**严禁**用 `editorialSummary`、地址、营业时间、Google 评分数值等非评论字段编凑好评/差评。
2. **语义边界**：pros 是"多位食客称赞的点"，cons 是"多位食客抱怨/吐槽的点"。**禁止**出现任何带"符合 / 匹配 / 满足 / 命中 用户条件 / 用户需求 / 您的要求"等措辞，也禁止以"评论提到 XX（用户偏好的菜/场景/地段）"的句式去回扣用户输入。
3. **与匹配判断解耦**：即使某条评论同时支持了某个匹配条件，写进 pros/cons 时只描述"食客觉得 XX 好/不好"，不要附带"因此满足你的 XX 需求"。匹配判断只属于 `hardFilterChecks` 和 `matchDetails`。
4. **去重边界**：pros/cons 与 `matchDetails` 不应表达同一句话；如果某点已经在 `matchDetails` 里作为匹配证据出现，pros/cons 这边换一个"纯口碑"角度写，或者干脆不写。
5. **来源标注**：每条 pros/cons 优先在 `source` 字段标明来源平台（Google / Tabelog / Yelp）；只有一两条孤证就不要硬凑成"高频"。
6. **空值优先**：宁缺毋滥——平台评论不足时直接返回空数组，前端已经有"暂无可信网评 / 暂无明显差评"的兜底文案。

同时在中英文两个 `langDirective` 各加一句呼应：pros/cons 必须是"对这家店的口碑描述"，禁止回扣用户需求。

## 验证

让用户在结果页随便点开一家原来 pros/cons 含"符合/匹配 XX 需求"句式的店，确认改写后那一段只描述食客本身的好评/差评点，与上方匹配详情不再语义重叠。

## 不在本次范围

- 不改 UI、不改字段、不改打分逻辑。
- 不处理 `aiSummary` / `matchDetails` 已有的语言或判定问题（之前两轮已处理）。
- 不动 Tabelog/Yelp/Google 这些平台名（属于专有名词）。