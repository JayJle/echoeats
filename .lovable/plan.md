## 修正后的定位

明白了 —— 反馈的用途是**评估「这次搜索整体是否准、是否符合预期」**，用来改进**搜索系统本身**（prompt 规则、料理扩展、硬条件解析、Tabelog 触发等），**不影响任何具体店铺以后是否出现**。

也就是说：反馈是**对系统的质检信号**，不是对单店的口碑评分。

---

## 收集什么

每次搜索完成后，在结果页底部放一条非阻断式反馈区：

1. **「最后我去了哪家？」**（可选，单选）
   - 列表里勾一个，或选「都没去 / 去了别的店」
   - 如果是"别的店"，可输入店名（自由文本）
2. **「这次推荐准吗？」**
   - 👍 准 / 👎 不准
3. **如果👎，勾选不准的原因**（多选 chips，降低填写成本）：
   - 推荐的店不符合我的硬条件
   - 推荐的店不是我想要的料理
   - 评分/评价信息不靠谱
   - 漏掉了我知道的好店
   - 排序不合理
   - 其它（短文本）

关键：**店名只是上下文信息**，不会进入"以后封杀这家店"的逻辑。

---

## 数据怎么用（这才是和上一版的核心差异）

收集到的反馈**只用于聚合分析系统级问题**，不做 per-restaurant 调权：

### A. 搜索质量看板（仅给你 / 开发自己看）
- 整体 👍 率、按城市/料理拆分
- 高频👎原因分布 → 直接告诉你"硬条件解析"还是"料理扩展"是当前最大短板

### B. 反向校验 prompt 规则
例如：发现「关西 / 烤肉」👎 率显著高于平均，且原因集中在"不是我想要的料理"——
→ 说明 `cuisine-expand.server.ts` 在该地区的 synonym/negativeKeyword 不够好
→ 你手工调 prompt 或词表，**不是写死封杀某家店**

### C. 「最后选了哪家」的用法（重要）
- 仅作为**搜索召回是否覆盖到用户意图**的指标：
  - 若用户选的是结果列表里的店 → 召回 OK
  - 若用户填"去了别的店 XX" → 召回缺失，那个店名值得你人工看一下为什么没被 Google Places 召回（关键词？区域？）
- **不会**因为某店被选多次就把它推到前面，也**不会**因为某店没人选就降权。

---

## 数据模型（极简）

启用 Lovable Cloud，建两张表：

```text
search_sessions
  id, anon_id, city, cuisines[], parsed_json,
  results_snapshot (jsonb：当时返回的店 id+名称+排名), created_at

search_feedback
  id, session_id,
  chosen_from_results (restaurant_id | null),
  chosen_external_name (text | null),   -- 用户填的"别的店"
  overall ('up' | 'down'),
  down_reasons (text[]),                -- 勾选的原因
  comment (text | null),
  created_at
```

**RLS**：匿名 insert 允许，select 只允许 service role（看板走 server fn）。

---

## UI 改动（results.tsx）

- 每张卡片右下角小 checkbox：「✓ 我去了这家」（点一下高亮，再点取消）
- 结果列表底部固定一个浅色反馈卡：
  - 👍 / 👎 两个大按钮
  - 点👎后展开原因 chips + 可选评论
  - 提交后变成 "感谢反馈 ✓"
- 不阻断、不强制、不弹窗。

---

## 实施步骤（建议本轮一次做完）

1. 启用 Lovable Cloud
2. 建 `search_sessions` + `search_feedback` 表 + RLS
3. `feedback.functions.ts`：`createSession` / `submitFeedback`
4. `echo.functions.ts` 在搜索成功后调用 `createSession`，把 sessionId 写进 store
5. `results.tsx` 加「✓ 我去了这家」+ 底部反馈卡
6. （可选）一个简单的 `/admin/feedback` 路由展示聚合数据，仅本地查看

---

## 需要你确认

1. 反馈匿名（基于浏览器生成的 anon_id）即可，对吗？还是想强制登录？
2. 是否同意启用 Lovable Cloud（前置条件）？
3. MVP 范围按上面来，还是某些字段（比如"不准的原因"chips）想精简掉？
