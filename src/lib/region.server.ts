// 中国大陆城市判定（用于第一页拦截）：仅在文本中明确出现中国大陆地名/省份关键词时才命中。
// 不再以"含中文字符"作为兜底，避免把"纽约/伦敦/巴黎/洛杉矶"这类中文写法的外国城市误判为大陆。
// 纯函数，零外部依赖。

const MAINLAND_CHINA_CITY_PATTERNS = [
  // 直辖市（中文）
  /北京|上海|天津|重庆/,
  // 省份与自治区（中文，台湾不在此列）
  /河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆/,
  // 主要地级市（中文）
  /广州|深圳|成都|杭州|南京|武汉|西安|苏州|青岛|长沙|郑州|东莞|佛山|宁波|无锡|合肥|厦门|福州|济南|大连|沈阳|哈尔滨|长春|昆明|南宁|贵阳|兰州|银川|乌鲁木齐|拉萨|呼和浩特|太原|石家庄|南昌|海口|三亚|珠海|中山|惠州|温州|嘉兴|绍兴|金华|台州|烟台|潍坊|临沂|洛阳|唐山|保定|廊坊|秦皇岛|徐州|常州|南通|扬州|镇江|盐城|泰州|淮安|连云港|宿迁/,
  // 显式"中国大陆 / 中华人民共和国 / 中国"
  /中国大陆|中國大陸|中华人民共和国|中華人民共和國/,
  // 英文（拼音 / 常见英文写法）
  /\b(beijing|peking|shanghai|tianjin|chongqing|chungking)\b/i,
  /\b(guangzhou|canton|shenzhen|chengdu|hangzhou|nanjing|wuhan|xi'?an|suzhou|qingdao|tsingtao|changsha|zhengzhou|dongguan|foshan|ningbo|wuxi|hefei|xiamen|amoy|fuzhou|jinan|dalian|shenyang|harbin|changchun|kunming|nanning|guiyang|lanzhou|yinchuan|urumqi|lhasa|hohhot|taiyuan|shijiazhuang|nanchang|haikou|sanya|zhuhai|wenzhou|jiaxing|shaoxing|jinhua|taizhou|yantai|weifang|linyi|luoyang|tangshan|baoding)\b/i,
  /\bmainland\s*china\b/i,
  /\bp\.?\s*r\.?\s*c\.?\b/i,
];

export function isMainlandChinaCity(city: string): boolean {
  const s = city.trim();
  if (!s) return false;
  return MAINLAND_CHINA_CITY_PATTERNS.some((p) => p.test(s));
}

// 基于 Google Places 候选项的 countryOrRegion 字符串判断是否为中国大陆（排除港澳台）。
export function isMainlandChinaRegion(countryOrRegion: string): boolean {
  const s = countryOrRegion.trim();
  if (!s) return false;
  const isChina = /中国|中國|china/i.test(s);
  if (!isChina) return false;
  const isHKMOTW =
    /香港|hong\s*kong|澳门|澳門|macau|macao|台湾|台灣|taiwan|台北|taipei/i.test(s);
  return !isHKMOTW;
}
