
# 搜索耗时优化方案（最小风险，不改功能）

## 优化项

所有改动在 `src/lib/echo.functions.ts` + 新增内存缓存模块，不动前端、不动数据结构、不动 prompt 内容（只改候选数量与 token 上限）。

### A. Tabelog 抓取缩到 Top 12（按 Google rating 排序）
当前 JP 分支对所有候选（常 30–60 家）抓 Tabelog → 改为 Top 12。最终每组只展示 ≤15 家，长尾低分店即使有 Tabelog 也基本进不了 picks。
**预计 JP 搜索快 30–50%。**

### B. Perplexity 网评 Top 10 → Top 6 + 评分门槛
- 每组只对 Top 6 抓网评（原 Top 10）
- 增加门槛：`rating >= 3.5 && userRatingCount >= 30` 才抓
**预计海外搜索快 25–40%。**
影响：被门槛过滤掉的店 pros/cons 留空、aiSummary 走"仅基于 Google 数据"分支（已是现有兜底）。

### C. 砍掉第 3 条 Google Places 查询（`semanticSuffix`）
保留主词 + 同义词×2，去掉 `おすすめ/推荐/best` 那条。每组省 1 次 HTTP（约 1–2s），召回率几乎不掉。

### D. AI 排序 prompt 候选裁剪 + 输出 token 收紧
- 喂给排序 prompt 的候选每组截断到 Top 25（按 rating 排序）
- `maxOutputTokens` 10000 → 6000
**预计 AI 排序快 20–35%。** 已有 fallback 解析兜底超长输出。

### E. cuisineExpansion 进程内缓存
新增 `Map<string, CuisineExpansion>` 内存缓存（key = `cuisine|city|language`，TTL 1h）。重复搜索每料理省 1× Gemini 调用（约 1–2s）。

### F. Perplexity 单次超时 20s → 12s
慢请求不再拖批尾。已有静默忽略兜底。

## 不做的事

- 不改前端、不合并 step
- 不改 AI prompt 文本（仅候选数量 + token 上限）
- 不改 schema、不动 Restaurant / Results 数据形状
- 不引入新依赖
- 不动 client/server 文件、不动 supabase/config.toml

## 预期效果

- 海外（JP）单料理：**40–55% 提速**（~60–90s → ~30–45s）
- 海外多料理（3+）：**35–50% 提速**
- 国内（CN）：基本不变（瓶颈在 Dianping，不在本轮）

## 验证

1. 触发一次 JP 搜索，对比 `[Tabelog]` / `[Perplexity]` 日志计数与时长
2. 同一组 (city, cuisine, freeText) 跑 2 次，第 2 次明显更快（验证 E）
3. 抽查 JP Top 5 仍带 Tabelog 数据 + pros/cons（验证 A、B 不破坏展示）
