# 在地址下方展示店铺营业时间

## 目标
结果卡片里在 `📍 地址` 下方多一行营业时间：
- 优先显示**今天**的营业时段，例如 `🕐 今日 11:00–14:30, 17:30–22:00`
- 拿不到今日数据时退化为「营业中（时间未公开）」/「营业时间未公开」
- 鼠标悬浮可看全周（用原生 `title`）

## 数据来源
Google Places (New) `places.regularOpeningHours.weekdayDescriptions`：返回 7 条本地化文本（如 `"星期一: 11:00 – 22:00"` / `"Monday: Closed"`），按 Monday→Sunday 排列。

## 改动清单

### 1. `src/lib/google-places.server.ts`
- `FIELD_MASK` 增加 `"places.regularOpeningHours.weekdayDescriptions"`
- `PlaceCandidate` 增加 `weekdayDescriptions: string[] | null`
- 响应解析读取 `p.regularOpeningHours?.weekdayDescriptions ?? null`

### 2. `src/lib/echo.functions.ts`
- `RestaurantSchema`(~445) 增加 `weekdayDescriptions: z.array(z.string()).nullable().optional().default(null)`(用 optional+default,**老缓存里没有这个字段时也能通过校验**)
- 两处 restaurant 构造(深度 ~1100、快速 ~1107)填 `weekdayDescriptions: p.weekdayDescriptions ?? null`
- prompt 不传该字段(避免 AI 据此打 fail)

### 3. `src/routes/results.tsx`
- 文件内新增小工具:
  ```ts
  function todayHoursLabel(weekdayDescriptions: string[] | null | undefined, openNow: boolean): string {
    if (!weekdayDescriptions?.length) {
      return openNow ? "营业中(时间未公开)" : "营业时间未公开";
    }
    // Google 顺序 Mon..Sun;JS getDay() 0=Sun → index = (day + 6) % 7
    const idx = (new Date().getDay() + 6) % 7;
    const line = weekdayDescriptions[idx] ?? weekdayDescriptions[0];
    return line.replace(/^[^:：]+[:：]\s*/, ""); // 去掉"星期X:"/"Monday:"前缀
  }
  ```
- 在 `📍 地址` 的 `<p>` 下方插入:
  ```tsx
  <p
    className="mt-0.5 text-sm text-muted-foreground"
    title={r.weekdayDescriptions?.join("\n") ?? undefined}
  >
    🕐 今日 {todayHoursLabel(r.weekdayDescriptions, r.openNow)}
  </p>
  ```
- 保留原有"✓ 当前营业"徽章(语义互补:一个是状态色块,一个是具体时间)

## 解决旧缓存兼容风险
`src/lib/store.ts` 用 sessionStorage persist 了 `results`,老数据里 restaurant 对象没有 `weekdayDescriptions` 字段。
处理:
- schema 用 `.nullable().optional().default(null)`,新结果通过校验没问题
- store 读出来的旧数据**不会再走 zod 校验**(读 sessionStorage 直接 setState),所以也不会报错;`r.weekdayDescriptions` 在老数据上是 `undefined`,`todayHoursLabel` 已通过 `weekdayDescriptions?.length` 优雅退化为"时间未公开"
- 不需要 bump `version` / 写 migrate

实际效果:用户老结果会显示"营业中(时间未公开)"或"营业时间未公开",一旦重新搜索就有完整数据。

## 不做的事
- 不做 7 天展开 UI(`title` 悬浮已足够,移动端可后续做)
- 不改打分/筛选/prompt
- 不做时区换算(Google 返回的是店铺当地时间字符串,直接展示)
- 不引入新依赖

## 其它风险
- 极少数店铺 Google 不返回 `regularOpeningHours`(连锁、新店、永久关闭) → 已用退化文案覆盖
- 文本语言跟随 `languageCode`(基于城市猜),前缀正则用 `[^:：]+` 兼容中英文冒号;日韩文同样匹配
