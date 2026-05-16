## 目标
当 `parsed.visitTime` 实际作为硬筛选生效时（即同时含 weekday + hhmm 通过校验），在结果页顶部「搜索条件卡片」中像「硬条件 / 偏好 / 排除」一样显示一枚徽标，让用户清晰看到时间也参与了过滤；未提到时间则完全不显示。

## 改动范围（仅前端展示）

### `src/routes/results.tsx`
在 `parsed.hardFilters` 区块之前（或紧邻其后），新增一个仅在 `parsed.visitTime?.weekday != null && parsed.visitTime?.hhmm` 时渲染的区块：

```
营业时间
[ 🕐 {visitTime.raw}  ·  周X HH:MM 营业 ]
```

样式与硬条件徽标一致（`bg-primary/15 text-primary border border-primary/30`），但加一个钟表 emoji 前缀以便区分。

- 主文案：优先用 `visitTime.raw`（用户原话，如「周六晚上 7 点」/「Saturday 7 pm」）。
- 副文案（opacity-60）：用 `weekday` + `hhmm` 渲染成本地化的「周X HH:MM」，作为机器解析结果的可验证回显。
- weekday 映射：0=周日,1=周一,…,6=周六（与 Google periods 一致）。

### 顶部副标题 `parsed.dateTime`
保持现状不动（那是 freeText 里的「今天/本周末」之类自由文字，与新加的时间筛选语义不同）。

## 不做的事
- 不动 `echo.functions.ts`、`google-places.server.ts`、`store.ts` 中的过滤/数据逻辑。
- 不动现有硬条件/偏好/排除/菜品偏好的渲染。
- 不加日期选择器、不做时区转换、不改打分。
- 餐厅卡片上的「✓ 营业 / ? 营业未知」徽标维持不变。

## 验收
- 「周六晚上 7 点想吃日料」→ 顶部条件卡片出现「营业时间 · 周六 19:00 营业」徽标，且过滤生效。
- 「两个人预算 15000 找日料」→ 无任何时间徽标。
- 「晚上去」（缺 weekday）→ 无时间徽标（因为本就不触发过滤）。
- 英文「Saturday 7 pm sushi」→ 出现徽标，raw 显示英文原话。
