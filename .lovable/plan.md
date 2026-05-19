## 问题

截图：`Must be near the station · 0.9` 出现在 PREFERENCES（softPreferences）里。按权重表 0.8+ 属"必须/可验证硬约束"档，应该是 hard。AI 偶发错分。

## 方案（不改 prompt，仅服务端兜底）

单点改动：`src/lib/echo.functions.ts` line 261 之后（`ParsedSchema.parse(output)` 之后、return 之前），加：

```ts
// 一致性兜底：weight >= 0.8 的 soft 一律提升为 hard
const promoted = parsed.softPreferences.filter((s) => s.weight >= 0.8);
if (promoted.length) {
  parsed.hardFilters = [...parsed.hardFilters, ...promoted];
  parsed.softPreferences = parsed.softPreferences.filter((s) => s.weight < 0.8);
}
```

## 边界

- 阈值 `>= 0.8`，与 prompt 权重表一致
- 不动 negativeFilters（否定句独立通道）
- 不去重：AI 几乎不会双塞 hard+soft，必要时后续再加

## 不在范围

- prompt 调整 / 英文强制词识别
- hard → soft 反向降级
- 前端展示
