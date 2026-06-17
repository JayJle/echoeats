# 修复：中文输入的外国城市被误判为"中国大陆"

## 问题
输入"纽约"在首页被拦截，提示"暂不支持查找中国大陆地区的城市"。同样的问题会出现在所有用中文写的非东亚/东南亚白名单城市：伦敦、巴黎、洛杉矶、悉尼、迪拜、罗马、柏林……

## 根因
`src/lib/region.server.ts` 的 `isMainlandChinaCity` 用的是"反向白名单"逻辑：
1. 含中文字符 → 默认认为是中国大陆
2. 除非命中 港澳台 / 日 / 韩 / 东南亚 的关键词白名单

"纽约"含中文字符且不在任何白名单里，因此被判为大陆并直接拦截，不会走到 Google Places。

## 修复方案
改成"正向匹配"——只在文本里**明确出现**中国大陆地名 / 行政区 关键词时才在入口处拦截，其他所有情况都交给 Google Places + `isMainlandChinaRegion`（后者基于 Places 返回的 country 字段判断，已经能正确处理）。

### 改动

**文件：`src/lib/region.server.ts`**

把 `isMainlandChinaCity` 改成基于"已知大陆城市/省份关键词"的显式匹配：

- 直辖市：北京、上海、天津、重庆
- 省份：河北、山西、辽宁、吉林、黑龙江、江苏、浙江、安徽、福建、江西、山东、河南、湖北、湖南、广东、海南、四川、贵州、云南、陕西、甘肃、青海、台湾(排除)、内蒙古、广西、西藏、宁夏、新疆
- 主要城市：广州、深圳、成都、杭州、南京、武汉、西安、苏州、青岛、长沙、郑州、东莞、佛山、宁波、无锡、合肥、厦门、福州、济南、大连、沈阳、哈尔滨、长春、昆明、南宁、贵阳、兰州、银川、乌鲁木齐、拉萨、呼和浩特、太原、石家庄、南昌、海口、三亚、珠海、中山、惠州、温州、嘉兴、绍兴、金华、台州、烟台、潍坊、临沂、洛阳、唐山、保定、廊坊、秦皇岛 …（覆盖主要城市，<= 100 个）
- 英文：beijing / shanghai / guangzhou / shenzhen / chengdu / hangzhou / nanjing / wuhan / xi'an / xian / suzhou / qingdao / changsha / mainland\s*china / prc

判定逻辑：
```ts
export function isMainlandChinaCity(city: string): boolean {
  const s = city.trim();
  if (!s) return false;
  // 只在匹配到明确的大陆地名时才返回 true，不再以"含中文"作为兜底
  return MAINLAND_CHINA_CITY_PATTERNS.some((p) => p.test(s));
}
```

`isMainlandChinaRegion`（基于 Places `countryOrRegion`）保持不变——它已经能在二次过滤阶段正确剔除 Places 返回的大陆候选。

### 边界处理
- "纽约" / "伦敦" / "巴黎" / "洛杉矶" / "东京" / "首尔" → 不命中正向列表 → 交给 Google Places ✅
- "北京" / "上海" / "Beijing" / "Shanghai" → 命中 → 入口拦截 ✅
- "香港" / "台北" / "Hong Kong" → 不命中大陆列表 → 通过 ✅
- Places 万一返回 country=China 的大陆候选（例如对"纽约"返回了某个中国小地名）→ `isMainlandChinaRegion` 在候选过滤阶段兜底剔除 ✅

## 验证
1. 输入"纽约" → 期望进入候选选择或 confirmed=New York
2. 输入"北京" → 期望 `unsupported_region`
3. 输入"Hong Kong" / "香港" → 期望通过

不改任何 UI、不改 prompt 节点，只动 `region.server.ts` 一个文件。
