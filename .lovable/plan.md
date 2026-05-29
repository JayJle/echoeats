# 主页添加大众点评反爬提示

## 改动

### 1. `src/lib/i18n/dict.ts` 新增两条 key
- `home.notice.dianping`
  - zh：`由于大众点评反爬机制，中国大陆地区搜索效果可能不理想，建议优先在海外城市使用。`
  - en：`Due to Dianping's anti-scraping measures, results for mainland China cities may be limited. Best experience is in overseas cities.`

### 2. `src/routes/index.tsx` 在搜索框下方加一条提示
位置：`<form>` 内部、`Button` 之上，作为一行轻量说明文字。
样式：`text-xs text-muted-foreground`，配一个 ⓘ 图标（lucide `Info`），不打断视觉主流程。

```tsx
<p className="flex items-start gap-2 text-xs text-muted-foreground">
  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
  <span>{t("home.notice.dianping")}</span>
</p>
```

仅改前端展示，不动业务逻辑。

---

## 🧒 白话方案
在首页输入城市的搜索框下面加一行小灰字提示用户：中国大陆的店因为大众点评反爬，搜出来效果一般，更适合在海外城市使用。中英双语自动跟随当前语言切换。

## 👀 用户视角变化
- 主页搜索框下方多出一行带 ⓘ 图标的灰色小字说明。
- 中文界面显示中文，英文界面显示英文。
- 不挡操作，按钮位置不变。

## 💰 成本与副作用
- **金钱/性能**：0 增量，纯静态文案。
- **副作用**：无；若文案太长可能在窄屏多占一行高度，但 `text-xs` 控制视觉重量已足够低。
- **风险**：无。
