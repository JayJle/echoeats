# Bug 分析（不改代码，只定位）

## 现象
`谷歌评分 4.0 以上` 标签下文案变成 `Google Maps 实际评分 4.2 / 5；要求 < 4 分` 并判 ✗。

## 链路
Stage A 抽取 → **Stage B 聚类+winner 归一** → Stage C 桶分类（hardFilters[].text） → **verifyGoogleRatingFilter()** 解析出 threshold/comparator 并生成 note → results.tsx 渲染 note。

## 故障节点

### 主因：Stage B winner.normalized（`src/lib/echo.functions.ts` 聚类 prompt）
- gemini-2.5-pro 失败降级到 flash 后，flash 把「4.0 以上」错误归一成含裸 `<` 的字符串（方向反了，小数点也丢了）。
- prompt 没有铁律约束「以上 ↔ ≥」「以下 ↔ ≤」、禁止用 `<`/`>` 反向表达、必须保留小数位。

### 次因：`verifyGoogleRatingFilter` (L1144-1187)
正则按序判 comparator：
1. `<=|≤` → `≤`
2. `<` → `<`   ← 上游脏 text 命中这里
3. `>` → `>`   ← 同时会误吃 `>=`（含 `>`），把「≥4」当「>4」
- 默认 `≥`，但缺 `>=|≥` 显式优先分支。
- 阈值 `([1-5](?:\.\d+)?)` 取首个数字，遇到 `<4 4.0` 这类脏串先吃 `4` 丢小数。

### 非故障节点
Stage A 原句保留正确；Stage C 仅透传 B 的 text；UI 只展示 note。

## 修复方向（待批准后进入 build 模式执行）

1. **Stage B prompt 加铁律**：以上→`≥`、以下→`≤`、至少→`≥`、不超过→`≤`；禁止 `<`/`>` 反向表达；阈值必须保留原小数位。
2. **verifyGoogleRatingFilter 正则修缮**：
   - 在裸 `>` 之前新增 `>=|≥|at least|不少于|不低于` → `≥` 分支。
   - 在裸 `<` 之前确保 `<=|≤` 已优先（已有，OK）。
   - 阈值匹配限定在「评分/rating/stars/分」上下文附近，避免脏串误取。
3. **回归测试**：用本轮 query 重跑，确认 hardFilters[].text 形如 `谷歌评分≥4.0 必须`，UI 显示 `要求 ≥ 4.0 分` 且 ✓。
4. **加观测**：Stage C 输出后打印 `hardFilters[*].text`，便于今后快速判定是 B 归一坏数据还是 verify 误解析。

## 不在本次范围
- 不动 UI 渲染逻辑。
- 不重构 Stage A/C 桶分类。
- 不改模型选择策略（pro→flash 降级保留）。
