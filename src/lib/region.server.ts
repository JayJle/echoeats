// 中国大陆城市判定（用于第一页拦截）：含中文字符 + 不在港澳台/日韩英文/中文白名单中。
// 纯函数，零外部依赖。

const NON_MAINLAND_CITY_PATTERNS = [
  // 港澳台
  /香港|澳门|澳門|台湾|台灣|台北|高雄|台中|台南|新北|桃园|桃園/i,
  /hong\s*kong|macau|macao|taipei|taiwan|kaohsiung/i,
  // 日本
  /日本|东京|東京|京都|大阪|名古屋|札幌|福冈|福岡|横滨|橫濱|神户|神戶|奈良|冲绳|沖繩/i,
  /tokyo|kyoto|osaka|nagoya|sapporo|fukuoka|yokohama|kobe|nara|okinawa|japan/i,
  // 韩国
  /韩国|韓國|首尔|首爾|釜山|济州|濟州/i,
  /korea|seoul|busan|jeju/i,
  // 新加坡 / 东南亚常见中文表达
  /新加坡|吉隆坡|曼谷|马来西亚|馬來西亞|泰国|泰國|越南|河内|河內|胡志明/i,
  /singapore|kuala\s*lumpur|bangkok|thailand|vietnam|hanoi|ho\s*chi\s*minh/i,
];

export function isMainlandChinaCity(city: string): boolean {
  const trimmed = city.trim();
  if (!trimmed) return false;
  // 必须含中文字符，否则不算（北京 ✓ / Tokyo ✗）
  if (!/[\u4e00-\u9fff]/.test(trimmed)) return false;
  for (const pat of NON_MAINLAND_CITY_PATTERNS) {
    if (pat.test(trimmed)) return false;
  }
  return true;
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
