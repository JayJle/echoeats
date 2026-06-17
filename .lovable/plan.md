# 模型选型方案（基于当前代码实测）

本方案不改动任何业务代码，只更新 `.lovable/plan.md` 中"模型选型"小节，把内容收敛到代码里**真实在跑**的模型，区别于"仅供未来评估的备选项"。

---

## 来源核对

| 节点 | 源文件 | 行号 | 实际模型 |
|---|---|---|---|
| 语音转写 | `src/routes/api/transcribe.ts` | L67 | `scribe_v2`（ElevenLabs，batch、`tag_audio_events=false`、`diarize=false`） |
| 结构化解析（首轮） | `src/lib/echo.functions.ts` | L488 | `google/gemini-2.5-flash` |
| 结构化解析（跨厂兜底 / forceInfer 重试） | `src/lib/echo.functions.ts` | L493、L418 | `openai/gpt-5-mini` |
| AI 排序 | `src/lib/echo.functions.ts` | L1476、L1646 | `google/gemini-2.5-flash`（raw + slim 同模型重试） |

> 之前误写的 `gemini-2.5-flash-lite`、`gemini-3-flash-preview` 在代码里均未接入，本次从"在跑模型"里删掉，仅保留在"未来可选"。

---

## 节点 1 · 语音转写（`/api/transcribe`）

**关键指标**：中英混合识别准确率（主） + 单位时长成本（次）。当前交互是"录完再传"，不需要边说边出字，所以延迟不是决策因素。

| 模型 | 角色 | 准确率 | 中英混合 | 延迟 | 成本 | 选/不选的理由 |
|---|---|---|---|---|---|---|
| **ElevenLabs `scribe_v2`** | ✅ 当前在用 | 高 | 支持 | 秒级 | $0.15–0.30/小时 | 录完再传场景的成本/质量最优；与现有代码完全吻合 |
| ElevenLabs `scribe_v2_realtime` | ❌ 未来可选 | 中高 | 支持 | 毫秒级 | $0.40–0.80/小时 | 当前不做边说边出字，多花 2–3× 成本无收益 |
| OpenAI Whisper API | 🟡 未来可选（成本兜底） | 高 | 支持 | 秒级 | $0.36/小时 | 同为"录完再传"模型，未来若 ElevenLabs 涨价或额度受限可平移 |
| 浏览器 Web Speech API | 🟡 未来可选（可用性兜底） | 中 | 差，需手动切 `lang` | 毫秒级 | 免费 | 仅 Chrome/Edge；未来在 `ELEVENLABS_API_KEY` 缺失或 503 时提示用户降级使用 |

**当前代码兜底行为**：`src/routes/api/transcribe.ts` L85–L98 只做单次 retry + 上游错误码透传（429/402/500/503），**没有跨模型 fallback**。Whisper / Web Speech 都还没接入。

---

## 节点 2 · 结构化解析（`parseRequirements`）

**关键指标**：Schema 可靠性 + 证据保真度（主） + 单位 token 成本（次）。3–8s 延迟在搜索 loading 内可吸收，不作为决策因素。

| 模型 | 角色 | Schema 可靠性 | 中英混合 | 成本（输入/输出，每 1M token） | 选/不选的理由 |
|---|---|---|---|---|---|
| **`google/gemini-2.5-flash`** | ✅ 首轮主模型（L488、L1476） | 高 | 好 | $0.30 / $2.50 | 与 `Output.object({ schema: LooseParsedSchema })`、`maxOutputTokens: 8000` 兼容良好；AI 排序也用同一模型保持一致 |
| **`openai/gpt-5-mini`** | ✅ 跨厂兜底 + `forceInfer` 重试（L493、L418） | 高 | 好 | $0.25 / $2.00 | 与首轮跨厂商，规避同时段单家 429/5xx；`forceInfer=true` 修复"用户要求 AI 推断但返回兜底词（餐厅/Restaurants）"的情况 |
| `google/gemini-2.5-pro` | ❌ 未来可选 | 高 | 好 | ~4–5× flash 成本 | 节点复杂度撑不起该价位；留给"高级搜索"等未来场景 |
| `google/gemini-3-flash-preview` | 🟡 观察中，未来可选 | 待验证（注释 L1474 明确说当前 Gateway 下**不支持** JSON Schema responseFormat） | 好 | 待定 | Schema 兼容前不能进主链；待 Gateway 支持后再评估 |
| `google/gemini-2.5-flash-lite` | ❌ 未来可选 | 偏弱，易丢字段 | 一般 | 更便宜 | 字段缺失会污染下游硬过滤，省下的成本不抵召回损失；本次从对比中删除 |

**当前代码兜底行为（L408–L425、L487–L495）**：
1. 首轮 `gemini-2.5-flash`
2. 失败 / schema 解析失败 → `gpt-5-mini`
3. 用户勾选"AI 推断品类"但首轮返回兜底词（`餐厅` / `Restaurants`）→ `gpt-5-mini` 带 `forceInfer=true` 再跑一次
4. 两轮都失败 → 降级返回最小结构 `{city, cuisines, dateTime, country, language, visitTime, uiLanguage}` + `degraded=true`

---

## 切换/不切换的硬规则

- ❌ **不因延迟切换**：转写不上 realtime、解析不下放 flash-lite。
- ❌ **不因"想更强"切换**：解析不升 2.5-pro，除非未来出现明确质量不足的 case。
- ✅ **因可靠性切换**：首轮 schema/网络失败 → 跨厂 `gpt-5-mini`。
- ✅ **因语义保真切换**：`forceInfer` 触发 → `gpt-5-mini` 重试。
- ✅ **未来兼容性切换**：等 `gemini-3-flash-preview` 在 Gateway 支持 JSON Schema 后，再考虑替换 2.5-flash。

---

## 落地动作（plan，仅文档）

1. 改写 `.lovable/plan.md` 中"语音转写节点 · 模型选型"段：候选只列上表 4 个，明确"在跑"= `scribe_v2`，其余标"未来可选"。
2. 改写"结构化解析节点 · 模型选型"段：候选只列上表 5 个，明确"在跑"= `gemini-2.5-flash` + `gpt-5-mini`，flash-lite 从对比表移到"未来可选/不推荐"。
3. 末尾追加"切换/不切换的硬规则"小节（即本文档第 3 节）。
4. **不改动 `src/routes/api/transcribe.ts`、`src/lib/echo.functions.ts`、`src/lib/ai-gateway.ts` 任何一行代码。**

确认后我进入 build 模式只动 `.lovable/plan.md` 一个文件。
