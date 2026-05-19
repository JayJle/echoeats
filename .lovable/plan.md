## 目标

每次查询，每个 cuisine 在结果页**始终返回 5 个餐厅**（除非该 cuisine 在 Google Places 候选池里本来就不足 5 家）。

## 当前行为（为什么 American 只有 4 个）

`src/lib/echo.functions.ts`：

1. AI prompt（line 1383）写的是「精挑 3-5 家最匹配的店…宁缺毋滥」——AI 经常只返回 3-4 个。
2. AI 返回的 picks 再被分桶为：
   - `ok`（所有硬条件 status=ok）
   - `partial`（含 unknown）
   - 直接剔除（任一高权重硬条件 fail）
3. 没有任何"补足到 5 个"的兜底逻辑。American 这种宽泛品类，AI 觉得"明显匹配的就 4 家"，结果页就只有 4 个。

## 改造方案（三级补足，始终 5 个）

### Tier 1：精准匹配（保持现状）
AI 排序 → ok 桶 + partial 桶，按 score 排序。

### Tier 2：放宽到「满足 hard + neg」
如果 Tier 1 合计 < 5，从**同 cuisine 的 AI picks 中被剔除的候选**和**未被 AI 选中但通过料理保真过滤的候选**里补：
- 仍要求没有命中料理反例关键词（保留 cuisine-expand 的过滤）
- 仍要求没有高权重硬条件 fail
- 按 (rating × log(reviewCount)) 排序补足

### Tier 3：完全放宽
如果 Tier 1+2 仍 < 5，从**剩余所有候选**（同 cuisine、Google Places 原始返回）里按 rating 排序补到 5 个，**不再校验 hard / neg**，前端用一个明确的"放宽匹配"标签提示。

新增 `matchTier: "relaxed"` 或复用 `partial` + 在 `matchDetails` 顶部插一条 warn "已放宽匹配条件以补足 5 个推荐"。

### Prompt 同步调整
把 line 1383 的「精挑 3-5 家…宁缺毋滥」改为「**尽量给满 5 家**（硬上限 5）；如果候选里实在凑不出 5 个像样的，也可以少给，剩下由系统兜底补足」。

## 具体改动点（仅一个文件）

`src/lib/echo.functions.ts`：

1. **Line 1383** — 改 prompt 文案为"目标 5 家，不足由系统补"。
2. **Line 1532-1671** — 在 `groups` 构造里：
   - 保留现有 ok/partial 分桶逻辑
   - 算出 `need = 5 - (restaurants.length + partialRestaurants.length)`
   - 若 `need > 0`：
     - 用 `placeResults` 里该 cuisine 的全部候选 minus 已用 placeId，做 Tier 2 / Tier 3 兜底
     - 兜底餐厅用合成 restaurant 对象（沿用 Google 数据，无 AI summary，aiSummary 直接说明"基于 Google 数据自动补充"）
     - 放进 `partialRestaurants`，并加 matchDetail "已放宽匹配条件以补足 5 个推荐"
   - 把现有 `.slice(0, 15)` 改成 `.slice(0, 5)`（去掉无意义的 15）
3. **不动**前端（`src/components/...`）：复用现有 partial 区域展示即可。如你希望前端把"放宽补足"的卡片单独再分一段，可以后续再加。

## 边界

- 该 cuisine Google Places 原始返回就 < 5 家 → 只返回真实数量，不编造。
- Tabelog / Dianping 评论拉取**只对 Tier 1 picks 做**（已经做完）；Tier 2/3 补足的餐厅不二次调用网评 API，避免延迟。

## 不在本次范围

- 多 cuisine 之间互相借位（用户没要求）。
- 前端样式区分（如有需要再做）。
