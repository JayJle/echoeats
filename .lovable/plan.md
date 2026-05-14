## 目标

当 Perplexity 网评摘要里**真的用到了**大众点评 / 小红书的内容时，在卡片上轻描淡写地提一句来源。不做其它改动。

## 改动

**1. `src/lib/echo.functions.ts` — `fetchReviewSummary`**
- `ReviewSummary` 类型新增 `sources: string[]`（去重后的平台名，如 `["大众点评", "小红书"]`）。
- Perplexity prompt + json_schema 新增字段：让它返回 `sources`，枚举 `["大众点评", "小红书", "Tabelog", "Google Reviews", "Yelp", "其它"]`，只列**真正被引用**的平台。

**2. `src/lib/echo.functions.ts` — AI 排序提示词**
- 在 `aiSummary` 规则里加一句："如果 realWorldReviews.sources 包含大众点评或小红书，aiSummary 末尾用括号补一句『（综合大众点评/小红书等网友评价）』之类的轻提示。"

**3. 不动**
- 前端 `results.tsx` 不改（来源会自然出现在 aiSummary 里）。
- `Restaurant` schema 不加新字段。
- 大众点评评分行继续显示「无数据」（你说先不做）。
- buildLinks、Firecrawl、布局全部不动。

## 风险
- 来源完全依赖 Perplexity 的诚实度。如果它没真去大众点评/小红书，prompt 已要求它不要乱填 sources。
- 如果某店 Perplexity 没找到任何来源（sourceCount=0），review 不会传给 AI，aiSummary 自然不会提，符合预期。

确认就改。
