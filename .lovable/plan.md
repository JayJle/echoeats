我查了代码和可用日志，结论如下：

## 现在代码里已有的去重机制

1. **解析后会做一次服务端去重**
   - 位置：`src/lib/echo.functions.ts` 的 `dedupeParsedConditions()`。
   - 规则：
     - `negativeFilters` 内部先去重。
     - `hardFilters` 内部去重，并且如果和 negative 相同就移除。
     - `softPreferences` 内部去重，并且如果和 negative / hard 相同就移除。
     - `dishPreferences` 也会去重。

2. **前端展示又做了一层显示去重**
   - 位置：`src/routes/results.tsx` 的 `uniqueDisplayItems()`。
   - 只影响顶部标签展示，不改变后端真实 parsed 数据。

3. **prompt 里也有文字规则**
   - `边界与去重` 写了：
     - 否定句只进 `negativeFilters`。
     - 同一条只放一个数组里，不要重复。
     - 但又有一个例外：具体菜品名可以同时进 `dishPreferences`，如果是“必须有蟹刺身”，也可以同时进 `hardFilters`。

## 为什么现在仍然会失效

主要不是“完全没去重”，而是当前 key 太弱：

- `conditionKey()` 只取 `→` 左边的“原话片段”来做 key。
- 所以这类语义相同但原话片段不同的条件不会被识别为重复：
  - `菜品精致 → 菜品摆盘精致`
  - `精致的菜品 → 菜品/摆盘精致`
  - `摆盘精致 → 菜品精致`
- 跨区域也是一样：如果 hard 里是 `菜品精致`，soft 里是 `摆盘精致`，现在的 key 不一定相等，所以 soft 不会被移除。
- 另外代码里有一段“weight >= 0.8 的 soft 自动提升到 hard”，提升后才去重；如果模型把近义项分别写成不同文本，也会留下重复。

## 关于“上一次查询日志”

我查了当前可访问的最近服务端日志：
- 能看到最近一次 ranking 阶段日志，例如 `西式早午餐 fuzzy=8/8 reran...`、fallback 失败/成功等。
- 但目前日志里没有打印 `parsed.hardFilters / softPreferences` 的完整内容，所以无法从日志直接还原你上一次顶部三个重复偏好的原始数组。
- 这也说明后续需要加一条安全的解析摘要日志，方便定位类似问题。

## 修复计划

1. **升级语义去重 key**
   - 不再只看 `→` 左边。
   - 同时看原话片段和标准化条件全文。
   - 做同义归一：例如 `菜品精致 / 摆盘精致 / 出品精致 / 精致菜品 / 精美` 归并成同一个主题 key。

2. **强制单一区域归属**
   - 优先级：`negativeFilters > hardFilters > softPreferences`。
   - 同一语义主题如果已经在 hard，就从 soft 删除。
   - 同一语义主题如果已经在 negative，就从 hard / soft 删除。

3. **保留合理例外**
   - `dishPreferences` 仍然允许和 hard 共存，因为代码和 prompt 已明确支持“必须有某菜品 = dish + hard”。
   - 但“菜品精致”这种不是具体菜品名，不应作为 dish 例外。

4. **补一条解析摘要日志**
   - 在 `parseRequirements` 返回前打印数量和文本摘要：hard / soft / negative / dish。
   - 这样下次你说“看上次 log”，就能直接看到顶部偏好为什么重复。

5. **本地验证**
   - 用几组容易重复的输入测试：
     - `菜品精致，摆盘要精美，出品精致一点`
     - `必须菜品精致，希望摆盘精致`
     - `不要游客店，不要 tourist trap`
   - 预期：同义重复只保留一条；硬条件和偏好不跨区重复。

如果你确认，我下一步就按这个计划改代码。