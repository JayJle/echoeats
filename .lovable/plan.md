## 目标

解决同一家餐厅、同一条件、两次查询结果不一致的问题（例："精美"上次匹配、下次不匹配）。

## 方案 A：降温

在 `src/lib/echo.functions.ts` 中所有 `generateText` 调用（主调用 + raw 兜底 + slim 兜底）加上 `temperature: 0`。

涉及位置（L1769、L1789、L1813 三处 `generateText`）。

效果：同输入下绝大多数情况输出一致，免费拿掉主要抖动源。

## 方案 C：只复跑"模糊地带"，OR-合并

在 `rankOneGroup` 拿到第一遍结果后，对每个候选 pick 判断是否"模糊"：

判定为模糊（任一条满足即触发该候选复跑）：
- 任一 `hardFilterChecks[i].status === "unknown"`
- 任一 `matchDetails[i].status === "unknown"`
- 任一 `hardFilterChecks[i]` 或 `matchDetails[i]` 的 `confidence` 落在 60–78 区间（无论 status 是 ok 还是 fail）

对所有模糊候选**打包成一个 mini-batch**，用同一 prompt 再跑一次（temperature=0 下，prompt 里加一句 "请再次独立核验，特别关注证据是否充分"，避免被 KV 缓存命中变成完全 copy）。

合并规则（按条件下标对齐）：
- `status`：`ok` 优先于 `unknown` 优先于 `fail`（即任一次为 ok 就算 ok；都没 ok 但有 unknown 就算 unknown；两次都 fail 才算 fail）
- `confidence`：取两次中较高者
- `note` / `label`：取 status 胜出那次的文本
- `matchScore`：取两次较高者
- `aiSummary` / `pros` / `cons` / `verificationStatus`：取第二次（更新版本），但若第二次空则保留第一次

不模糊的候选直接用第一次结果，不复跑。

## 预期成本

- A：0 额外开销
- C：实测大概 20–40% 的候选会进入"模糊"复跑，所以总 AI 调用量增加 ~25%（远小于全量双跑的 ×2）

## 技术细节

1. **temperature=0**：三处 `generateText` 调用各加一个参数；同时给 raw / slim 兜底也加。
2. **复跑函数**：新增内部辅助 `rerankFuzzyPicks(group, fuzzyCandidates) → picks[]`，复用 `buildPromptForGroup` 但只塞模糊候选 + 在 prompt 末尾追加"独立复核"提示。
3. **合并函数**：新增 `mergePicks(first, second) → merged`，按上述规则逐字段合并。
4. **日志**：打印 `[Echo/AI-rank] "{cuisine}" fuzzy={n}/{total} reran in {ms}ms`，便于观察实际复跑比例。
5. **不动**：打分公式、admitted、排序、缓存键、并发限制（8）、超时（与现在一致）。

## 不在本次范围

- Tabelog/Yelp 那边的查询数量裁剪（之前确认暂不动）
- pros/cons 文本本身的稳定性（用户没提，且 pros/cons 与匹配判定解耦）

## 验证

实现后让你拿同一组需求在 preview 上连查 2–3 次，对比"精美 / 适合约会"等抖动过的条件，看是否稳定。
