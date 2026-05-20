
# Voice input: live volume meter + prominent UI

Two changes on `src/routes/requirements.tsx` (and a small i18n addition). No backend changes.

## 1. Live volume indicator while recording

Hook the existing `MediaStream` into the Web Audio API so the mic button visualizes the user's voice in real time.

- When `toggleRecording()` acquires the stream, also create:
  - `AudioContext` → `MediaStreamSource` → `AnalyserNode` (fftSize 256, smoothingTimeConstant 0.7)
  - A `requestAnimationFrame` loop that reads `getByteTimeDomainData`, computes RMS, and stores a normalized 0–1 level in a `useState` (`level`) — throttled to ~30fps.
- On stop / error / unmount: cancel the rAF, disconnect the analyser, and `audioContext.close()` (add to existing cleanup effect).
- Visual: replace the static pulsing ring with a reactive one.
  - Outer ring: a second absolutely-positioned circle behind the button whose `scale` and `opacity` are driven by `level` (e.g. `scale(1 + level * 0.6)`, `opacity 0.25 + level * 0.5`) via inline `style`. Uses `bg-primary/30` so it inherits theme.
  - Inner ring: keep `mic-ring` keyframe as the always-on idle pulse fallback when `level` is near 0.
  - Optional 5-bar equalizer under the button (each bar height = `level` scaled with a per-bar offset) — small, only visible while `recording`.
- Keep the existing elapsed seconds counter; show it next to the level bars.

## 2. Highlight voice input to encourage use

Promote the mic from a corner button inside the textarea to a primary affordance above it, while keeping the textarea for typing.

- New `VoiceInputCard` block rendered above the `<Textarea>` (still inside the form, replaces the absolute-positioned mic):
  - Large circular mic button (h-16/w-16) centered, with a soft glow ring (`shadow-[0_0_0_8px_hsl(var(--primary)/0.15)]` and a subtle `animate-pulse` halo when idle).
  - Headline: `t("step3.voice.cta")` — e.g. "Tap to speak your needs" / "点按说出你的需求".
  - Subtext: `t("step3.voice.sub")` — e.g. "Faster than typing — say budget, vibe, dishes…".
  - A small "NEW" / recommended chip (`Badge variant="secondary"`) with a Sparkles icon to draw the eye.
  - While recording: button turns destructive, reactive ring + 5-bar equalizer appear, elapsed timer shown, label switches to "Listening…" / "Tap to stop".
  - While transcribing: spinner + "Transcribing…".
- Below this card, a subtle divider with "or type below" text leading into the existing textarea (textarea keeps `pr-3` since mic is no longer overlapping).
- First-visit nudge: a one-time `toast.message` with the mic icon on mount of `/requirements` (gated by `localStorage.getItem("ee_voice_tip_seen")`) suggesting "Try voice — it's faster". Auto-dismiss in 5s.

## 3. i18n strings

Add to `src/lib/i18n/dict.ts` under existing `step3.*`:
- `step3.voice.cta`, `step3.voice.sub`, `step3.voice.badge`, `step3.voice.listening`, `step3.voice.orType`, `step3.voice.firstTip`
(EN + ZH).

## Technical notes

- All audio analysis is client-side; no new deps.
- `AudioContext` must be created after `getUserMedia` resolves (user gesture satisfied) to satisfy autoplay policies, including iOS Safari.
- Use refs for `AudioContext`, `AnalyserNode`, and the rAF handle so re-renders don't recreate them. Only the `level` state re-renders.
- Throttle `setLevel` to ~30fps using a `lastTs` ref to avoid React render storms.
- The reactive ring uses inline `transform`/`opacity` style (not Tailwind classes) since values are continuous. The static glow + halo use design tokens (`bg-primary`, `text-primary-foreground`, `shadow-*`) — no hard-coded colors.
- Cleanup must run in: `onstop`, error branches in `toggleRecording`, the existing unmount `useEffect`, and `handleCancel`.

## Files touched

- `src/routes/requirements.tsx` — mic UI restructure, analyser hookup, cleanup.
- `src/lib/i18n/dict.ts` — new strings (EN + ZH).
