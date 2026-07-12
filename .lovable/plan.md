# 全面切换到 Qwen（DashScope OpenAI 兼容接口）

## 一、结论先讲

**可行**。Qwen 官方 DashScope 提供 OpenAI 兼容端点（`https://dashscope.aliyuncs.com/compatible-mode/v1`），我们现有代码用的就是 `@ai-sdk/openai-compatible`，只需替换 `baseURL + Header + model id`，业务链路 0 改动。

⚠️ **两个例外，Qwen 无法替代**：
1. **Perplexity `sonar / sonar-pro`**（`tabelog.server.ts`、`yelp.server.ts`）——那是**联网搜索**能力，Qwen 没有对等产品。**保留 Perplexity 不动**。
2. **Google Places / ElevenLabs / OpenAI Whisper**（如果有）——那些不是通用 LLM，不受影响。

真正切到 Qwen 的：`echo.functions.ts` 里所有 `gateway("google/gemini-*")` / `gateway("openai/gpt-*")` 调用 + `cuisine-expand.server.ts`。

## 二、需要你做的一步

告诉我 API key 后，我用 `add_secret` 工具打开安全表单让你粘进去，命名 **`QWEN_API_KEY`**。**不要在聊天里直接贴明文**——直接贴的话会被记录在对话历史里。

（如果你只有阿里云 API-KEY 一个字段，就是这个；如果是"AccessKey ID + Secret"那种，那是另一套 IAM 体系不适用，需要去 DashScope 控制台生成 `sk-...` 开头的 API-KEY。）

## 三、模型映射方案

现在的调用 → 换成 Qwen：

| 现调用位置 | 现模型 | 用途 | 换成 Qwen |
| --- | --- | --- | --- |
| `echo.functions.ts:271` semanticClusterMerge | `google/gemini-2.5-flash` | 语义聚类合并 | `qwen-plus` |
| `echo.functions.ts:619` parseRequirements 主路 | `google/gemini-2.5-flash` | 需求解析 | `qwen-plus` |
| `echo.functions.ts:674/800` parseRequirements 兜底 | `openai/gpt-5-mini` | 主路失败后重试 | `qwen-max`（能力最强，兜底用） |
| `echo.functions.ts:2132` Pass-1 核验打分 | `google/gemini-2.5-flash` | 核验 + matchDetails | `qwen-plus` |
| `cuisine-expand.server.ts:42` | `google/gemini-3-flash-preview` | 菜系同义词扩展 | `qwen-turbo`（轻量足够） |
| `tabelog.server.ts:329` | Perplexity `sonar/sonar-pro` | **联网搜索** | **不换，保留** |
| `yelp.server.ts:306` | Perplexity `sonar/sonar-pro` | **联网搜索** | **不换，保留** |

Qwen 模型档次：`qwen-turbo`（最快最便宜）< `qwen-plus`（性价比主力）< `qwen-max`（能力最强）。全部走 OpenAI 兼容端点，参数字段一致。

## 四、代码改动清单

**1. `src/lib/ai-gateway.ts` 重写**

- 新增 `createQwenProvider(qwenApiKey)`：`baseURL = "https://dashscope.aliyuncs.com/compatible-mode/v1"`，`headers = { Authorization: "Bearer " + qwenApiKey }`，`name = "qwen"`。
- 保留 `createLovableAiGatewayProvider`（Perplexity 那两处如果之前也走 Lovable Gateway 可能还要用；否则可删）。

**2. `src/lib/echo.functions.ts`**

- `process.env.LOVABLE_API_KEY` → `process.env.QWEN_API_KEY`（改 2 处：423、1533）。
- 所有 `createLovableAiGatewayProvider(aiKey)` → `createQwenProvider(qwenKey)`。
- 所有 `gateway("google/gemini-2.5-flash")` → `gateway("qwen-plus")`。
- 所有 `gateway("openai/gpt-5-mini")` → `gateway("qwen-max")`。
- 错误信息里的 "AI credentials are not configured" 措辞保持不变。

**3. `src/lib/cuisine-expand.server.ts`**

- 同上，模型 id 换成 `qwen-turbo`。

**4. `src/lib/tabelog.server.ts` / `src/lib/yelp.server.ts`**

- **不动**。Perplexity 是联网搜索能力，Qwen 无对等，且这两个文件本来就直接调 Perplexity 端点。

**5. `.env` 相关**

- 用 `add_secret` 存 `QWEN_API_KEY`。`LOVABLE_API_KEY` 是否删除待定：如果 tabelog/yelp 不依赖它可以留着不管（后端自动配的，删不删都行）。

## 五、切换后需要注意

1. **成本 & 计费换到阿里云**：不再走 Lovable AI 配额，账单去 DashScope 控制台看。
2. **速率限制**：Qwen 默认 QPS 比 Lovable Gateway 低，如果并发高（8 路召回 × N 家候选并行 Pass-1）可能触发 429，需要观察。真出问题就把并发调小 or 加 backoff。
3. **JSON 结构化输出**：现在代码用 `generateText` + `Output.object`（strict json_schema）。**Qwen 的 OpenAI 兼容端点支持 `response_format: json_object`，但 strict json_schema 支持程度不如 OpenAI**。可能触发 schema 校验失败——不过我们本来就有 `NoObjectGeneratedError` 的 fallback 到 `error.text` 手动解析（`ai-sdk-lovable-gateway` 里那套）。上线后跑几条真实用例观察，如果频繁掉到 fallback，就把 `Output.object` 换成"prompt 里描述 JSON + 手动解析"的模式。
4. **中文场景更强**：Qwen 对中文需求解析、评论摘要理论上更好，产品体验可能反而提升。
5. **不需要 Lovable Gateway 的 run-id 头**：切完之后 `X-Lovable-AIG-*` 相关日志功能失效；如果依赖 Lovable Gateway 请求日志排查问题就没了。
6. **回滚成本很低**：`ai-gateway.ts` 里同时保留两个 provider factory，全流程调用点用一个变量指向当前 provider，将来想切回来只改一处。

## 六、实施顺序

1. 你在下一条消息里说"OK"，我调 `add_secret` 让你填 `QWEN_API_KEY`。
2. 拿到 key 后我：
   - 改 `ai-gateway.ts` 加 Qwen provider factory。
   - 替换 `echo.functions.ts` 和 `cuisine-expand.server.ts` 里的 model id 和 env 名。
   - 跑一次冒烟：Tokyo 拉面 → 看解析、召回、Pass-1 是否正常。
3. 观察 24-48 小时；如果 JSON schema fallback 命中率高，再评估是否切到手动解析模式。

## 七、优化还是变差？

**中性偏优化**——取决于你对 Qwen 的偏好。

**优化面**
- 中文场景可能更好，成本走国内计费更透明。
- Qwen-max 兜底比 gpt-5-mini 便宜不少。

**代价面**
- Qwen QPS 上限低，需要观察 429。
- 结构化输出严格度弱于 OpenAI，可能更多依赖 fallback 手动解析。
- 失去 Lovable Gateway 的统一日志/run-id 排查能力。
- Tabelog / Yelp 抓取仍靠 Perplexity，Qwen 替代不了。
