## 问题

截图：`Must be near the station · 0.9` 出现在 PREFERENCES（softPreferences）里。按既定权重表 0.9 = "必须/一定" 档，应该是 hard。AI 偶发错分。

## 方案（不改 prompt，仅服务端兜底）

单点改动：`src/lib/echo.functions.ts` line 261 之后（`ParsedSchema.parse(output)` 返回前），加一段 normalize：

```ts
// 一致性兜底：weight >= 0.8 的 soft 一律提升为 hard（按既定权重表，0.8+ 属"必须/可验证硬约束"档）
const promoted = parsed.softPreferences.filter((s) => s.weight >= 0.8);
if (promoted.length) {
  parsed.hardFilters = [...parsed.hardFilters, ...promoted];
  parsed.softPreferences = parsed.softPreferences.filter((s) => s.weight < 0.8);
}
```

放在 `parsed.cuisinesInferred = ...` 赋值之前/之后都行，return 前即可。

## 边界

- 阈值用 `>= 0.8`（与 prompt 里 0.8 = "可验证硬约束基线"一致）。
- 不动 negativeFilters（否定句独立通道，已正确）。
- 不动 prompt，避免影响其他分类逻辑。
- 不去重：若同条已被 AI 同时塞进 hard + soft，会出现重复 —— 现实里 AI 二选一，几乎不会双塞；如果出现，可后续加 `text` 去重。

## 不在范围

- 英文强制词识别 / prompt 调整
- hard → soft 反向降级
- 前端展示样式
