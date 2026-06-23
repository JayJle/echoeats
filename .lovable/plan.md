# 省 token：pool 上限 30 + 砍掉 time/scene 两路

## 目标
1. 在 AI-verify 之前给每个 cuisine 的 pool **加 30 家硬上限**，按预筛分数截断尾部
2. 多路查询里**砍掉 time 路和 scene 路**，保留 primary / recommend / synonyms / dishes / budget

## 改动 1：砍 time + scene 路（`src/lib/echo.functions.ts` ~1362-1386）

`buildSearchRoutes` 里删除两段：
- scene 路：检测个室/约会/家庭等场景关键词生成的那一段
- time 路：visitTime 边缘时段（深夜 / brunch）生成的那一段

保留：primary、recommend、synonyms(×2)、dishes(每道菜 1 路)、budget(±1)。
8 路上限改为 6（同步把 `routes.length >= 8` 改成 `>= 6`），quick 模式不动。

## 改动 2：pool 上限 30（`src/lib/echo.functions.ts`）

在 places 阶段所有过滤完成、`pool=N` 那行日志打印之前（≈ line 2730 附近），加一段截断：

```ts
const POOL_CAP = 30;
if (pool.length > POOL_CAP) {
  // pool 已按预筛分排序；如果没排序就先按 rules-prefilter 分排
  pool.sort((a, b) => (b.prefilterScore ?? 0) - (a.prefilterScore ?? 0));
  const dropped = pool.length - POOL_CAP;
  pool = pool.slice(0, POOL_CAP);
  console.log(`[Echo/places] cuisine="${cuisine}" pool capped ${pool.length + dropped} → ${POOL_CAP} (dropped tail ${dropped})`);
}
```

（实施时按代码里实际变量名/排序字段调整；如果当前没有现成 prefilterScore，就用 google rating × log(reviewCount) 之类的简单 proxy 排，或者直接按现有 sort 顺序的前 30 截。）

## 不动的部分
- 去重逻辑（按 placeId merge）
- AI verify/score/copy 的 prompt、schema、batch 切分（BATCH_SIZE=12 保持）
- 三方抓取（Tabelog/Yelp）、photos、纯 JS 打分
- cuisine-expand
- quick 模式

## 预期效果（按上次 brunch 日志推算）

| cuisine | 旧 pool | 新 pool | Pass1 batch 数 | token 节省 |
|---|---|---|---|---|
| 早餐店 | 33 | 30 | 3→3 | ~10% |
| 法式西餐 | 16 | 16 | 2→2 | 0 |
| 美式西餐 | 47 | 30 | 4→3 | ~36% |

加上砍 2 路，Google Places API 调用减少 ~25%，pool 整体还会自然变小一点（重叠减少）。

整体 LLM token 估计降 **20-35%**，召回质量损失主要在边缘场景（深夜/brunch/个室约会这种小众诉求），主流 cuisine 召回基本不变。

## 验证
跑一次有多 cuisine、有 visitTime（晚上）、有场景词（约会/家庭）的查询，对比日志：
- `[Echo/places] cuisine=... pool capped X → 30` 出现
- `[Echo/AI-rank] groups=N` 中 batch 总数下降
- 餐厅最终结果质量主观对比（前 5 名是否还在）
