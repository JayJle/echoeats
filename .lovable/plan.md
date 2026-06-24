不改任何代码，只做一次端到端验证：

1. 用 Playwright 打开 `/requirements`，seed city=上海 + uiLanguage=zh，把你这段 brunch 原文填进 textarea。
2. 点"深度搜索"触发 `parseRequirements`，抓 `_serverFn` 返回。
3. 拉 Stage A/B/C 的服务端日志，确认：
   - extracted 条数
   - Stage B 合并数 + 用的模型（应该是 gemini-2.5-flash，不能再 fallback 到 deterministic）
   - hard / soft / neg / dishes 数量
4. 把最终 parsed 的 hardFilters / softPreferences / negativeFilters / dishPreferences / visitTime 全量贴给你。
5. 重点检查：
   - "环境"3 处 → 1 条
   - "菜品精致"2 处 → 1 条
   - "中高端 / 不低端 / 不太高端 / 不豪华 / 不太低端" 全部 → 1 条
   - 评分 4.0 必须 vs 4.3 最好 → 拆成 hard + soft 2 条
   - 班尼迪克蛋 + French toast → dishPreferences
   - 周六 12:00 → visitTime weekday=6, hhmm=12:00