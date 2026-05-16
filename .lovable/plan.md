
## 背景

当前 `parseRequirements` 的分类逻辑只有三类：`hardFilters` / `softPreferences` / `negativeFilters`，全部是「针对单家餐厅的属性」。

但有一类条件本质上**不是餐厅属性，而是品类属性**，例如：

- 「用餐时间 1-2 小时」→ 拉面/盖饭天然 < 1h，omakase/怀石/法餐天然 > 2h
- 「适合带 3 岁小孩」→ 家庭餐厅/连锁居酒屋 ✔；高级寿司/吧台店 ✘
- 「想轻一点 / 不想太饱」→ 沙拉/小菜/居酒屋 ✔；烤肉/自助 ✘
- 「想热闹 / 想安静」→ 居酒屋 vs 茶室/法餐
- 「快速解决一顿」→ 拉面/牛丼/咖啡简餐

这类条件如果当 `hardFilter` 塞给 Google Maps 文本搜索是查不出来的，只会让候选变少甚至变空；当 `softPreference` 又只能在最后排序时小幅影响。最优做法是**在用户没指定 cuisine 时，先让 AI 把这类约束翻译成「推荐料理候选」**，再走正常搜索 + 排序。

## 目标

让 `parseRequirements` 把「品类级约束」识别出来，并据此**补全/替换 `cuisines`** 候选，使下游搜索能拉到合适的店；同时把它**保留**为软偏好用于最终排序，避免双重计分。

## 改动范围

只动 `src/lib/echo.functions.ts`，集中在 `parseRequirements`（约 60–278 行）。不改 `searchRestaurants`、UI、Supabase、`ParsedSchema` 现有字段含义。

## 设计

### 1. ParsedSchema 新增一个字段

```ts
cuisineLevelConstraints: z.array(WeightedConditionSchema).catch([]).default([])
```

含义：从用户原话里识别出来的「品类级约束」原文 + 权重，仅用于解释为什么 cuisines 被扩展，UI 可选展示。

### 2. Prompt 新增一节「品类级 vs 餐厅级约束」

在现有 hard/soft 规则之前插入一段最高优先级规则：

- **品类级约束识别清单**（非穷举，模型自行扩展）：
  - 用餐时长 / 总时间 / "X 小时之内" / "想快一点" / "想慢慢吃"
  - 适合 X 岁小孩 / 带宝宝 / 家庭聚餐 / 多人聚会 / 一个人吃
  - 想吃轻一点 / 想吃饱 / 想吃辣 / 想清淡
  - 想热闹 / 想安静 / 适合约会 / 适合谈事
  - 快速 / 顺路解决 / 慢慢喝一杯
- **处理规则**：
  1. 这类条件 **必须**进 `cuisineLevelConstraints`（带 weight）。
  2. **同时**复制一份进 `softPreferences`（保留排序信号，weight 取相同值）。
  3. **不要**进 `hardFilters`（否则文本搜索查不到）。
  4. 如果用户输入框里 **没有显式 cuisine**（`cuisines` 数组为空），模型必须基于这些约束在 `cuisines` 字段里**主动产出 1–3 个匹配品类**（替代当前「推不出来填 ["餐厅"]」的兜底）。例：「东京、用餐 1 小时内、想轻一点」→ `cuisines: ["拉面","乌冬","定食"]`。
  5. 如果用户已显式给了 cuisine，**不要**覆盖；可以在 `searchStrategy` 里说明会按这些约束做排序倾斜。

### 3. 例子（加入 prompt）

输入：「东京，两个人，预算 8000 日元，希望用餐时间在 1 小时左右，简单一点」（cuisines 为空）
- `cuisines`: ["拉面","乌冬","定食"]
- `cuisineLevelConstraints`: [
    {"text":"用餐时间约 1 小时 → 偏向快餐型品类","weight":0.8},
    {"text":"简单一点 → 偏向轻量品类","weight":0.6}
  ]
- `softPreferences`: 同上两条（用于排序）
- `hardFilters`: [{"text":"人均预算 ≤ 8000 JPY","weight":0.8}]

### 4. LooseParsedSchema 同步加宽

加一个可选 `cuisineLevelConstraints: z.array(z.unknown()).optional()`，保持松散 schema 与严格 schema 形状一致，沿用现有「松→严」二段解析。

### 5. 兜底分支

最外层 fallback 里也加 `cuisineLevelConstraints: []`，保持类型完整。

## 不动的部分

- `WeightedConditionSchema` / `WeightCoerced` / `HhmmCoerced` / `sanitizeVisitTime`
- 重试链（gemini-2.5-flash → gpt-5-mini）
- `searchRestaurants` 现有 cuisines→搜索词扩展（`expandCuisineQueries`）逻辑，因为 cuisines 是上游产物
- UI（NeedBubbles、识别需求展示等），若要展示 `cuisineLevelConstraints` 可后续单独做

## 验证

1. `bunx tsc --noEmit` 通过
2. 用「东京 / 跳过 cuisine / 其它需求：用餐 1 小时内、简单一点」触发搜索，确认：
   - `parsed.cuisines` 不再是 `["餐厅"]`，而是拉面/乌冬/定食之类
   - `parsed.hardFilters` 里不再出现「用餐 1 小时」
   - `parsed.softPreferences` / `parsed.cuisineLevelConstraints` 各有一份
3. 同输入但**显式选了**「寿司」→ `cuisines` 保持 `["寿司"]` 不被覆盖
