## 目标
把 `NeedBubbles` 从"静态 chip + 点击补位"改成"横向滚动跑马灯（从右进、从左出）"，点击泡泡仍然追加到输入框，并大幅扩充词库。

## 改动范围
只动两个文件，零业务逻辑变化：
- `src/components/NeedBubbles.tsx` —— 重写交互
- `src/routes/requirements.tsx` —— 不变（`appendBubble` 已经正确）；如需调整布局间距再微调

## 1. 词库扩充（约 30+ 条，分组覆盖更多筛选维度）
在 `POOL` 中加入以下类别，保证一屏跑马灯内容丰富：

- 价位：`人均 100 元以内`、`人均 200 元以内`、`人均 500+ 高端`、`性价比高`
- 评分/口碑：`谷歌评分 4.0 以上`、`必比登推荐`、`米其林`、`本地人爱去`、`不要游客店`
- 氛围：`适合约会`、`安静能聊天`、`氛围有格调`、`适合商务`、`适合带小孩`、`适合多人聚餐`
- 位置：`靠近地铁`、`在商场里`、`步行可达`、`有停车位`
- 体验：`有包间`、`可以预约`、`不用排队`、`有英文菜单`、`有中文菜单`、`室外座位`、`夜里也开`
- 食材/出品：`食材新鲜`、`现做现卖`、`分量足`、`摆盘精致`、`辣度可调`、`有素食选项`
- 菜品偏好：`推荐刺身`、`想吃烧鸟`、`想配清酒`、`招牌菜必点`、`适合拍照`

## 2. 跑马灯实现（纯 CSS，稳）
- 容器：`relative overflow-hidden` + 左右两侧渐隐遮罩（`mask-image: linear-gradient(to right, transparent, black 8%, black 92%, transparent)`），高度固定一行（约 48px）。
- 内部一个 `flex gap-3` 跑道，把"词库 × 2"渲染两遍首尾相接，用 CSS `@keyframes marquee { from { transform: translateX(0) } to { transform: translateX(-50%) } }`，`animation: marquee 60s linear infinite`。
- hover / 任一泡泡进入 `:focus-within` 时 `animation-play-state: paused`，方便用户瞄准点击。
- 单个泡泡：`rounded-full border bg-card text-sm px-4 py-2 shrink-0 hover:bg-primary/10 hover:border-primary hover:-translate-y-0.5 transition`。
- 点击：
  1. `onPick(text)` 追加到 textarea（沿用现有 `appendBubble`）。
  2. 给该按钮 200ms `animate-out zoom-out-75 fade-out`，结束后保持空位（跑马灯继续滚动，不补位 —— 因为词库循环本身就够多了）。
  3. 同时把该 text 加入一个 `Set<string>`（state），渲染时被点过的词渲染成 `opacity-30 line-through pointer-events-none`，表示"已加入"，避免重复点击；用户清空 textarea 不重置（这是灵感提示，不是必选）。
- 移动端（440px）：跑马灯保持单行，字号 `text-xs`，速度略快或保持 60s（默认就 OK）。

## 3. styles.css
新增一段：
```
@keyframes marquee {
  from { transform: translateX(0); }
  to   { transform: translateX(-50%); }
}
```
不动其它 token、不动 `mic-ring`。

## 4. 不动的部分
- 麦克风按钮、textarea、标题、搜索按钮、loading 卡片、store、AI prompt、路由、`/index` 测试入口。
- `requirements.tsx` 内 `<NeedBubbles onPick={appendBubble} />` 一行不变。

## 验收
- `/requirements`：标题下方一条横向滚动的泡泡带，从右进、从左消失，循环不断。
- 鼠标悬停带子或单个泡泡时滚动暂停，方便点击。
- 点击泡泡：文字立刻追加到 textarea（多个用 `、` 分隔），该泡泡缩小淡出并在后续滚动中以"灰色删除线"状态出现（防重复）。
- 移动端 440px：单行不溢出，字号清晰，不挡麦克风按钮。
- 词库至少 30 条，覆盖价位/评分/氛围/位置/体验/食材/菜品 7 类。
