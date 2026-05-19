## 问题

英文版结果页仍残留中文：

1. **Pros / Cons** 直接保留原始中文短语（如 "高峰期可能要等位"、"氛围复古有特色"），再附英文翻译。说明 AI 没严格遵守 langDirective —— 它把原文当"引用证据"塞进去了。
2. **链接按钮**："官网"、"Google 搜索"、"大众点评"、"小红书"、"大众点评店铺页" 这些 label 在 `buildLinks` 里硬编码中文，没有按 `uiLanguage` 分支。

## 修复

仅改 `src/lib/echo.functions.ts`。

### 1. 强化英文 langDirective（line 1360）

把英文版语言指令写得更狠：
- 明令 **禁止任何 CJK 字符**出现在 `aiSummary / pros / cons / matchDetails[].label / hardFilterChecks[].note`。
- 明确说："如果源 review 是中文，**只输出英文意译，不要把中文原文用引号附上**。"举一个反例（"❌ Reviews mention '氛围复古有特色' (retro and unique atmosphere)" → "✅ Diners praise the retro, characterful atmosphere"）。
- 给一个简短的判定：任何 char.match(/[\u4e00-\u9fff]/) 都视为违规。

### 2. `buildLinks` 接收 `isEn`（line 738）

在 `buildLinks(p, city, country, isEn)` 中：
- "大众点评" → `isEn ? "Dianping" : "大众点评"`
- "小红书" → `isEn ? "Xiaohongshu" : "小红书"`
- "大众点评店铺页" → `isEn ? "Dianping page" : "大众点评店铺页"`
- "官网" → `isEn ? "Website" : "官网"`
- "Google 搜索" → `isEn ? "Google Search" : "Google 搜索"`

调用点（line 1611 附近）：`buildLinks(p, data.city, country, isEn)`。

## 不改动

- `Tabelog / Yelp / TripAdvisor / Google Maps` 等专有名词保持原样。
- 中文版输出完全不变。
- AI 不强制翻译用户的原始硬条件文字（那是用户自己的输入）。

## 不确定

是否保留中文链接 label 中"大众点评/小红书"作为品牌专名（在中国大陆访问中文平台时，纯英文 label 可能让人困惑）。我倾向用英文专名 "Dianping" / "Xiaohongshu"（业内公认）。
