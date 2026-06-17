# 落地 V3 精简版 prompt

## 改动

替换 `src/lib/echo.functions.ts` 中 `parseRequirements` server function 的提示词字符串（当前位于 L213–L360 区间），用上方给出的 V3 完整版本（含 §0–§9 共 9 个章节、5 个 Few Shots、最终 schema）。

将 `${data.city}` / `${data.cuisines}` / `${data.date}` / `${data.mode}` / `${data.freeText}` / `${data.uiLanguage}` / `${data.autoInferCuisines}` / `${new Date().getDay()}` / `${new Date().toISOString().slice(0, 10)}` 等服务端注入位保持模板字符串语法不变。

## 不动

- `runOnce` / `forceInfer` 重试逻辑
- Zod schema 与 fallback 解析代码（L380+）
- 模型选择（主 `gemini-2.5-flash`，fallback `gpt-5-mini`）
- 调用链路、错误处理、日志

## 预期效果

- token 比 V2 减少约 35%、比 V1 增加约 15%
- 「我要/want/need」误判 hardFilter 显著下降
- 品类级约束不再泄漏到 hardFilters
- AI 推断品类不再回退到 `["餐厅"]`
- 权重抖动收敛（双轨判定）

## 验证

落地后建议跑下列回归用例：
1. "I want a cozy ramen place, not touristy"（预期 hardFilters 为空）
2. "带 3 岁小孩想吃饱"（预期 cuisines 推出具体品类、hardFilters 为空）
3. "两个人务必必须 15000 日元以内，可以预约"（预期 weight=1.0/0.9/0.8 三条 hard）
4. "周六晚上 7 点"（预期 visitTime.evidence 为原文连续片段）
