# 修复：谷歌评分要求被显示成"≥5"的 bug

## 现象
用户输入"新宿附近 谷歌评分 4.0 以上"，结果卡片里出现两条并列：
- "新宿附近：Google Maps 实际评分 4.4 / 5；**要求 ≥ 5 分**" ❌ fail
- "谷歌评分 4.0 以上：Google Maps 实际评分 4.4 / 5；要求 ≥ 4 分" ✅ ok

## 根因
`src/lib/echo.functions.ts` 的 `checkGoogleRatingFilter()`（约 1140–1180 行）用正则判断某条 hardFilter 是否为"谷歌评分要求"，判定过宽：

1. 第 1146 行 `mentionsRating` 把裸字 `分`/`星` 也算作评分线索。用户的位置条件文本是"新宿附近 → 地理位置在东京都新宿区或步行/地铁**5分**钟可达范围"，"5分钟"里的 `分` 命中。
2. 第 1150 行阈值正则 `/([1-5](?:\.\d+)?)\s*(?:分|星|\/\s*5)?/` 从整段文本随便抓一个 1–5 的数字，抓到了"5分钟"的 `5`。
3. 于是这条位置约束被当作"评分 ≥ 5"核验，`rating=4.4 < 5` → fail。

不是 LLM 幻觉，parseRequirements 解析出来的 hardFilters 是对的（日志可确认，两条分别是"新宿附近…"和"谷歌评分 4.0 以上…"）。是硬过滤核验步骤的正则误伤。

## 上次查询用到的模型（已切到 Qwen/DashScope 之后）
- parseRequirements: `qwen-plus`，失败 fallback `qwen-max`
- Pass-1 AI 排序/核验: `qwen-plus`
- cuisine-expand: `qwen-turbo`
- Tabelog / Yelp 检索: 仍是 Perplexity `sonar/sonar-pro`（未替换）

## 修复方案（只改 `checkGoogleRatingFilter`）

收紧"是不是评分要求"的判定 + 阈值抽取，避免和"X分钟 / 5号线 / 步行5分钟"这类文本冲突。

1. **门槛判定**：必须同时满足
   - 文本里出现明确的评分词：`评分 / 評分 / 评级 / rating / rated / stars? / score / ⭐` 之一；或出现 `谷歌/Google` + `分|星|/5` 的组合。
   - 单独一个 `分` 或 `星` **不再算**评分线索（"5分钟""五星级酒店"等会误伤）。
2. **阈值抽取**：改为在评分关键词附近就近匹配，例如：
   - `/(?:评分|評分|rating|score|stars?)\s*(?:≥|>=|>|以上|大于|超过|不低于|at\s*least|above|over)?\s*([1-5](?:\.\d+)?)/i`
   - 或先找到 `/5` / `分 / 5` 形式再回抓数字。
   - 只有在成功匹配到评分锚点时才返回阈值；否则返回 `null`（当作"这条不是评分要求"）。
3. **保留** `≤ / < / >` 等比较符方向识别，测试用例覆盖：
   - "谷歌评分 4.0 以上" → ≥ 4
   - "Google rating above 4.5" → > 4.5
   - "地铁 5 分钟可达" → 判为非评分（返回 null）
   - "步行 3 分钟" → 非评分
   - "评分不低于 4" → ≥ 4

## 涉及文件
- `src/lib/echo.functions.ts`：只改 `checkGoogleRatingFilter()`（约 1140–1181 行），其它逻辑不动。

## 验证
- 复跑同一 query（Tokyo + "想吃 butadon 新宿附近 谷歌评分 4.0 以上"），结果里应只剩一条评分核验："谷歌评分 4.0 以上 …要求 ≥ 4 分"，位置那条不再被显示为评分 fail。
- 位置类硬条件目前没有确定性核验器，会走 LLM 的 `matchDetails`（Pass-1），符合现有设计。
