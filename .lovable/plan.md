
# 餐厅召回与筛选流程升级（最终版）

```text
多路召回（8 路/品类）
   ↓
规则初筛（仅用 Google Places 直接字段）
   ↓
候选池（不设上限）
   ↓
AI 详筛（逻辑完全不变：12 家/批 并行，三级降级）
   ↓
三层综合打分（准入 / 基础 40 / 匹配 60）
   ↓
每个品类各取 Top 5，前端按品类 Tab 展示
```

---

## 一、多路召回

每个品类根据用户结构化 JSON 动态生成查询，并发跑（`Promise.allSettled`），每路最多 20 家，去重合并。

最多 8 路/品类，按优先级触发：

| 路名 | 触发条件 | 示例（东京拉面）|
|---|---|---|
| 主词 | 必跑 | `ラーメン 东京` |
| 推荐后缀 | 必跑 | `ラーメン 东京 おすすめ` |
| 同义词 1/2 | 已有 expansion | `豚骨ラーメン 东京` / `家系ラーメン 东京` |
| 菜品路 | `dishPreferences` 非空 | 每个菜品独立一路 |
| 场景路 | hard/soft 命中场景词（包间/一人/约会/家庭/聚会/安静） | `ラーメン 东京 個室` |
| 时段路 | `visitTime` 命中 brunch/late-night | `ラーメン 东京 深夜営業` |
| 预算路 | hardFilters 含预算 | 高预算 `高級`/`fine dining`；低预算 `安い`/`cheap eats` |

负向词不进 query，留给规则初筛和 AI。
每家店挂 `recallSources: string[]` 记录命中路。

---

## 二、规则初筛（仅 Google Places 直接字段）

| 规则 | 用到的字段 | 触发条件 |
|---|---|---|
| 区域筛 | `formattedAddress` / `location` | 复用现有逻辑 |
| 料理保真筛 | `displayName` / `primaryType` / `types` | 复用现有逻辑 |
| 营业时间筛 | `regularOpeningHours` / `currentOpeningHours` | 复用现有 `isOpenAt` |
| 评分硬门槛 | `rating` / `userRatingCount` | hardFilters 含「评分 ≥ X」且 weight ≥ 0.85，评论数 ≥ 30 时执行 |
| 价位档次筛 | `priceLevel` | 用户预算明显低 → 剔除 VERY_EXPENSIVE；用户要求高档 → 剔除 INEXPENSIVE。无字段不剔除 |
| 营业状态筛 | `businessStatus` | `CLOSED_PERMANENTLY` / `CLOSED_TEMPORARILY` 剔除 |

Google Places 无直接字段可判断的需求（包间/一人/约会氛围/避雷/菜单）全部交给 AI。

---

## 三、候选池

不设上限。规则初筛后剩多少全部送 AI。日志记录候选池大小，便于后续观察成本/耗时。

---

## 四、AI 详筛

**逻辑完全不变**：
- 每品类候选 `Promise.all` 并行
- 每批 12 家 `Promise.all` 并发调 Gemini 2.5 Flash
- 三级降级（structured → raw JSON → slim cards）
- 输出 `hardFilterChecks[]` / `matchDetails[]` / `verificationStatus` / `matchScore`
- 评分确定性覆盖、unknown 降级等现有规则保留

---

## 五、综合打分（三层结构 · 满分 100）

### Layer 1 · 准入层（一票否决，不进 Top 5）

任一触发即踢出，扔进「更多候选」折叠区：

- 任一 hardFilter `weight ≥ 0.85` 且 status=fail
- 任一 negativeFilter `weight ≥ 0.85` 且 status=fail
- 贝叶斯调整评分 < 3.5 且 `userRatingCount ≥ 50`
- `businessStatus` 非 OPERATIONAL

### Layer 2 · 基础分（满分 40，店本身质量）

**贝叶斯平均评分**（防止小样本高分刷榜）：

```text
C = 20
globalMean = 3.8
adjustedRating = (rating × userRatingCount + globalMean × C) / (userRatingCount + C)
baseScore = clamp(0, 40, adjustedRating × 8)
```

效果：
- 评分 4.8 / 5 条评论 → 调整后 ≈4.0 → 基础分 32
- 评分 4.5 / 500 条评论 → 调整后 ≈4.48 → 基础分 35.8

### Layer 3 · 匹配分（满分 60，对你合不合适）

```text
matchScore =
   AI matchScore × 0.35                         (0..35，AI 总判断)
 - Σ(hardFilter.weight × 8)   status=fail        硬条件违反重扣
 - Σ(hardFilter.weight × 2)   status=unknown
 + Σ(soft.weight × 5)         status=ok          软偏好命中加分，上限 +15
 - Σ(soft.weight × 3)         status=fail
 - Σ(negative.weight × 10)    status=fail        避雷命中重扣
 + dishHit × 4               每个菜品命中，上限 +12
 + recallBonus               多路召回非线性加分

recallBonus = [0, 0, 3, 6, 10][min(recallSources.length, 4)]
```

### 最终分

```text
finalScore = clamp(0, 100, baseScore + matchScore)
```

每家店保留 `scoreBreakdown[]` 记录每一项加减来源（前端卡片可展开看依据）。

---

## 六、出结果

- **每个品类**独立排序：按 `finalScore` 降序
- 每个品类取 Top 5
- 准入层踢出的 + Top 5 之外的进「更多候选」折叠区
- 前端按品类 Tab 展示（结构不变）

---

## 七、改动文件

- `src/lib/echo.functions.ts`：召回 query 构造、规则初筛新字段、综合打分函数、重排
- `src/lib/store.ts`：`Restaurant` 类型加 `scoreBreakdown?` 和 `recallSources?`
- `src/routes/results.tsx`：卡片新增打分明细展开区

---

## 八、可观测性

每次搜索打日志：
- 每路召回命中数 + 去重后总数
- 规则初筛剔除数（按规则分类）
- 候选池大小
- AI 调用批次数
- 每品类 Top 5 平均 finalScore
- 准入层踢出数（按原因分类）

---

## 九、打分核心原则（PM 视角）

1. **不踩雷 > 最对题**：硬条件违反 + 避雷命中扣分极重，宁可少推不可推错
2. **加分扣分混合**：硬条件违反扣分，软偏好命中加分（不命中不影响）
3. **后悔成本驱动权重**：用户后悔成本越高，扣分越重（包间没有 -8/单位权重 > 安静度不够 -3）
4. **贝叶斯防刷榜**：小样本高分不冲顶
5. **多路命中非线性**：防 SEO 强但内容平庸的店刷分
