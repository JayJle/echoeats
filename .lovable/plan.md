## 目标
解决截图中“排除”区域出现重复需求标签的问题，例如“不要烤肉店烧烤店 → 料理类型不包含烧烤店”被展示两次。

## 发现的问题
- 后端提示词已经要求“同一条只放一个数组里”，但 AI 输出仍可能重复。
- 当前解析后只做了 softPreferences → hardFilters 的提升，没有统一做数组内/数组间去重。
- 前端 results 页面直接 map 展示 parsed.hardFilters / softPreferences / negativeFilters / dishPreferences，因此后端一旦返回重复，UI 就会重复显示。

## 修复计划
1. **在需求结构化解析后增加确定性去重**
   - 对 hardFilters、softPreferences、negativeFilters、dishPreferences 做规范化去重。
   - 规范化会忽略空格、箭头、标点差异，降低“同义重复”漏判。

2. **保留优先级，避免误删重要需求**
   - negativeFilters 优先于 hardFilters / softPreferences。
   - hardFilters 优先于 softPreferences。
   - dishPreferences 只保留菜品偏好，不影响硬条件里“必须有某菜”的校验。

3. **修正提升逻辑带来的重复**
   - softPreferences 被提升到 hardFilters 后，统一走去重，避免同一需求同时出现在硬条件和偏好里。

4. **前端加轻量兜底去重**
   - results 展示前再按文本规范化去重一次，防止旧 sessionStorage 数据或异常返回继续重复展示。

5. **验证场景**
   - 使用截图中的输入场景确认：排除标签只显示一次。
   - 确认“必须有 ribeye 牛排”仍可同时作为硬条件和菜品偏好展示，这是当前产品规则允许的，不属于截图里的重复 bug。