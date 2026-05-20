## 根因

10:00-10:02 那次东京中餐搜索的服务端日志：

```
[10:00:58] [Tabelog] hit 43/43
[10:00:58] sending 25 candidates across 1 cuisine(s) to model
[10:01:22] [warn] "restaurants" Output.object failed (No output generated.), retrying raw…
[10:02:04] [error] "restaurants" failed: truncated (finishReason=length)
[10:02:04] all 1 group(s) done in 65809ms
```

**完全不是 Yelp 的问题**（那次是 JP，Yelp 分支根本没跑）。是 **AI 排序阶段两次都失败**：

1. **第一次（Output.object，~24s）**：Gemini 2.5-flash 在带结构化 schema 的调用上偶发返回 `No output generated`。这是 AI SDK 日志里反复出现的 `responseFormat is not supported. JSON response format schema is only supported with structuredOutputs` 警告的运行时表现 —— 当输入很大（25 个候选 × 每个带 `realWorldReviews` + `tabelog.summary` + `editorialSummary`）时这个失败概率显著升高。
2. **第二次（raw 兜底，~42s）**：用 `maxOutputTokens: 6000` 跑纯文本，模型先生成了一大段思考/解释文字才到 JSON，**6000 不够，被截断**，触发 `finishReason=length` → 抛错 → 返回空 `picks: []`。

整个组返回 0 家餐厅 → 前端看到的就是「没结果」。

`echo.functions.ts:1328`、`echo.functions.ts:1350` 两处都写死 `maxOutputTokens: 6000`。Gemini 2.5-flash 上下文 65k，6000 是非常保守的设置，对带 tabelog 数据的大输入完全不够用。

---

## 修改方案

只动 `src/lib/echo.functions.ts` 的 `rankOneGroup`，不动其它任何文件。

### 改动 1：主调用 maxOutputTokens 6000 → 12000

`Output.object` 模式下也存在被截断的风险（虽然这次是 "No output generated" 而非截断），加大上限零成本。

### 改动 2：raw 兜底 maxOutputTokens 6000 → 20000

raw 模式没有 schema 约束，模型很可能先吐 reasoning 再吐 JSON，必须给足头部空间。20000 仍远低于 2.5-flash 输出上限。

### 改动 3：raw 兜底加一道"先 JSON 再说话"的强约束

在 raw 兜底的 prompt 追加：

```
**输出格式硬约束**：第一个字符必须是 "{"，最后一个字符必须是 "}"。
不要任何前置说明、不要 markdown、不要 ```、不要"以下是"之类的开场。
picks 数组**最多 8 条**，每条的 aiSummary ≤ 80 字、pros/cons 各 ≤ 3 条。
```

这降低被截断概率、也降低 raw 解析失败概率。

### 改动 4：截断时再做一次极简重试（可选，本次包含）

`finishReason=length` 时不直接抛错，而是把 prompt 中所有候选的 `realWorldReviews` 字段砍掉、`tabelog.summary` 截到 30 字，再用 20000 tokens 跑一次。这是最后的兜底，保证「有 Tabelog 数据」≠「AI 输出爆掉」。

---

## 不动的部分

- Yelp 抓取层（上轮已优化的 `yelp.server.ts`）
- Tabelog 抓取层
- 候选构造、UI、i18n、store
- AI 模型选择、温度、其它参数
- 不新增 secret、不动数据库

---

## 预期效果与回退

- **预期**：65 秒返回空结果的失败模式被消除，~95% 情况下首轮 Output.object 直接成功；剩余 5% 走 raw 兜底也能在 20k tokens 内出完整 JSON；极少数仍截断则走改动 4 的极简重试。
- **代价**：上限提高不影响实际计费（按实际输出 token 计费），最坏情况单次耗时多 5-10 秒。
- **回退**：纯参数调整，回滚两个数字即可。
