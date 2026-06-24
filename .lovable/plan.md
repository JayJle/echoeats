## 目标
删掉结果页标题下方那行无用的 `parsed.dateTime` 文字，保留下方真正生效的 🕐 营业时间标签。

## 改动
**仅一处**：`src/routes/results.tsx:317`

删除这一行：
```tsx
<p className="mt-1 text-sm text-muted-foreground">{parsed.dateTime}</p>
```

## 不影响
- `parsed.dateTime` 字段本身仍由后端返回，仅不在 UI 显示
- 下方 `parsed.visitTime.weekday + hhmm` 的 🕐 标签照常显示
- 任何筛选 / 排序 / 业务逻辑都不受影响（dateTime 本来就只是展示用）
- i18n、其他页面、其他字段全部不动