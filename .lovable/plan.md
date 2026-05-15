## 方案 A：Step 3 排序模型降级到 `gemini-2.5-flash`

### 改动

**文件：** `src/lib/echo.functions.ts`

将 Step 3（最终排序与推荐生成）使用的模型从：
```
google/gemini-2.5-pro
```
改为：
```
google/gemini-2.5-flash
```

仅此一处改动。Step 1（料理扩展）保持 `google/gemini-3-flash-preview` 不变。

### 不变

- Google Places 流程、FieldMask
- Perplexity 评论与 Tabelog 抓取（含缓存逻辑）
- `compositeScore`、fallback 分层、料理保真过滤
- UI、`/results` 路由、`FeedbackPanel`、重启对话
- 数据库结构（`review_cache` / `tabelog_cache` / `search_sessions` / `search_feedback`）

### 预期效果

- Step 3 耗时：15–25s → 5–8s
- 总耗时：45–60s → 25–40s，远低于 ~50s 的网关超时阈值
- 准确率：`gemini-2.5-flash` 比 `gemini-3-flash-preview` 更强，比 pro 略弱，作为最终排序足够
- 成本：相比 pro 显著下降

### 风险

低。flash 处理 12–20 个候选店铺的排序与简短推荐文案完全胜任；如后续发现排序质量下降，可再考虑方案 C（限制候选数后回到 pro）。
