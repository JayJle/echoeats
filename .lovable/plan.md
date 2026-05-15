## 目标

冷门城市（函馆、轻井泽、由布院、清迈、釜山郊区、佛罗伦萨…）当前因为白名单正则覆盖不到，被错误路由（例如"函馆"被当成中国城市走大众点评分支）。

让 AI 在 parse 阶段就输出 `country`（ISO 3166-1 alpha-2），下游所有"该走哪个数据源 / 用什么语言 / 要不要查 Tabelog"的判断改用这个字段，丢弃白名单正则。

## 改动清单（4 个文件）

### 1. `src/lib/echo.functions.ts` — parseRequirements 输出 country

**ParsedSchema 增加字段**：
```ts
country: z.string().length(2).default("")  // ISO 3166-1 alpha-2，如 "JP" / "CN" / "KR" / "US"
language: z.string().default("")           // BCP 47，如 "ja" / "zh-CN" / "ko" / "en"
```

**Prompt 末尾新增章节**：
> ## 国家/语言识别
> - country：根据 city 推断 ISO 3166-1 alpha-2 国家码。包括非著名城市：函馆/小樽/旭川/轻井泽 → JP；清迈 → TH；佛罗伦萨/米兰 → IT 等。识别不出留 ""。
> - language：该城市本地主要语言的 BCP 47 代码（JP→ja, CN/HK/TW→zh-CN/zh-HK/zh-TW, KR→ko, 否则按国家映射，识别不出留 ""）。

**兜底分支**（catch 里）也带上 `country: ""`, `language: ""`，下游处理空值。

### 2. `src/lib/echo.functions.ts` — searchRestaurants 改用 parsed.country

**目前**：
```ts
const useDianping = isMainlandChinaCity(data.city);                  // 行 617
const language = guessLanguageCode(data.city);                       // 行 688
const region = guessRegionCode(data.city);                           // 行 689
if (!useDianping && pplxKey && guessRegionCode(data.city) === "JP")  // 行 798
```

**改为**（基于 parsed 数据，正则只作 fallback）：
```ts
const country = parsed.country || guessRegionCode(data.city) || "";
const language = parsed.language || guessLanguageCode(data.city);
const useDianping = country === "CN" || country === "HK" || country === "MO";
const region = country || undefined;
if (!useDianping && pplxKey && country === "JP") { /* Tabelog 补充 */ }
```

`buildLinks` 里的 `isChineseCity` / `isJapaneseCity` 调用同样改为接收 country 参数。

### 3. `searchRestaurants` 接收 country/language

`SearchInput` schema 增加可选 `country`、`language` 字段，前端调 `searchRestaurants` 时把 `parsed.country` / `parsed.language` 一并传入。这样 country 不需要在 server 里二次推断。

### 4. `src/routes/cuisines.tsx` 与 `src/routes/results.tsx` 传递 country

`cuisines.tsx` 调 `searchFn` 时：
```ts
await searchFn({ data: { city, cuisines, freeText, country: parsed.country, language: parsed.language } })
```

`results.tsx` 的"再次搜索"和"应用补充条件"两处同样传递。

## 不动的部分

- `dianping.server.ts` / `google-places.server.ts` / `tabelog.server.ts` 内部逻辑全部不动。
- `isMainlandChinaCity` / `guessRegionCode` / `guessLanguageCode` **保留**作为 AI 失败时的 fallback，不删除。
- 评论摘要、Tabelog 抓取、价格筛选、AI 评估 prompt 全部不动。
- `useQueryStore` 不增字段（country/language 只在内存里流转，不持久化到 sessionStorage）。

## 数据流

```text
/cuisines  →  parseRequirements → parsed { country: "JP", language: "ja", ... }
                                     ↓
                              searchRestaurants({ ...parsed })
                                     ↓
              country=="CN/HK/MO"?  → 大众点评分支
              country=="JP"?         → Google Places + Tabelog 补充
              其它                   → Google Places 纯 Google 分支
```

## 验证

1. 输入"函馆 寿司"→ parse 应返回 `country:"JP"`、`language:"ja"` → 走 Google Places + Tabelog → 出店、链接含 Tabelog 跳转。
2. 输入"轻井泽 法餐"→ 同上走 JP 分支。
3. 输入"清迈 泰餐"→ `country:"TH"` → 走纯 Google 分支，不触发 Tabelog/大众点评。
4. 输入"上海 本帮菜"→ `country:"CN"` → 仍然走大众点评分支（与现状一致）。
5. AI parse 失败时（罕见）→ fallback 到正则，行为与今天一致，不崩。

## 风险

- 模型偶发把 city 国家判错（如把 "Springfield" 判成 US 但其实在 UK）。fallback 正则不覆盖时仍可能走错，但这种边缘情况比现在好得多（现在是大量城市都走错）。
- AI parse 多输出 2 个字段，token 消耗忽略不计。
