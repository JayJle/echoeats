## 目标
把 `/requirements` 页面（Step 3）改成更轻量、更有引导感的输入页：去掉啰嗦说明、加大语音入口、用「需求泡泡」帮用户起头。先做视觉/交互 demo，语音和泡泡都不接业务逻辑。

## 改动范围
只动 `src/routes/requirements.tsx`（必要时新建 `src/components/NeedBubbles.tsx`）。
不动 store、`echo.functions.ts`、搜索/排序/结果页逻辑。

---

## 1. 顶部精简
- 删除 placeholder（textarea 里的长例句）。
- 删除 hint「可跳过,先看结果再补充。预算、人数、氛围、菜品偏好、避雷……越具体越好」。
- 标题改成更直接的一句，候选：**「还想要点什么？」**（保留 StepShell 的 step=3/total=3 进度条）。
- textarea 高度可以略降（min-h-[120px]），不要 placeholder，聚焦时只是一个干净的空白框。

## 2. 需求泡泡区（新增，放在 textarea 上方）
位置：标题下方、textarea 上方。
玩法：
- 一次浮现 5~7 个泡泡，分散在一个固定高度区域（约 160~200px）里，做轻微上浮 + 左右飘动（CSS keyframes / Motion，纯展示用）。
- 每个泡泡是一条短需求文案（来自一个内置词库，长度 4~10 字）。
- 点击泡泡：
  - 泡泡播放「破裂」动画（scale → 0 + opacity → 0，约 250ms）；
  - 对应文案以「、」拼接追加到 textarea 当前内容末尾（不覆盖用户已输入文字）；
  - 200ms 后从词库随机抽一条没出现过的新需求，从底部浮上来补位，保持总数稳定。
- 词库示例（mock，写死在组件里即可）：
  - 不要游客店、人均 100 元以内、适合约会、安静能聊天、有包间、可预约、需要英文菜单、靠近地铁、本地人爱去、米其林必比登、适合拍照、室外座位、不排队、家庭友好、有素食选项、晚上 9 点后还开、辣度可调、推荐刺身、想吃烧鸟、想喝清酒。
- 视觉：圆形/胶囊形（rounded-full），背景用 `bg-primary/10` + `text-foreground`，边框 `border-primary/20`，hover 时 `bg-primary/15`。尺寸随机 3 档（sm/md/lg），让画面有节奏感。整体风格继续走当前简约暖色调。

容器：`relative` + `overflow-hidden`，内部用 `absolute` 定位 + transform 控制浮动；移动端（当前 viewport 440px）也要保证至少 4 个泡泡可见、不溢出。

## 3. 语音输入入口（占位）
位置：textarea 右下角内嵌一个大圆形麦克风按钮（约 56×56），primary 色，带柔和呼吸光晕（`shadow` + `animate-pulse` 的极轻版本）。
行为（demo 阶段）：
- 点击后切到「录音中」状态：按钮变成方形 stop 图标 + 红点 + 一个模拟的波形/三点动画；
- 再点一下停止；
- 不调用任何 Web Speech / 后端 API；停止后弹一个 toast：「语音输入即将上线」，不写入 textarea。
- 用 `lucide-react` 的 `Mic` / `Square` 图标；toast 用现有 `sonner`。
辅助：
- 在按钮下方加一行小字提示「按住说话（即将上线）」，`text-xs text-muted-foreground`，仅视觉。

## 4. 底部按钮区
保持现有「深度搜索 / 快速搜索 / ← 返回」三件套不动，只确认在新布局下间距协调（泡泡区 + textarea + 麦克风后整体不会过长，必要时把 form `space-y-6` 调成 `space-y-5`）。

---

## 技术细节（实现时参考）
- 新建 `src/components/NeedBubbles.tsx`，props：`onPick: (text: string) => void`。内部维护 `bubbles: {id, text, x%, size, delay}[]`，用 `useState` + `setTimeout` 控制破裂/补位。动画用纯 Tailwind + 内联 `style={{ animation: ... }}` 或加一段 keyframes 到 `src/styles.css`（`@keyframes bubble-float`）。
- `requirements.tsx` 里：
  - 删 placeholder/hint；
  - 在 `<Textarea>` 上方插 `<NeedBubbles onPick={(t) => setValue(v => v ? `${v}、${t}` : t)} />`；
  - 把 `<Textarea>` 包一层 `relative`，右下角 `absolute` 放麦克风按钮 + 占位 toast 逻辑；
  - 不改 `runSearch`、`useStoreHydrated` 守卫、loading 阶段卡片等任何业务代码。
- 颜色全部走 `src/styles.css` 的 token（primary / muted / border / foreground），不写裸 hex。

## 不动 / 不做
- 不接真实语音识别（Web Speech API、Whisper、第三方）。
- 不动词库 → AI prompt 的映射，泡泡只是往 textarea 里塞字符串。
- 不动 store 结构、不动 `parseRequirements` / `searchRestaurants`。
- 不动 `cuisines.tsx`、`index.tsx`、结果页。

## 验收
- 进入 `/requirements`：只看到标题「还想要点什么？」、上方 5~7 个轻浮动的需求泡泡、空白 textarea（无 placeholder）、右下角大麦克风按钮、底部原有的搜索按钮。
- 点泡泡：泡泡破裂消失，文案以「、」追加到 textarea，~200ms 后新泡泡从底部浮上来补位。
- 点麦克风：按钮切到录音态 → 再点停止 → toast「语音输入即将上线」，textarea 内容不变。
- 移动端（440px）布局不溢出、不挡到底部按钮；hydration 守卫仍然生效，刷新不会被踢回 `/`。
- 搜索流程（深度/快速）和现在完全一致。
