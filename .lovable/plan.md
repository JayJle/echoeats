
## 目标

- 第一页输入中国大陆城市（北京/上海/成都…）→ 校验拦截，提示"暂不支持中国大陆地区"，不进入后续流程。
- 港澳台（HK/MO/TW）继续支持。
- 完全砍掉大众点评（dianping）数据源、链接、评分聚合。
- 提示词**只清理城市相关部分**，其它中文提示词（菜系扩展、AI 评分总结、中文 UI 文案等）一律保留——主用户仍是国内用户。
- **其它地区（日本/韩国/东南亚/欧美等）逻辑完全不动。**

---

## 涉及模块与改动点

### 1. 第一页城市校验（新增大陆拦截）

**新文件 `src/lib/region.server.ts`**
- 把 `dianping.server.ts` 中现有的 `isMainlandChinaCity()` 函数迁过来（纯函数、零依赖），这样删除 dianping 后该判定仍可用。

**`src/lib/city.functions.ts`**
- import `isMainlandChinaCity`。
- 在 `validateCity` handler 入口先判定用户输入；命中大陆 → 直接返回新增 status `"unsupported_region"`。
- 也对 `autocompleteCities` 返回的候选项做一次过滤：若候选 `countryOrRegion` 明确为"中国"且不属于 HK/MO/TW → 同样返回 `unsupported_region`。
- `CityValidationResult` 联合类型新增 `{ status: "unsupported_region" }`。

**`src/routes/index.tsx`**
- `handleResult` switch 新增 `unsupported_region` 分支，复用 `invalid`/`not_found` 同款错误 UI，文案走 i18n。
- 删除底部 `home.notice.dianping` 提示条。

**`src/lib/i18n/dict.ts`**
- 新增 `step1.unsupportedRegion`（中/英）。
- 删除 `home.notice.dianping` 中英两条。

### 2. 完全砍掉大众点评数据源

**删除文件 `src/lib/dianping.server.ts`**（先确认 `isMainlandChinaCity` 已迁出）。

**`src/lib/echo.functions.ts`**（改动最集中）
- 移除 `import { isMainlandChinaCity, searchDianpingCuisine, type DianpingReview } from "./dianping.server"`（`isMainlandChinaCity` 已不在此文件使用）。
- 主搜索流程（约 1170 行）：
  - 删 `useDianping`、`country === "CN"` 分支、`searchDianpingCuisine` 调用、`stage: "dianping"` 进度上报。
  - 第一页已拦截大陆，主流程默认走 Google Places + Tabelog/Yelp 既有路径。
- Review 数据结构：
  - 移除 `dianpingRating` / `dianpingRatingSource` 字段及所有写入点（约 520-525、599-600、616-618），同步更新 `results.tsx` 的消费点。
- 链接生成（约 910 行 `isCN` 分支）：
  - 删除大众点评 H5 深链 (`m.dianping.com/searchshop`)、"大众点评店铺页"标签、`dianping.com/shop/` 判定。
  - 把原 `isCN`（含 HK/MO/TW）拆开：HK/MO/TW 改走 Google Maps/Yelp/TripAdvisor 既有非 CN 分支。
- 评分聚合（约 981/1008 行）：
  - 删 `dpScore` 行；平台数组不再 push `大众点评`。
  - `isCN` 变量整体移除。
- `SOURCE_ENUM` 删 `"大众点评"`。
- `PLATFORMS` 数组（第 6 行）删 `"大众点评"`、`"美团"`。

**提示词层面（仅城市相关，其它一概不动）**
- `src/lib/echo.functions.ts` 约 306-322 行：
  - 删除"上海/北京/成都/苏州/杭州/重庆/西安等大陆城市 → CN"那一行示例。
  - 国家→语言映射删去 `CN → "zh-CN"`，保留 HK→zh-HK、TW→zh-TW、MO→zh-HK。
- `src/lib/google-places.server.ts`：
  - 第 126 行删除大陆城市名匹配 `北京|上海|广州|深圳|成都|杭州|武汉|南京|重庆`（已在第一页拦截，无需再判 CN）。
  - 第 118 行"含中文 → zh-CN"语言映射**保留**（港澳台用户输入中文仍需）。
  - 第 139 行 `CN: /(?:中国|中國|china)/i` 保留（作为候选项过滤辅助，不参与新增逻辑）。
- **不动**：
  - `cuisine-expand.server.ts` 注释里的"猪肉饭 + zh-CN"示例（与城市无关，保留）。
  - AI 排序/总结/抽取的所有中文表达。
  - `CURRENCY_ENUM` 中的 `CNY`（港澳台/历史会话可能涉及，保留更安全）。
  - 所有中文 UI 文案与 zh 词条（除新增 `unsupportedRegion`、删除 `dianping notice` 外）。

**`src/lib/store.ts`**
- 第 80 行 `stage` 注释字符串去掉 `"dianping"`。

**`src/routes/results.tsx`**
- `SourceKey` 类型删去 `"大众点评"`、`"美团"`、`"小红书"`（这三者均为大陆来源）。
- 颜色映射、字符串识别、`u.includes("dianping.com")` 整条删除。
- 同步删除对 `dianpingRating` 字段的所有消费点。

### 3. 不动的部分（明确边界）

- Tabelog（日本）、Yelp（欧美/日本）、Google Places 主流程：**零改动**。
- 港澳台分支：从"`isCN` 包含 HK/MO/TW"改为独立分支，确保仍能拿到 Google Maps + Yelp/TripAdvisor 链接，不再回落大众点评。
- 评分/排序/AI summary 流程：仅删除大众点评维度，其它权重与逻辑保持。
- 所有面向国内用户的中文文案与提示词措辞：**保留**。

---

## 影响与风险

1. **类型 breaking change**：`Review.dianpingRating`、`SOURCE_ENUM`、`SourceKey`、`CityValidationResult` 变化，TS 编译会一次性暴露遗漏点（安全网）。
2. **港澳台行为微调**：以前与 CN 共用 `isCN` 分支会生成大众点评深链；改造后这些链接消失，改走 Google/Yelp。需要产品确认可接受。
3. **历史 sessionStorage 残留**：旧 `Restaurant` JSON 可能带 `dianpingRating` 字段或 `sources: ["大众点评"]`，前端展示做容错（多余字段忽略即可）。
4. **i18n**：新增 `step1.unsupportedRegion`，删除 `home.notice.dianping`；任何调用旧 key 的地方一并清理。
5. **后端密钥**：Perplexity / Firecrawl 仍被 Tabelog/Yelp 使用，**不要**删 secrets。
6. **进度条 stage**：`stage: "dianping"` 不再出现，前端对应 i18n key 一并清理。
7. **管理后台 `/admin/feedback`**：仅展示数据，预计无需改动；构建后 grep 确认。

---

## 实施顺序

1. 抽出 `isMainlandChinaCity` 到 `src/lib/region.server.ts`。
2. 改 `city.functions.ts` + `index.tsx` + `dict.ts`，让第一页能拦截大陆并展示提示。
3. 删 `dianping.server.ts`，按 TS 编译错误顺序逐个清理 `echo.functions.ts` / `results.tsx` / `store.ts`。
4. 仅清理城市相关的提示词与 `google-places.server.ts` 大陆城市匹配，**其它提示词不碰**。
5. 构建通过后 preview 验证：北京（拦截）/ 香港（走 Google/Yelp）/ 东京（与之前一致）。
