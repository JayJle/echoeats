## 语音输入功能（ElevenLabs Scribe 批量转写）

### 体验
点麦克风开始录 → 红色脉冲 + 显示「🎙 录音中 0:03」→ 再点一下停止 → 按钮变「识别中…」转圈 → 1–3 秒后把识别文字**追加到 textarea 末尾**（已有内容则前面加「、」分隔）。失败有 toast 提示。

跟 ChatGPT 体验对齐：自动识别中/日/英混说，无需选语言。

### 改动

**1. 接入 ElevenLabs Connector**
调用 `standard_connectors--connect('elevenlabs')`，让用户选/建一个连接。链接后项目自动拿到 `ELEVENLABS_API_KEY` 环境变量。无需手动 add_secret。

**2. 新增服务端路由** `src/routes/api/transcribe.ts`
- `POST` 接收 `multipart/form-data`，字段 `audio`（webm/ogg/mp3 任意）
- 校验文件大小 ≤ 25 MB
- 转发给 ElevenLabs `https://api.elevenlabs.io/v1/speech-to-text`：
  - `model_id=scribe_v2`
  - `tag_audio_events=false`
  - `diarize=false`
  - **不传 `language_code`**（自动检测，支持中日英混说）
- 返回 `{ text: string, language?: string }`
- 错误处理：缺 key → 500；429/402 透传；其它 → 500 + 简短 message

**3. 改造 `src/routes/requirements.tsx` 麦克风按钮**

替换现有 `toggleRecording` 占位逻辑：

- 新状态：`recording`（录音中）、`transcribing`（上传识别中）、`mediaRecorderRef`、`chunksRef`、`recordStartRef`、`elapsed`（用于显示秒数）
- 点击开始：
  1. `navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })`
  2. 失败 → toast「请开启麦克风权限」并复位
  3. 成功 → `new MediaRecorder(stream, { mimeType: 'audio/webm' })`，`ondataavailable` 推入 chunks，`start()`，开始秒数计时
- 点击停止：
  1. `recorder.stop()` + 关掉所有 track
  2. `onstop` 里把 chunks 拼成 Blob，进入 `transcribing` 状态
  3. `FormData` 上传到 `/api/transcribe`
  4. 成功 → `setValue(v => v.trim() ? \`${v.replace(/[、，,]\s*$/, '')}、${text}\` : text)`
  5. 失败 → toast 错误（区分 429「请求过频」、402「额度用尽」、其它）
- 录音中按钮显示 `<Square />` + 红色脉冲（已有），下方文字改成 `录音中 0:03`
- 识别中按钮 disabled + 显示 `<Loader2 className="animate-spin" />`，下方文字「识别中…」
- 自动安全限制：录音超过 60 秒自动停止并上传（避免无意义的大文件）

**4. 浏览器兼容性说明**
- `MediaRecorder` + `audio/webm` Chrome/Edge/Firefox/Safari 16.4+ 都支持。Safari < 16.4 兜底用 `audio/mp4`（探测 `MediaRecorder.isTypeSupported`），都不支持就 disable 按钮并 toast「当前浏览器不支持录音」。

### 不动
parseRequirements、searchRestaurants、其它 UI、results 页面。

### 验证
1. 桌面 Chrome：点录音 → 说「想吃居酒屋,人均一万日元,不要烟味」→ 停 → 1–2 秒后 textarea 末尾出现识别文字
2. 中日英混说：「我想去 cozy 的 izakaya 居酒屋」→ 应一次性正确识别
3. 拒绝麦克风权限 → toast 提示，按钮回到初始
4. iOS Safari 17：能录音、能识别
