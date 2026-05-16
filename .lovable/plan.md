## 问题
1. **看不到泡泡**：`bg-primary/10` 叠在奶油色 card 上对比度太低，加上 `text-foreground/85`，几乎看不见；自定义 `@keyframes` + absolute 定位还可能因为 HMR / Tailwind v4 没识别而完全消失。
2. **点了不追加**：用户反馈点击后泡泡只是消失、文字没进输入框。代码里 `onPick(b.text)` 确实先于 popping 调用，逻辑上没问题；但如果 NeedBubbles 整段因为 CSS 故障被裁切到 0 高度，看到的「破裂」实际上是空气，自然也不会有文字。两件事很可能同一个根因——视觉层崩了。

## 方案
重写 `src/components/NeedBubbles.tsx`，砍掉 absolute + 自定义 keyframes 这套脆弱玩法，改成更稳的实现：

### 1. 布局：flex-wrap 居中
- 容器 `flex flex-wrap items-center justify-center gap-2 min-h-[120px]`，泡泡像 chip 一样自然排开，移动端 440px 也不会溢出。
- 不再依赖 absolute 定位 / 百分比 / overflow-hidden，移动端绝对可见。

### 2. 视觉：清晰可见的胶囊
- 背景 `bg-card`，边框 `border-primary/40`，文字 `text-foreground`，hover `bg-primary/10 border-primary`。
- 圆角 `rounded-full`，padding `px-4 py-2`，字号 `text-sm`。
- 给胶囊加柔和阴影 `shadow-sm`，hover 时 `shadow-md` + 轻微 `scale-105`（用 `transition-all`）。
- 三档尺寸保留，但只通过 padding/字号微调（sm/md/lg），不动定位。

### 3. 动画：用 Tailwind 内置 + 简单 keyframe
- 出现：`animate-in fade-in zoom-in-75 duration-300`（tailwindcss-animate 已在项目里，看 styles.css 第 3 行 `tw-animate-css`）。
- 破裂：用 React state 切到 `animate-out fade-out zoom-out-0 duration-200`，200ms 后从数组移除并补一个新泡泡。
- 漂浮：可选——给容器外层加一个极轻的 `animate-pulse` 替代复杂浮动，或者干脆不浮动（用户重点是「能点 → 进输入框」，飘动只是锦上添花）。先做静态版+破裂动画，确认能用再加浮动。

### 4. 词库与补位
保留现有词库；维护 `bubbles: {id, text, size, leaving?: boolean}[]`，初始 6 条；点击：
- `onPick(text)` 立刻调用 → 父组件 setValue 追加；
- 标记该 bubble `leaving=true` 触发 zoom-out 动画；
- 200ms 后 setState 用一条新随机文案替换该 id 的 bubble（保持总数 6）。

### 5. 父组件 (`requirements.tsx`) 不动
`appendBubble` 已经正确：`setValue((v) => v.trim() ? \`${v}、${text}\` : text)`。只需要确认 NeedBubbles 真的调到了它。本次重写后会调到。

### 6. 清理 styles.css 里的死代码
顺手删掉上次加的 `bubble-float / bubble-rise-in / bubble-pop` 三个 @keyframes（保留 `mic-ring`，麦克风按钮还在用）。

## 不动 / 不做
- 不动麦克风占位按钮（工作正常）。
- 不动 textarea / 标题 / 搜索按钮。
- 不动业务逻辑、store、AI prompt。
- 不接真实语音识别。

## 验收
- 打开 `/requirements`：标题下方立刻看见 6 个明显的胶囊泡泡（白底深字描边，对比度足够）。
- 点任意泡泡：泡泡缩小淡出（约 200ms），同时 textarea 立刻多出该条文案（多次点击用「、」分隔，已有用户输入时追加在末尾）。
- 泡泡消失后大约 200ms 内有新泡泡淡入补位，词库不重复。
- 移动端 440px 不溢出、不挡按钮。
- 麦克风按钮、深度/快速搜索、返回链接、loading 卡片全部行为不变。
