## 目标

日本店铺在保留 Google Places 评分/评价的基础上，**额外**抓取 Tabelog 的评分和一句话点评摘要，作为补充信号显示。两边评分**分开展示、互不覆盖**，AI 排序时也能同时看到两个信号。

## 范围

只动后端 1 个新文件 + 2 处小改 + 前端 1 处展示块。不影响非日本地区。

```text
新增  src/lib/tabelog.server.ts        # 拉 Tabelog 评分 + 摘要
改   src/lib/echo.functions.ts        # JP 分支并发拉 Tabelog，注入到 ratings + 新字段
改   src/lib/store.ts                  # Restaurant 增加 tabelog 字段
改   src/routes/results.tsx            # Ratings 区块按"来源分组"展示
```

## 1. Tabelog 抓取层（`src/lib/tabelog.server.ts`）

不直接爬 Tabelog（ToS 风险 + IP 封锁），用 **Perplexity sonar + `search_domain_filter:["tabelog.com"]`** 让 Perplexity 代为读取并返回结构化结果。

接口：

```ts
fetchTabelogInfo(name: string, address: string, city: string): Promise<TabelogInfo | null>

type TabelogInfo = {
  rating: string | null;        // 例 "3.62"，原样字符串
  reviewCount: number | null;   // 例 412
  url: string | null;           // tabelog 店铺页 URL
  priceRange: string | null;    // 例 "￥6,000〜￥7,999"
  summary: string | null;       // 1-2 句中文摘要，归纳 Tabelog 用户评价
};
```

实现要点：
- prompt 明确："只参考 tabelog.com 的页面，找到与「${name} / ${address}」最匹配的那一家"
- `response_format: json_schema` 直接拿结构化 JSON，不解析自由文本
- 失败/找不到 → 返回 `null`，不抛错（调用侧静默降级）
- in-memory 缓存（key = `${name}|${address}`）避免同会话重复调用
- 单次超时 12s，超时 → `null`

## 2. 接入点（`echo.functions.ts`）

仅在 `regionCode === "JP"` 分支启用。位置：在 `reviewById`（Perplexity 通用召回）构建完之后，AI 排序之前，并发批量拉 Tabelog：

```ts
if (regionCode === "JP") {
  const top = topCandidatesByPlaceId; // AI 排序前的候选并集，取每 cuisine 前 ~8 家
  const tabelogById = new Map<string, TabelogInfo>();
  await Promise.all(top.map(async (p) => {
    const info = await fetchTabelogInfo(p.name, p.address, data.city);
    if (info) tabelogById.set(p.placeId, info);
  }));
}
```

并发上限 ~8（与现状 Perplexity 召回保持一致），整体新增延迟 < 一次 Perplexity 调用。

## 3. 数据结构改动

**`Restaurant`（store.ts + RestaurantSchema）** 新增字段：

```ts
tabelog: {
  rating: string | null;
  reviewCount: number | null;
  url: string | null;
  summary: string | null;
} | null;
```

**`ratings` 数组保持现有结构**，但 JP 分支组装时追加一条 `{ platform: "Tabelog", score: "3.62 (412)" }`，与 Google 评分并列。这样旧 UI 不改也能直接看到两个分数。

## 4. AI 排序 prompt 增强（极小改动）

在塞给排序 LLM 的 candidate 描述里加一行（仅当有 tabelog 数据）：

```
candidate.tabelog: rating=3.62, reviews=412, summary="..."
```

并在 prompt 注释里说明：「Google 和 Tabelog 评分体系不同（Tabelog 普遍偏低，3.5+ 已是优质），不要简单相加，而是作为两路独立信号交叉验证」。

不改 `hardFilters` 合约，不影响其它逻辑。

## 5. 前端展示（`results.tsx`）

**Ratings 区块改成两栏**（仅在有 Tabelog 数据时分组）：

```text
┌─ Ratings ──────────────────────────────┐
│  Google              4.3 ★ (1.2k)      │
│  Google 评价摘要     "..."             │
├────────────────────────────────────────┤
│  Tabelog             3.62 ★ (412)      │
│  Tabelog 摘要        "..."             │
│  [在 Tabelog 查看 →]                   │
└────────────────────────────────────────┘
```

实现：
- 复用现有 `r.ratings.map(...)` 渲染分数
- 在其下方新增条件块 `{r.tabelog && <TabelogCard … />}`，渲染摘要 + 跳转链接
- 链接：`r.tabelog.url`（target="_blank"），无 URL 不显示按钮
- 视觉上用一条 `border-t` 分隔，与 Google 信号清晰区分

非日本店铺：`r.tabelog === null`，整块不渲染，UI 与现状完全一致。

## 6. 风险与回退

| 风险 | 处理 |
|---|---|
| Perplexity 找错店（同名重名） | prompt 强制带 address；返回的 url 必须含 `tabelog.com`，否则丢弃 |
| Perplexity 编造分数 | 摘要里要求"如果未找到 Tabelog 页面则 rating 返回 null"；前端 null → 整块不渲染 |
| 额外延迟 | Tabelog 拉取与 Google 评分排序**并行**，不阻塞主流程；单店超时 12s |
| 成本 | JP 分支 cuisine × 候选数 ~24 次 Perplexity 调用/搜索，可接受；后续可加 KV 持久化缓存 |

## 7. 后续可选（本期不做）

- 把 Tabelog 摘要也喂给 `aiSummary` 合成（让最终总结引用两边评价）
- 同模式扩展 Naver Place（韩国）/ OpenRice（港澳）
- 持久化缓存到 D1/KV，跨 session 复用
