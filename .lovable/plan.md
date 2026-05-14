# 方案 A：Google Places API + AI 排序

## 核心改动

把 AI 从"店铺生成器"降级为"店铺评分器"，真实店铺数据由 Google Places API 提供。

```text
用户需求
  → AI 解析需求 (parseRequirements，保留)
  → Google Places Text Search   ← 每个料理类型搜一次，返回真实候选
  → AI 对候选打分+写理由         ← 输入是真实店列表，AI 不再编名字
  → 前端用 place_id 拼正确链接
```

## 实施步骤

### 1. 用户准备 Google Places API Key
- 去 Google Cloud Console → 启用 **Places API (New)**
- 创建 API Key，建议加 HTTP referrer / API 限制
- 通过 Lovable Cloud 加 secret：`GOOGLE_PLACES_API_KEY`
- 计费：每月前 $200 免费额度（Text Search 约 $32/1000 次，足够日常使用）

### 2. 新增 `src/lib/google-places.server.ts`
封装 Places API (New) 调用：
- `searchPlaces({ query, locationBias, language, maxResults })` → POST `https://places.googleapis.com/v1/places:searchText`
- 用 `X-Goog-FieldMask` 只取需要的字段（控制费用）：
  `places.id, places.displayName, places.formattedAddress, places.rating, places.userRatingCount, places.priceLevel, places.currentOpeningHours.openNow, places.regularOpeningHours, places.websiteUri, places.googleMapsUri, places.primaryTypeDisplayName, places.editorialSummary, places.location`
- 返回标准化候选数组

### 3. 重写 `src/lib/echo.functions.ts` 中的 `searchRestaurants`
新流程：
1. 对 `data.cuisines` 每个料理类型并行调用 `searchPlaces`：
   - query = `"${cuisine} restaurant ${city}"`（中文城市保留中文，AI 解析阶段已规范化）
   - language = 根据城市猜（日本=ja，中国=zh-CN，其它=en）
2. 把每类前 8-10 家候选喂给 AI，prompt 改为：
   > "以下是 Google Places 返回的真实候选餐厅 (含 place_id, name, address, rating)。基于用户需求，为每家打 0-100 分，写 2-3 句中文匹配理由，列 pros/cons。**只能使用列表中的 place_id，禁止虚构。** 每组返回最匹配的 1-3 家。"
3. AI 输出 schema 改为：`{ groups: [{ cuisine, picks: [{ placeId, matchScore, matchTier, aiSummary, pros[], cons[], matchDetails[] }] }] }`
4. 后端用 `placeId` join 回 Places 数据，组装最终结果

### 4. 链接生成（取代当前的搜索链接拼接）
- 主链接：`googleMapsUri` （Places API 直接返回，100% 准确）
- 备用：`websiteUri`（官网，如果有）
- 日本店保留 Tabelog 站内搜索（用真实 displayName 当 query）
- 中国店保留大众点评搜索

### 5. 数据展示更新 (`src/routes/results.tsx`)
- 新增字段：`address`、`googleMapsUri`、`primaryTypeDisplayName`
- 卡片显示真实地址（让用户一眼判断是否在目标区域）
- "图片"区改为：如果 Places 返回照片就显示真照片（可后续接 Places Photos API），否则保留 Google Images 搜索链接

### 6. 错误兜底
- Places 搜不到 → 直接告诉用户「该城市无 ${cuisine} 候选」，不让 AI 编
- Places 报错（quota / key 无效）→ 明确报错，不静默 fallback
- 没设置 `GOOGLE_PLACES_API_KEY` → 给清晰的 setup 提示

## 不做的事（保持范围聚焦）

- 不加缓存表（先跑通，看实际用量再决定是否启用 Lovable Cloud + 缓存表）
- 不接 Places Photos API（多一次付费请求，先用真实地址 + Google Images 链接顶住）
- 不动 `parseRequirements`、不动前端各步骤页面（confirm/cuisines/when/requirements）

## 影响文件清单

- 新增 `src/lib/google-places.server.ts`
- 改 `src/lib/echo.functions.ts`（重写 `searchRestaurants` 及相关 schema/normalize 函数）
- 改 `src/routes/results.tsx`（显示地址、用真实链接）
- 新增 secret：`GOOGLE_PLACES_API_KEY`

## 需要你确认

你准备好 Google Places API Key 了吗？确认后我会：
1. 调起 secret 输入框让你贴 key
2. 立刻开始按上述步骤改代码
