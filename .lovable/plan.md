## 目标
让日本城市的搜索结果更稳定地显示 Tabelog 信息，并参考上一次查询暴露的问题：结果页里 Tabelog 区块完全缺失。

## 发现的问题
1. **日本城市识别不完整**
   - `isJapaneseCity()` 包含 `札幌 / 横滨 / 名古屋 / 福冈`。
   - 但真正触发 Tabelog 抓取的 `guessRegionCode()` 只识别 `tokyo / kyoto / osaka / 东京 / 京都 / 大阪 / 日本 / japan`。
   - 所以如果上一次查的是札幌、横滨、名古屋、福冈等，日本分支不会进入，Tabelog 根本不会被查询。

2. **Tabelog 查询只查每组 Google 评分前 8 家**
   - 最终 AI 可能选出第 9 名之后的候选。
   - 这些候选即使是日本店，也没有 Tabelog 查询机会，结果页自然没有 Tabelog 信息。

3. **Tabelog 匹配过严导致全丢弃**
   - 当前必须拿到 `tabelog.com` URL，且 `rating` 或 `summary` 至少一个非空。
   - 如果 Perplexity 找到了页面但没返回评分/摘要，或返回的是移动页/变体 URL，当前逻辑会直接丢掉。

## 修改计划
1. **补全日本城市/区域识别**
   - 更新 `guessRegionCode()`，加入 `sapporo / 札幌 / yokohama / 横滨 / 横浜 / nagoya / 名古屋 / fukuoka / 福冈 / 福岡 / kobe / 神户 / 神戸 / nara / 奈良 / hiroshima / 广岛 / 広島` 等常见日本城市。
   - 让这些城市都返回 `JP`，从而触发 Tabelog 补充流程。

2. **扩大 Tabelog 补充覆盖面**
   - 从每组前 8 家扩大到前 15 家，或覆盖进入 AI ranking 输入的主要候选。
   - 目标是让最终展示的店更大概率已查询过 Tabelog。
   - 控制并发/数量，避免请求过多导致变慢。

3. **放宽 Tabelog 有效结果条件，但不编造数据**
   - 只要有可信 `tabelog.com` 店铺 URL，就保留 `tabelog` 对象。
   - `rating / reviewCount / priceRange / summary` 可以为空。
   - 前端会显示“在 Tabelog 查看”，即使评分暂时无数据，也能让用户打开核验。

4. **增强查询提示词**
   - 在 Tabelog 查询 prompt 里加入 Google Maps 地址和城市，要求优先匹配同地址/同区域。
   - 明确允许“只找到店铺 URL，但评分不可见”的情况返回 URL，不要整条返回 null。

5. **验证**
   - 用一个日本城市样例重新搜索，检查结果对象里是否出现 `tabelog`。
   - 查看服务端日志里 `[Tabelog]` 是否从大量 null 变为至少有 URL/评分命中。

## 不做的事
- 不把反馈用于推荐排序。
- 不新增后台看板。
- 不把 Tabelog 分数和 Google 分数混合成一个总分。