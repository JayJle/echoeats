# 日期时间硬筛（语言无关 · 零误触发）

## 核心保证
1. 没提到日期/时间 → 100% 不触发筛选
2. 不依赖任何语言的关键词正则，未来加英/日/韩等版本都通用
3. AI 抽取 + `evidence` 子串校验 + 字段完整性校验三重门控，杜绝幻觉

## 改动

### 1. ParsedSchema 增加 visitTime
`src/lib/echo.functions.ts`
```ts
visitTime: z.object({
  mentioned: z.boolean(),
  evidence: z.string(),                                  // 原文逐字片段
  weekday: z.number().int().min(0).max(6).nullable(),    // 0=Sun..6=Sat
  hhmm: z.string().regex(/^\d{2}:\d{2}$/).nullable(),    // 24h
  raw: z.string(),
}).nullable().optional().default(null),
```

### 2. parseRequirements prompt 追加规则（语言无关）
- `mentioned=true` 仅当原文有可指向具体星期/日期/钟点/时段的词
- `evidence` 必须是 freeText 中**逐字出现**的片段（不得改写、不得翻译）
- 找不到 → `mentioned=false`，其它全 null
- 模糊词锚点：noon/中午→12:30，evening/晚上→19:00，morning/早上→8:30
- 相对日（today/tomorrow/今天/明天）按服务器今天本地 weekday 推算
- few-shot 给中英文各 2 例，含 1 个反例（"找家好店" / "find a good place" → mentioned=false）

### 3. 确定性二次校验（在 createServerFn handler 内）
```ts
const vt = parsed.visitTime;
if (vt?.mentioned) {
  const ev = vt.evidence?.trim() ?? "";
  if (!ev || !data.freeText.includes(ev)) parsed.visitTime = null; // 防幻觉
  else if (vt.weekday == null || !vt.hhmm) parsed.visitTime = null; // 信息不全不过滤
} else {
  parsed.visitTime = null;
}
```
`evidence` 必须真实出现在原文里 —— 这是**与语言无关**的防幻觉锚。

### 4. Google Places 抓取结构化营业时间
`src/lib/google-places.server.ts`
- `FIELD_MASK` += `places.regularOpeningHours.periods`
- `PlaceCandidate` += `openingPeriods`：
  ```ts
  Array<{
    open:  { day: number; hour: number; minute: number };
    close: { day: number; hour: number; minute: number } | null; // 24/7 时缺失
  }> | null
  ```
- day 按 Google 约定 0=Sun..6=Sat

`src/lib/dianping.server.ts`：补 `openingPeriods: null`

### 5. 服务端硬过滤（visitTime=null 时整段跳过）
`src/lib/echo.functions.ts` searchRestaurants 召回后、排序前：
```ts
if (parsed.visitTime) {
  const { weekday, hhmm } = parsed.visitTime;
  candidates = candidates.filter(c =>
    isOpenAt(c.openingPeriods, weekday!, hhmm!) !== "closed"
  );
}
```
`isOpenAt`：
- `openingPeriods=null` → `unknown`（保留）
- 命中区间 → `open`
- 否则 → `closed`
- 处理跨日营业（close<open 或 close.day≠open.day）

**兜底**：若某 cuisine 过滤后为空 → 回退保留前 3 个并标 `needsReview`，避免空结果。

### 6. 结果卡片徽章（仅触发时显示）
`src/lib/store.ts`：`Restaurant` 增加 `visitTimeMatch?: "open"|"unknown"|null`
`src/routes/results.tsx`：「🕐 今日…」一行旁加徽章
- `open` → 绿色"✓ {raw} 营业"
- `unknown` → 灰色"? 该时段营业未知"
- `null` → **不渲染**，行为完全不变

## 不做的事
- 不引入日期选择器
- 不做时区换算（Google periods 是店铺当地时间）
- 不改打分公式
- 不写任何语言关键词正则
- 未触发时 UI/数据流跟当前完全一致

## 防误触发验收清单
1. "两个人预算 15000" → mentioned=false → 不过滤
2. "find a good ramen place" → mentioned=false → 不过滤
3. "周六晚上 7 点" → evidence="周六晚上 7 点"，{weekday:6, hhmm:"19:00"} → 过滤
4. "this Saturday 7pm" → evidence="this Saturday 7pm"，{weekday:6, hhmm:"19:00"} → 过滤
5. "晚上去" → evidence="晚上"，weekday=null → 信息不全 → **不过滤**
6. AI 把"想吃饭"脑补成 evidence="晚上" → 原文不含"晚上" → 子串校验失败 → 清零

## 文件清单
- src/lib/echo.functions.ts
- src/lib/google-places.server.ts
- src/lib/dianping.server.ts
- src/lib/store.ts
- src/routes/results.tsx
