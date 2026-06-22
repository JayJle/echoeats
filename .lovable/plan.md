# Perplexity 采 evidence → DeepSeek 一站式排序 + 字段提取

## 思路调整（vs 上一版）

上一版有三段：Perplexity 采 evidence → DeepSeek 结构化 → Gemini 排序。
本版砍掉中间一步：**Perplexity 只采 evidence；DeepSeek 同时做字段提取 + 排序 + 筛选**，把现在的 ranking 模型（`google/gemini-2.5-flash`）整体替换掉。

收益：
- 排序模型看到的是评论/价位/招牌菜原话，而不是被 60-80 字 summary 压扁的二手信息，判断更准（尤其 hard/soft filter 命中）
- Perplexity 端 ~50% token 节省（不再生成 json_schema 业务字段）
- 少一次 DeepSeek 调用 + 少一轮序列化/反序列化延迟
- summary/rating/price 由 DeepSeek 在排序时"顺手"产出，写进 pick 的 `displayFields`，UI 不变

## 改动范围

- `src/lib/yelp.server.ts`：Stage 1/2 只采 evidence，不再产 `YelpInfo`
- `src/lib/tabelog.server.ts`：同上
- `src/lib/echo.functions.ts`：AI-rank 阶段把 `tabelog/yelp.summary` 改成 `tabelog/yelp.evidence`，模型从 `gemini-2.5-flash` 换成 `deepseek-chat`，Output schema 扩展 `displayFields`

Stage 0 多变体 preSearch 完全不动。

## 数据契约

### Perplexity evidence 包（Yelp / Tabelog 通用）

```json
{
  "url": "https://www.yelp.com/biz/...",
  "matchEvidence":  ["店名 + 地址原文 ≤120c", "..."],   // 2-3 条
  "fieldEvidence":  ["rating 行原文", "review count 原文", "price 行原文"], // 3-5 条
  "reviewEvidence": ["评论原话 ≤120c", "..."],          // 6-8 条
  "pageSignals":    ["营业时间/电话/品类 tag/招牌菜"]    // 3-5 条
}
```

每条 80-120 字符，整包 500-900 tokens。URL 核验（`matchEvidence` 必须含店名 + 地址）仍由 Perplexity 在 prompt 里强制。

### 缓存层返回值

`fetchYelpInfo` / `fetchTabelogInfo` 的返回类型从 `YelpInfo` / `TabelogInfo` 改成：

```ts
type SourceEvidence = {
  url: string;
  confidence: "high" | "medium" | "low";
  matchEvidence: string[];
  fieldEvidence: string[];
  reviewEvidence: string[];
  pageSignals: string[];
} | null;
```

缓存键、TTL（POS 24h / NEG 30min）、core verifyMode 流程都保留。

### AI-rank 输入候选项

```ts
{
  placeId, name, address, rating(google), userRatingCount,
  priceLevel(google), priceFromReviews,
  editorialSummary, realWorldReviews,
  tabelog: { url, evidence: SourceEvidence } | null,
  yelp:    { url, evidence: SourceEvidence } | null,
}
```

去掉旧的 `tabelog.summary / rating / reviewCount / priceRange/priceJPY` 和 `yelp.summary / rating / reviewCount / priceLevel`。

### AI-rank 输出 pick（每条新增 displayFields）

```ts
{
  placeId, cuisine, reasoning, matchScore, ...现有字段,
  displayFields: {
    yelp:    { rating, reviewCount, priceLevel, summary } | null,
    tabelog: { rating, reviewCount, priceRange, summary } | null,
  }
}
```

UI 拿 `displayFields` 替换原本读 `tabelog/yelp` 的位置，渲染保持不变。`priceJPY` 由后处理用现有 `parsePriceJPY(displayFields.tabelog.priceRange)` 算出，不让模型算数字。

## DeepSeek 接入

- Endpoint：`https://api.deepseek.com/chat/completions`（OpenAI 兼容）
- 模型：`deepseek-chat`，`temperature: 0`，`response_format: { type: "json_object" }`
- secret：`DEEPSEEK_API_KEY`（不在 Lovable AI Gateway，调 `add_secret` 让用户填）
- 在 `src/lib/ai-gateway.ts` 旁加 `deepseek-gateway.server.ts` 暴露 provider helper
- 超时 30s，失败回退到 `google/gemini-2.5-flash`（保留旧逻辑，回退时把 evidence 拼成简化 summary 再喂）

## Prompt 关键约束

- 字段提取部分：rating / reviewCount / priceLevel 必须能在 `fieldEvidence` 找到字面值；找不到 → null，禁止编造
- summary：必须从 `reviewEvidence` 归纳（中文 ≤60 字 / 英文 ≤80 字），无 reviewEvidence → null
- 排序部分：现有的 hard/soft filter 规则、weight、排序解释完全照搬，提示词加一句"判断时优先看 evidence 原文"
- pick 数量、分组、batch 切分（`AI_BATCH_SIZE`）保持现状

## 改动步骤

1. `yelp.server.ts` / `tabelog.server.ts`
   - Stage 1/2 prompt 改为输出 evidence 包；`response_format` schema 同步
   - 删除 `parseStage` 业务字段解析；只留 url + evidence 解析与核验
   - 导出类型改名为 `YelpEvidence` / `TabelogEvidence`
2. `src/lib/deepseek.server.ts`（新建）
   - 调用 helper + 错误处理 + token 用量日志
3. `echo.functions.ts`
   - 修改 `candidates.map`，把 evidence 透传给模型
   - 把 ranking 模型从 gateway gemini 换成 deepseek client
   - 扩展 Output schema 加 `displayFields`
   - 后处理：用 displayFields 填回原来下游需要的 yelp/tabelog 字段，跑 `parsePriceJPY`
4. UI 读取层（仅在字段路径变了的地方）
   - 把读 `candidate.yelp.rating` 这种地方改成读 `pick.displayFields.yelp.rating`
   - 如果原结构在多处使用，做一层 adapter 集中转换，少改文件
5. Secret：`add_secret(["DEEPSEEK_API_KEY"])`

## 风险与校验

- DeepSeek JSON 偶发解析失败：保留 fallback to Gemini；fallback 时把 evidence 拼成纯文本 summary 给 Gemini，UI 仍能渲染
- DeepSeek 延迟比 gemini-flash 略高（首 token ~1s）：排序本来就不是首屏关键路径，可接受
- evidence 直传增加 ranking prompt 体积：粗算每候选 +500 tokens，单 batch 8 家 = +4K tokens，DeepSeek 上下文 64K 内无压力；输入单价 ~$0.27/M，整体成本仍降
- 上线前：找 2 条真实 query（一条 JP、一条 US）跑 A/B，比对 picks 顺序 + summary 质量 + Perplexity 用量

## 不变的部分

- Stage 0 多变体 preSearch、`scoreCandidates`、`extractStreetTokens`
- 缓存 TTL 与命中策略
- AI-rank 的 batch 切分、hard/soft/negative filter 规则
- Tabelog `parsePriceJPY` 数字解析
- 现有 UI 卡片渲染（只换字段读取路径）
