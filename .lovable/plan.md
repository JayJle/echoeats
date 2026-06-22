## 改动目标

把 `src/lib/yelp.server.ts` 的 `preSearchYelp` 从 4 个变体砍到 2 个，降低 Perplexity `/search` 调用量约 50%。

## 具体改动（单文件）

**文件**：`src/lib/yelp.server.ts`，函数 `preSearchYelp`（约 L197-247）

**保留**：
- `name+city`：`"${name}" ${city} site:yelp.com`
- `name+area+city+cuisine`：`"${name}" ${area} ${city} ${cuisine} site:yelp.com`（仅 cuisine 非空）

**删除**：
- `name+street` 变体（依赖 `extractStreetTokens`）
- `name-only` 兜底（前 N 个变体全部 0 命中时的二次 `/search`）

### 调用量变化（单店 Yelp 部分）

| 场景 | 改动前 | 改动后 |
|---|---|---|
| 有 cuisine | 3 变体 + 可能 1 兜底 = 3-4 | **2 变体** |
| 无 cuisine | 2 变体 + 可能 1 兜底 = 2-3 | **1 变体** |

整体 Yelp `/search` 调用量约降 **40-50%**。

## 不动的部分

- `scoreCandidates` / 打分逻辑 / 多 batch 重复加分 — 不变
- `sonar` / `sonar-pro` 两阶段 — 不变
- 缓存 TTL — 不变
- Tabelog 多变体 — 不变（你只要求改 Yelp）
- `extractStreetTokens` 函数本身保留（无其它调用方也可保留，不主动删，避免误伤）

## 副作用 & 风险

- **召回率轻微下降**：少数街道关键词比店名更独特的店（如同名连锁），可能从原来"靠 street 变体命中"变成"两变体都打不到 → no candidates → 跳过 Yelp"。预计影响 < 5% 的 Yelp 命中率。
- 无 cuisine 字段的店退化为单变体，命中率下降更明显；但目前 echo 流绝大多数店都有 cuisine。

## 验证

改完跑一次新查询，看 worker 日志：
- `[Yelp/search] xxx: top=... (N candidates, 1-2 variants)` 应该只看到 1 或 2 个 variant
- `no candidates` 比例不应明显上升（前提：Perplexity 401 已修好）