# 上下节点连通性核验结论

已通读 `src/lib/echo.functions.ts` 关键拼接处（schema 定义、Pass1 调用、打分层、copyTargets 构造、Pass2 回填、photos 阶段），**两段式改造与上下游完全打通，无需再改任何代码**。

## 端到端数据流（已核验）

```text
candidatesForPrompt
  ├─[Pass1] rankVerifyGroup (12家/批，并行)
  │   └─ 输出: AiVerifyPick { placeId, verificationStatus, matchScore, hardFilterChecks, matchDetails }
  ↓
mergedGroups (Map<cuisine, AiPick[]>)         ← AiVerifyPick 是 AiPick 的子集，结构兼容
  ↓
三层打分 (Layer1 准入 + Layer2 贝叶斯 + Layer3 matchScore×0.47 + …)  ← 完全未动
  ↓
restaurants[] 初始化:
  • aiSummary = pick?.aiSummary || "因资料不足暂时保留…"   ← Pass1 不返回，落到 fallback 文案
  • pros / cons = []                                         ← Pass1 不返回，留空待 Pass2 填
  ↓
top5 / partial / failed 分桶 + builtList 排序
  ↓
copyTargets: 每个 cuisine 的前 5 家 (placeId + name + address + 3条 googleReviews + tabelog/yelp summary)
  ↓
[Pass2] rankCopyGroup (并行，复用 "rank" 心跳)
  └─ 输出: AiCopyPick { placeId, aiSummary, pros, cons }
  ↓
copyById Map 回填：
  • aiSummary 非空才覆盖（保留 Pass1 fallback 兜底）
  • pros / cons 非空才覆盖
  ↓
yield { stage: "photos" } → resolvePhotoUrl → 返回 RestaurantSchema
```

## 关键兼容点

1. **Schema 兼容**：`AiVerifyPickSchema` ⊂ `AiPickSchema`，`mergedGroups` 用宽 schema 装窄数据，`pick?.aiSummary` 类型安全（永远 undefined → 走 fallback）。
2. **失败降级闭环**：Pass1 单 group 失败 → `picks: []`，三层打分仍按 pool 全跑，admitted 但 matchScore=0 → finalScore 仍能产生（不丢店）；Pass2 单 group 失败 → 文案不回填，aiSummary 保留 Pass1 fallback 文案，pros/cons 保持 []，UI 不崩。
3. **前端 UI 零改动**：Pass2 复用 `withHeartbeat(..., "rank")`，stage 序列仍是 `rank → photos → done`，无新增 stage、无需 i18n 改动。
4. **类型一致**：`CopyGroupInput` 已在 1912 行定义，2330 行使用类型匹配。
5. **placeId 串联**：`placeByRestaurantId` (2296 写入) → `copyTargets` 取 `place.placeId` (2341) → `copyById` (2366) → 回填时再次 `place.placeId` 查找 (2377-2379)，链路一致。

## 结论

无需新增代码改动。建议下一轮直接实测：选 2-3 个 cuisine 跑一遍，观察日志：
- `[Echo/AI-rank] all N group(s) done`
- `[Echo/AI-copy] all M group(s) done`
- 卡片 aiSummary / pros / cons 是否填入（top5）且无横向比较语
- 落榜店（>top5）保留 Pass1 fallback 文案
