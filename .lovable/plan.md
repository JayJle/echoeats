## 改动 1：把「✨ AI 识别」标注挪到 cuisine 字段上

**问题**：当前在标题右侧加了一个大 badge `✨ AI 识别的品类`，并把 `cuisineLevelConstraints`（其实是需求，不是品类）也渲染成「推断依据」chips。这让标注挂在「要求」上，不在 cuisine 上。

**改动文件**：`src/routes/results.tsx`（仅 UI，无业务逻辑变动）

将当前的纯文本标题
```
{parsed.city} · {parsed.cuisines.join(" / ")}
```
拆成 city + cuisine chips：

- `parsed.city` 仍为纯文本，后跟 ` · `
- `parsed.cuisines` 渲染为 inline chips
  - 若 `parsed.cuisinesInferred = true`：每个 chip 形如 `✨ 居酒屋` `✨ 烤肉` `✨ 日式料理`，使用 `bg-primary/10 text-primary border-primary/20` 样式，与标题同基线
  - 若 false（用户显式选择）：渲染成普通 chip（无 ✨，浅灰边框），保持原视觉重量
- 移除标题右侧的 `✨ AI 识别的品类` badge
- 移除「根据你的需求自动匹配」副标题
- 移除「推断依据 / cuisineLevelConstraints」整块 chips（它们不是品类，是需求；后续在 softPreferences 区已经会展示，不需要重复）

最终视觉：

```
搜索结果
东京 · [✨ 居酒屋] [✨ 烤肉] [✨ 日式料理]
未指定
```

chip 大小略小于标题字体，inline-flex 居中对齐。

## 改动 2：搜索变慢的诊断（不改代码，先确认原因）

不是 UI 改动引起的。`searchRestaurants` 在 `data.cuisines.map(async (cuisine) => …)` 处按品类并行抓 Google Places + 评论 + 图片（echo.functions.ts:988、1038）。

- 用户显式选 1 个 cuisine → 1 路抓取
- AI 推断出 3 个 cuisine（居酒屋/烤肉/日式料理） → 3 路抓取 + 3 倍下游评论/Tabelog 调用 + 后续 ranking 处理更多候选

所以「跳过 cuisine 让 AI 推」天然会比「自己选 1 个」慢 1.5–2x，这是预期成本，不是 bug。

**可选缓解**（需要你确认是否动）：

- A. 把 prompt 里「推断 1-3 个料理候选」改成「推断 1-2 个最相关的品类，优先选一个最贴需求的」。改动小，能砍掉一半冗余抓取，但会牺牲一点品类覆盖。
- B. 维持现状，仅在 loading UI 上加一行小字提示「AI 推断了 N 个品类，正在并行搜索…」，让用户感知到为什么慢。
- C. 都不动，认为「跳过 cuisine = 接受更长等待」是合理 trade-off。

建议先做改动 1（确定的 UI 修复），改动 2 等你选 A/B/C 再做。

## 不改动的地方

- prompt、parseRequirements 业务逻辑、cuisinesInferred 标记规则
- searchRestaurants、Google Places、Tabelog、Supabase
- store.ts 类型（cuisinesInferred 仍保留，UI 仍读它）
