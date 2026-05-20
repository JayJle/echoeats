## 发现的问题

上一轮查询其实已经发起了 Yelp / TripAdvisor 平台查询，但日志显示大部分被丢弃：

- Yelp 多数返回 `no whitelisted citations (got 0 raw)`，也就是 API 没给出可校验引用，所以当前安全校验把它丢掉。
- TripAdvisor 有些返回 `empty highlights & complaints`，即平台页可能查到但没提取出可用评价摘要。
- 即使查到了，最终 AI 排序提示里的 `pros/cons.source` 允许来源只包含 Google / Tabelog / 中文平台 / 综合，不包含 Yelp / TripAdvisor，因此展示层也容易看起来“只有 Google”。
- 前端来源条目前只支持 Yelp，不支持 TripAdvisor badge；评分区也不会显示“已使用 Yelp/TripAdvisor 口碑”。

## 修改方案

### 1. 放宽“必须有 citation 才使用”的策略，但保留安全边界

对 Yelp / TripAdvisor 平台查询改成两档结果：

- **强证据**：有白名单 citation，继续按现在逻辑使用。
- **平台限定弱证据**：API 没返回 citation，但本次请求已经通过 `search_domain_filter` 强制只查该平台域名；如果 JSON 明确返回该平台来源、且有非空评价摘要，则允许作为该平台补充口碑使用。

同时会保留以下防幻觉限制：

- 每个平台仍单独锁域查询。
- 店名 + 城市 + 地址必须精确匹配。
- 摘要为空继续丢弃。
- 不允许把 Google 内容伪装成 Yelp/TripAdvisor。
- 增加日志区分 `verified citation` 和 `domain-filter fallback`，方便后续排查。

### 2. 让最终 AI 排序真正允许 Yelp / TripAdvisor 来源

更新排序 prompt 中的来源规则：

- `pros/cons.source` 允许：Google / Yelp / TripAdvisor / Tabelog / 大众点评 / 小红书 / 美团 / 综合。
- 要求 source 必须来自 `realWorldReviews.sources`，避免凭空标来源。
- `aiSummary` 如果使用了 Yelp / TripAdvisor / Tabelog，也要能自然说明“综合 Yelp / TripAdvisor 等网友评价”。

### 3. 让前端能显示 TripAdvisor，并更清楚显示平台来源

更新结果页来源条和评分区：

- `DataSourcesStrip` 增加 TripAdvisor badge。
- 识别 TripAdvisor 链接并显示可点击来源。
- `candidateRatings` 对海外结果增加“Yelp / TripAdvisor 口碑”行：没有平台分数时不伪造评分，只显示“已纳入口碑”或类似文案，表示该平台评价被用于摘要/匹配。
- Yelp / TripAdvisor 搜索链接继续保留，便于用户手动核验。

### 4. 不改变永不超时结构

保持现有结构：

- 每个平台查询独立 20 秒 abort。
- Yelp / TripAdvisor / Tabelog 并行执行。
- 外层仍按完成顺序持续 `yield review-progress`。
- 单个平台失败不会阻塞其它平台，也不会阻塞整次搜索。

## 技术小白版

现在不是“完全没查别的平台”，而是系统查了 Yelp / TripAdvisor，但因为它们没有给出足够标准的“引用凭证”，我们的安全门槛把它们很多都扔掉了；并且最后展示结果的地方也没完整支持 TripAdvisor，所以用户看到就像只有 Google。

我会把规则改成：

- 能拿到明确引用时，当然优先用。
- 如果没有引用，但这次查询本身已经被限制在 Yelp 或 TripAdvisor 网站里，并且确实拿到了评价摘要，也允许作为补充参考。
- 最后页面上会明确标出 Yelp / TripAdvisor，避免明明用了但用户看不出来。

## 预期效果

- 同样的海外搜索，结果中更容易出现 Yelp / TripAdvisor 的高频好评、差评和来源标记。
- Google 有结果时，也会继续并行查更多平台。
- 如果 Yelp/TripAdvisor 对某家店确实没数据，则不会硬编。
- 用户会更明显看到“这是综合 Google + Yelp/TripAdvisor 得出的结果”。

## 用户视角中的效果

- 搜索结果卡片里，`高频好评 / 高频差评` 后面的来源可能出现 `Yelp`、`TripAdvisor`。
- 来源条里除了 Google，还会看到 Yelp / TripAdvisor 的标识或链接。
- 推荐理由会更像“综合多平台口碑”，而不是只基于 Google。

## 可能存在的负面效果

- 因为允许“平台限定但无 citation”的弱证据，理论上可信度比“有明确引用链接”的强证据低一点。
- 某些小店在 Yelp/TripAdvisor 内容很少，可能仍然只显示 Google。
- Yelp/TripAdvisor 搜索结果有时会匹配到同名不同店，所以仍需严格保留店名/地址匹配要求，宁可少用，不乱用。

## 成本变化

- 外部 API 调用次数不增加：仍然是当前的 Yelp + TripAdvisor 并行查询策略。
- 金钱成本基本不变。
- 展示和合并逻辑会略微复杂，但可维护性仍可控。
- 查询耗时不会显著增加；仍保持并行和独立超时。