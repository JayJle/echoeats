确认到问题点在 `/results` 的“应用并重新搜索”：它会把重新解析出的 `newParsed` 直接覆盖旧 `parsed`。一旦这次解析返回空条件，页面就只剩“未制定/无条件”的状态。

计划：

1. 改成“保护式合并”
   - 重新解析后不再整体覆盖旧条件。
   - `hardFilters / softPreferences / negativeFilters / dishPreferences` 按文本去重合并。
   - 旧条件默认保留，新解析出的新增条件追加进去。

2. 保护关键字段
   - `city / cuisines / dateTime / visitTime` 如果新解析为空或明显无效，继续使用旧值。
   - `mode` 保持原搜索模式。

3. 增加空解析兜底
   - 如果新解析出的条件总数为 0，但旧条件不为 0，则不允许覆盖旧条件。
   - 这种情况下仍用“旧条件 + 新原文”重新搜索，避免条件全部消失。

4. 调整应用流程
   - `setFreeText(text)` 仍保存用户最新输入。
   - `setParsed(merged)` 只写入合并后的安全结果。
   - 搜索也使用同一个 `merged`，保证 UI 展示和实际搜索条件一致。

不改动：
- 不改后端解析 prompt。
- 不改搜索抓取逻辑。
- 不改页面设计和路由。