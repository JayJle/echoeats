# 日期时间硬筛（语言无关 · 零误触发）— 已实现

## 三道闸门控（任一不过 → visitTime=null，不过滤）
1. AI `visitTime.mentioned=true`
2. `visitTime.evidence` 必须在 freeText 中子串匹配（lowercase + 去空格归一化）
3. `weekday` 和 `hhmm` 都必须齐全

## 落地文件
- `src/lib/google-places.server.ts`：FIELD_MASK + `periods` 解析，`PlaceCandidate.openingPeriods`
- `src/lib/dianping.server.ts`：补 `openingPeriods: null`
- `src/lib/echo.functions.ts`：`ParsedSchema.visitTime`、prompt 规则 + few-shot、`sanitizeVisitTime`、`isOpenAt()`、placeResults 过滤、Restaurant `visitTimeMatch`
- `src/lib/store.ts`：`Restaurant.visitTimeMatch`、`ParsedRequirements.visitTime`
- `src/routes/results.tsx`：徽章（open 绿 / unknown 灰），仅触发时显示

## 锚点策略（模糊词）
早上 08:30 / 中午 12:30 / 下午 14:30 / 傍晚 18:30 / 晚上 19:00 / 深夜 22:00

## 保留策略
只剔除 `closed`；`unknown`（无 periods 数据）一律保留；cuisine 全空 → 回退前 3 个标 `needsReview`。
