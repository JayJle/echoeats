## 目标
把 `/chat` 的搜索进度 UI 完全恢复为原 `requirements.tsx` 里那套设计（stepper 卡片 + 细长平滑进度条 + RAF 匀速动画），同时把 AI 已识别的结构化需求（品类/时间/预算 + LLM 摘要）也在进度卡片里展示出来。

## 之前的设计（原 `requirements.tsx`）
- **容器**：`rounded-xl border border-border bg-muted/30 p-4 space-y-4` 卡片。
- **顶部**：`<Progress value={displayProgress} className="h-1" />` 细进度条。
- **底部**：竖排 stage 列表（`<ul className="space-y-3">`），每行：
  - 状态图标：`Check`（完成，primary）/ `Loader2` spin（进行中）/ 空心小圆（待办）
  - 主文案：done/active 加粗，todo muted
  - active 时下方多一行 hint（`text-xs text-muted-foreground`）
- **4 stage**：`parse` → `search` → `reviews` → `rank`（复用 dict 里已有的 `stage.*` key）
- **RAF 匀速+抖动+软上限动画**：
  - `STAGE_RANGES.deep = { parse:[0,12], search:[12,25], reviews:[25,80], rank:[80,99] }`
  - `STAGE_EXPECTED_MS.deep = { parse:4000, search:8000, reviews:30000, rank:8000 }`
  - `v = (hi-lo)/expectedMs * jitterFactor`（±20%，~500ms 换）
  - `ceiling = min(target, hi-0.5)`；display<ceiling 正常速度，否则 1/6 速续爬，永不停
  - `display = min(display, hi-0.1)`
  - 收尾 target=100，expectedMs=600，RAF 等 display≥99.5 再 navigate（800ms 兜底）

## 后端事件 → stage 映射
后端 chunk：`places / places-done / tabelog / yelp / rank / photos` + `review-progress / tabelog-progress / yelp-progress`。
| 事件 | 处理 |
|---|---|
| runSearch 开始 | `parse` stage |
| `stage: places` | 进入 `search`，target 推到 search 段中点 |
| `stage: places-done` | 仍 `search`，target 推到 search 段尾 |
| `stage: tabelog` / `yelp` | 进入 `reviews` |
| `*-progress` | 用 `done/total` 在 reviews 段内计算真实 target |
| `stage: rank` | 进入 `rank` |
| `stage: photos` | 保持 `rank`，target 推到 rank 段后段 |
| 最终响应 | target=100，等动画走完再跳转 |

## 展示已识别的结构化需求
在进度卡片顶部（Progress bar 之上）加一块「已理解」摘要区：
- 一行 chip 列表（`flex flex-wrap gap-2 text-xs`），只在有值时显示：
  - 📍 city（始终有）
  - 🍱 `extracted.cuisine`
  - ⏰ `extracted.visitTime`
  - 💰 `extracted.budget`
  - chip 样式：`rounded-full border border-border/60 bg-background/60 px-2.5 py-0.5`
- 若 `analysisSummary` 非空，独占一行 `text-xs text-muted-foreground italic`，前缀 `💡 {t("chat.summary.label")}：`。
- 无任何识别值时整块隐藏，避免空占位。

## 前端改动 (`src/routes/chat.tsx`)
- 删除现有 `ProgressState / chunkToProgress` 单条百分比实现和当前 `SearchProgressOverlay`。
- 新增：
  - `type StageKey = "parse" | "search" | "reviews" | "rank"`
  - refs：`displayProgressRef / targetProgressRef / stageExpectedMsRef / jitterRef / rafProgressRef / lastFrameAtRef`
  - state：`currentStage: StageKey | null`, `displayProgress: number`
  - helpers：`STAGE_RANGES`、`STAGE_EXPECTED_MS`、`setRangeForStage`、`startProgressLoop / stopProgressLoop`、`computeReviewsTarget(done,total)`、`reviewsHintKey(city)`
- `runSearch` 改写：
  1. reset refs → `startProgressLoop` → `setCurrentStage("parse")` → `setRangeForStage("parse")`
  2. 调 `parseFn` 期间保持 parse
  3. 调 `searchFn` 拿 iterator → 在 `consumeSearchStream` 回调里按上表推进 stage/target
  4. 完成后 target=100，RAF 等动画到位再 `navigate("/results")`（800ms 兜底）
  5. 组件卸载 / 错误 → `stopProgressLoop`
- `SearchProgressOverlay` 组件重写：
  - 外层保留全屏 backdrop（`fixed inset-0 bg-background/85 backdrop-blur-sm`）
  - 内层：`rounded-2xl border bg-card p-6 space-y-4 w-full max-w-md shadow-lg`
  - 顶部标题：`chat.progress.title` + spinner 图标
  - **新加"已理解"区**（见上）
  - `<Progress value={displayProgress} className="h-1" />`
  - stage 列表（Check / Loader2 / 空心圆 三态）
  - 每个 active stage 显示 hint（其中 `search` 用 `stage.search.label` 里的 `{city}` 插值，`reviews` 用 `reviewsHintKey(city)` 决定 jp/other 版本）

## i18n
- 复用现有：`stage.parse.label/hint`、`stage.search.label/placeholder/hintDeep`、`stage.reviews.label/hint.jp/hint.other`、`stage.rank.label/hintDeep`；`chat.progress.title`；`chat.summary.label`。
- 移除的旧 chat.progress.* 单条式文案暂留在 dict 不动。

## 依赖
- `import { Progress } from "@/components/ui/progress"`（已存在）
- `import { Check, Loader2 } from "lucide-react"`

## 不改动
- 多轮澄清逻辑（`runIntro / submitAnswer / askNext / analyzeAndAskNext`）保持不变
- store、其它路由、其它组件保持不变
