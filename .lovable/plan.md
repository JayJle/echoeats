# 让进度条更动态 + 提前展示需求拆解

只改 `src/routes/requirements.tsx`（前端展示层），不动后端逻辑。

## 1) 进度条不再"卡住"——平滑前进 + 子进度

现状：`progressValue` 只在切 stage 时跳一次（25% → 50% → …），中间长时间不动，用户感觉卡死。

改造方案（用真实信号 + 兜底蠕动）：

**A. 给每个 stage 配一个 [start, end] 百分比区间**（deep 模式举例）
```
parse    : 0   → 8
search   : 8   → 25
reviews  : 25  → 80
rank     : 80  → 100
```
quick 模式（无 reviews）按比例重排。

**B. 利用后端已有的子进度信号细化区间内位置**
- `reviews` 阶段后端会发 `review-progress / tabelog-progress / yelp-progress`（带 `done / total`）。把这三路 max(done/total) 映射到 [25, 80] 区间，进度条就会随每条评论返回真正前进。
- `search`、`rank` 阶段后端只发 stage + heartbeat，没有 done/total，用 C 兜底。

**C. 无子进度的阶段用"渐近蠕动"动画**
- 新建 `targetProgress`（来自 A/B 的真实值）和 `displayProgress`（实际渲染值）。
- `requestAnimationFrame` 每帧把 `displayProgress` 向 `targetProgress` 靠拢：`display += (target - display) * 0.05`。
- 当某个阶段长时间没新 chunk（heartbeat 或无消息），让 `targetProgress` 以每秒约 1.5% 的速度向"当前 stage 区间的 90% 处"渐近爬升（永远不到 100%，避免到顶后真完成无变化）。新 chunk 到达时 `targetProgress` 立刻校正到真实值。
- 收到 heartbeat 时给 target 一个非常小的微推（+0.3%），让 UI 永远有反馈。

**D. 收尾**
- 拿到最终 `response` 后 `targetProgress = 100`，让动画顺滑收尾再 `navigate`（约 200ms 延迟）。

效果：进度条始终在动，但绝大多数前进都来自真实信号；只有完全没信号的窗口才"假装"慢慢爬。

## 2) 解析完成后立刻展示拆解出的标签

现状：`parseFn` 返回后直接进入 search，用户看不到 AI 怎么理解需求。

改造：
- 新增 `parsedPreview` state，类型 `ParsedRequirements | null`。
- `parseFn` resolve 后立即 `setParsedPreview(parsed)`，再继续 search。
- 在 loading 面板（`stages` 列表下方）追加一块"已识别需求"区域，仅当 `parsedPreview` 存在时显示。
- 展示内容（**只展示标签，不展示原文 freeText，不展示权重数值**）：
  - `city · cuisines`（cuisines 推断的加 ✨）
  - `hardFilters[].text`、`softPreferences[].text`、`negativeFilters[].text`、`dishPreferences[]`
  - 复用 results 页同款 chip 配色（primary / secondary / destructive / accent），但去掉 `· weight`
- 分组标题用现有 i18n key：`results.hardFilters / results.softPrefs / results.negative / results.dishes`。
- 取消或出错时 `setParsedPreview(null)` 清理。
- 加 `animate-fade-in` 让它出现得自然。

## 技术细节

**新增 state / refs（`runSearch` 内/组件内）**
- `const [displayProgress, setDisplayProgress] = useState(0);`
- `const targetProgressRef = useRef(0);`
- `const lastChunkAtRef = useRef<number>(0);`
- `const rafProgressRef = useRef<number | null>(null);`
- `const [parsedPreview, setParsedPreview] = useState<ParsedRequirements | null>(null);`

**stage 区间表**
```ts
const STAGE_RANGES_DEEP = { parse:[0,8], search:[8,25], reviews:[25,80], rank:[80,100] };
const STAGE_RANGES_QUICK = { parse:[0,12], search:[12,55], rank:[55,100] };
```

**核心动画循环**（mount/卸载注册一次；loading 期间运行）
```ts
const tick = () => {
  const now = performance.now();
  const [lo, hi] = currentRangeRef.current;
  // 兜底蠕动：>800ms 没新 chunk 就向 hi*0.9 处缓慢爬
  if (now - lastChunkAtRef.current > 800) {
    const ceiling = lo + (hi - lo) * 0.9;
    targetProgressRef.current = Math.min(
      ceiling,
      targetProgressRef.current + 0.025,   // 每帧≈1.5%/s
    );
  }
  setDisplayProgress((d) =>
    d + (targetProgressRef.current - d) * 0.08,
  );
  rafProgressRef.current = requestAnimationFrame(tick);
};
```

**chunk 处理（替换现有 onProgress）**
```ts
const bumpTarget = (v: number) => {
  targetProgressRef.current = Math.max(targetProgressRef.current, v);
  lastChunkAtRef.current = performance.now();
};
// stage 切换：target 跳到该 stage 区间起点
// review/tabelog/yelp-progress：target = lo + (done/total)*(hi-lo)，取三路最大
// heartbeat：target += 0.3，clamp 到 hi*0.95
```

**`Progress` 组件**
- `value={displayProgress}` 替代 `value={progressValue}`。
- 进度条本身已带 CSS transition；我们再叠 rAF 平滑后会非常稳。

**parsedPreview UI（插入到 `<ul>` stages 列表上方或下方均可，建议下方"已识别需求"）**
```tsx
{parsedPreview && (
  <div className="animate-fade-in border-t border-border/60 pt-3 space-y-2">
    <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
      {t("step3.parsedPreview")}  // 新增 i18n
    </p>
    {/* city + cuisines chips */}
    {/* hard / soft / neg / dish chips —— 只渲染 .text */}
  </div>
)}
```

**i18n 新增**（`src/lib/i18n/dict.ts`）
- `step3.parsedPreview`: "AI 已理解的需求" / "What we understood"

**清理**
- `runSearch` 开头 `setParsedPreview(null)`、`targetProgressRef.current = 0`、`setDisplayProgress(0)`、`lastChunkAtRef.current = performance.now()`、启动 rAF。
- `finally` / `handleCancel` / 出错路径：`cancelAnimationFrame(rafProgressRef.current)`、`setParsedPreview(null)`。

## 不动的地方
- 后端 `echo.functions.ts`、流协议、`consumeSearchStream` 都不改。
- `results.tsx`、store、其他组件不改。
- 现有 `currentStage / currentIndex / stages` 仍保留用于步骤列表 UI，仅把 `progressValue` 替换为 `displayProgress`。
