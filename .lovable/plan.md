## 范围

只改 `src/routes/requirements.tsx`，不动后端、不动业务逻辑、不动结果页。

后端 places/rank 嵌在 `Promise.all` 里，要 emit 子进度必须改并发结构，风险高，按你"不能影响功能"的原则**不动**。reviews 阶段已经有真实 `review-progress / tabelog-progress / yelp-progress`，本身就是真进度，保留。

## 改动

### 1. 替换进度条动画核心

把指数缓动 + 静默蠕动 + heartbeat 跳跃这三个机制全部移除，换成**恒速 + 软上限 + 抖动**：

```text
每帧：
  dt = now - lastFrameAt
  v_base = (hi - lo) / stageExpectedMs        # 走完当前阶段的速度
  v = v_base * jitter                          # ±20% 抖动，每 ~500ms 换一次
  ceiling = min(target, hi - 0.5)              # target 是软上限
  if display < ceiling: display += v * dt
  else:                  display += v * dt / 6 # 超过上限时减速 1/6 继续爬，永远不停
  display = min(display, hi - 0.1)             # 不越界到下一阶段
```

抖动：`factor = 1 + (Math.random() - 0.5) * 0.4`，每 500ms 重抽一次。让速度看起来不规律，但平均值还是按 expectedMs 走。

### 2. 每个阶段配期望时长

```text
deep:  parse 4s, search 8s, reviews 30s, rank 8s
quick: parse 4s, search 6s, reviews 6s,  rank 5s
```

阶段切换时：`currentRangeRef = [lo, hi]`，`stageExpectedMs = 对应时长`，`target = max(target, lo)`（不瞬移 display，让它自然走过去）。

### 3. 真实 chunk 只抬 target，不再直接动 display

- `review-progress / tabelog-progress / yelp-progress` → 更新各自 max，重算 `target = lo + maxFrac*(hi-lo)`。**只动 target**，display 由动画循环匀速逼近。
- `heartbeat` → 完全不再调整 target，仅作为存活信号（保留，因为后端用来防 edge gateway 切流，前端忽略即可）。
- 取消之前的"800ms 静默 +0.025 蠕动"——由"超 ceiling 后 1/6 速继续爬"自然替代，不会再有"先停后跳"的节奏。

### 4. 收尾

收到最终 response 后：

- `target = 100`，`stageExpectedMs = 600`，让 display 匀速走完最后一段。
- 用 `requestAnimationFrame` 轮询 `display >= 99.5` 时再 `navigate`；兜底最长 800ms 后强制跳。
- 不再用固定 220ms `setTimeout`，避免"还在爬就被打断"。

### 5. 不变的地方

- 解析逻辑、stream 协议、后端、结果页、取消/出错路径全部不动。
- `parsedPreview` 展示逻辑不动。
- `stopProgressLoop` 在 cancel/error/卸载时仍调用。

## 预期效果

- reviews 阶段：跟真实进度同步，速度由后端 done/total 控制。
- parse / search / rank：按各自 expectedMs 匀速走，超过 ceiling 后变慢但不停，下一个事件到达时无缝接力，**不会出现"推一点 → 停 → 跳一段"的固定节奏**。
- ±20% 速度抖动 + 阶段间速度天然不同，进一步打散视觉规律性。
- 网络慢/快都不会跳到 100 后再倒退，也不会卡在某点不动。