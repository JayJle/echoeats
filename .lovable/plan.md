我会把需求解析严格改成下面这条流水线，不再出现先分桶再合并的问题：

```text
Stage A：全量抽取
  输入 freeText
  输出 raw items：所有时间 / 菜品 / 条件原话片段
  不分 hard / soft / negative，不打分，不去重

Stage B：全局语义合并
  输入 Stage A 的全部 items，一次性混在一起处理
  按话题/维度聚簇：环境、档次定位、服务、评分、菜品精致、社区安静等
  同维度不管正向/反向/强弱，都合并到同一簇并让 AI 取舍 winner
  只有阈值或角色不同才拆开，例如：评分≥4.0 必须 vs 评分≥4.3 最好

Stage C：分桶 + 打分
  只输入 Stage B 的 winners
  再决定 hardFilters / softPreferences / negativeFilters / dishPreferences / cuisineLevelConstraints
  同时根据语气强度打 weight
```

具体改动：

1. **改 Stage B prompt**
   - 明确写死：这是“全局合并”，不是 bucket 内合并。
   - 禁止按 hard / soft / negative / positive / negative direction 分开聚簇。
   - 强化例子：
     - “环境稍微好一点 / 环境好啊 / 环境一定要好” → 一个环境簇，winner 选“一定要好”。
     - “不能低端 / 必须中高端 / 不要太低端 / 不能太高端 / 不要 luxurious” → 一个档次定位簇，由 AI 取舍成“中高端但不豪华”。
     - “谷歌评分必须 4.0 以上 / 最好 4.3 以上” → 两个簇，因为阈值和角色不同。

2. **改 Stage C prompt**
   - 明确 Stage C 只能对 winners 分桶、打分，不能重新把同一维度拆成多条。
   - 如果 winner 本身包含正反边界，例如“中高端但不豪华/不低端”，Stage C 要生成一个最合适的桶位表达，不能又拆回 hard + negative 多条重复约束。
   - 分桶后同一语义维度最多保留一条，除非 Stage B 已经因为阈值/角色不同拆成多个 winner。

3. **加结果自检兜底**
   - 在 finalize 阶段继续做精确去重。
   - 增加一个轻量语义维度检查 prompt/规则约束在 Stage C 中完成，避免 Stage C 把已经合并的 winner 再拆散。

4. **用你这段 brunch 文本跑完整 1→2→3 流程验证**
   - 期望最终不会再出现“环境”多条散落。
   - “中高端 / 不低端 / 不豪华 / 不太高端”会收敛成同一个档次定位要求。
   - “评分≥4.0 必须”和“评分≥4.3 最好”保留为两个不同层级条件。
   - 我会把最终 parsed 输出贴给你看。