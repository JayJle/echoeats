import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n/context";

type Props = {
  onTranscript: (text: string) => void;
  variant?: "hero" | "compact";
  disabled?: boolean;
  className?: string;
};

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && "ontouchend" in document);
  const cands = isIOS
    ? ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm"]
    : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const m of cands) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return undefined;
}

export function VoiceInput({ onTranscript, variant = "hero", disabled, className }: Props) {
  const { t } = useT();
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [secs, setSecs] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [level, setLevel] = useState(0); // 0..1 RMS smoothed

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);
  const autoStopRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => () => cleanup(), []);

  function stopAnalyser() {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    try { sourceRef.current?.disconnect(); } catch { /* noop */ }
    try { analyserRef.current?.disconnect(); } catch { /* noop */ }
    void audioCtxRef.current?.close().catch(() => { /* noop */ });
    sourceRef.current = null;
    analyserRef.current = null;
    audioCtxRef.current = null;
    setLevel(0);
  }

  function startAnalyser(stream: MediaStream) {
    try {
      const AC: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      sourceRef.current = source;
      analyserRef.current = analyser;
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        // amplify a bit so ordinary speech shows movement
        const norm = Math.max(0, Math.min(1, rms * 4));
        setLevel(norm);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch { /* analyser is optional */ }
  }

  function cleanup() {
    stopAnalyser();
    try { if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop(); } catch { /* noop */ }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
    if (autoStopRef.current) { window.clearTimeout(autoStopRef.current); autoStopRef.current = null; }
  }

  function start() {
    setErr(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setErr(t("err.mic.unsupported"));
      return;
    }
    // call getUserMedia synchronously in the user-gesture tick (iOS Safari)
    const p = navigator.mediaDevices.getUserMedia({ audio: true });
    p.then((stream) => {
      streamRef.current = stream;
      const mime = pickMime();
      let rec: MediaRecorder;
      try {
        rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch {
        setErr(t("err.mic.initFail"));
        cleanup();
        setState("idle");
        return;
      }
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => void handleStop(rec.mimeType || mime || "audio/webm");
      rec.start();
      startAnalyser(stream);
      setSecs(0);
      timerRef.current = window.setInterval(() => setSecs((s) => s + 1), 1000);
      autoStopRef.current = window.setTimeout(() => { try { rec.stop(); } catch { /* noop */ } }, 60_000);
      setState("recording");
    }).catch((e: unknown) => {
      const name = (e as { name?: string })?.name;
      if (name === "NotAllowedError") setErr(t("err.mic.denied"));
      else if (name === "NotFoundError") setErr(t("err.mic.notFound"));
      else if (name === "NotReadableError") setErr(t("err.mic.busy"));
      else setErr(t("err.mic.unknown", { detail: (e as Error).message || String(e) }));
      cleanup();
      setState("idle");
    });
  }

  async function handleStop(mimeType: string) {
    stopAnalyser();
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
    if (autoStopRef.current) { window.clearTimeout(autoStopRef.current); autoStopRef.current = null; }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    if (blob.size < 1024) { setErr(t("err.mic.empty")); setState("idle"); return; }
    setState("transcribing");
    try {
      const ext = mimeType.includes("mp4") ? "mp4"
        : mimeType.includes("ogg") ? "ogg"
        : mimeType.includes("wav") ? "wav"
        : mimeType.includes("mpeg") || mimeType.includes("mp3") ? "mp3"
        : "webm";
      const fd = new FormData();
      fd.append("audio", new File([blob], `voice.${ext}`, { type: mimeType }));
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      if (!res.ok) {
        if (res.status === 429) setErr(t("err.transcribe.busy"));
        else if (res.status === 402) setErr(t("err.transcribe.elevenQuota"));
        else setErr(t("err.transcribe.fail"));
        setState("idle");
        return;
      }
      const data = (await res.json()) as { text?: string };
      const text = (data.text || "").trim();
      if (!text) { setErr(t("err.transcribe.noContent")); setState("idle"); return; }
      onTranscript(text);
      setState("idle");
    } catch {
      setErr(t("err.transcribe.network"));
      setState("idle");
    }
  }

  function stop() {
    const r = recorderRef.current;
    if (r && r.state !== "inactive") r.stop();
  }

  const isRec = state === "recording";
  const isTx = state === "transcribing";

  if (variant === "compact") {
    return (
      <button
        type="button"
        disabled={disabled || isTx}
        onClick={isRec ? stop : start}
        aria-label={isRec ? t("step3.mic.stop") : t("step3.mic.start")}
        className={
          "inline-flex items-center justify-center w-10 h-10 rounded-full border transition-colors " +
          (isRec ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted border-border text-foreground") +
          (className ? " " + className : "")
        }
      >
        {isTx ? <Loader2 className="w-4 h-4 animate-spin" />
          : isRec ? <Square className="w-4 h-4" />
          : <Mic className="w-4 h-4" />}
      </button>
    );
  }

  // Hero: big mic with reactive volume ring + equalizer
  const ringScale = isRec ? 1 + level * 0.55 : 1;
  const ringOpacity = isRec ? 0.25 + level * 0.55 : 0;
  const barHeights = [0, 1, 2, 1, 0].map((offset) => {
    const base = isRec ? 4 + level * 28 : 4;
    return Math.max(4, Math.min(32, base + offset * (isRec ? level * 6 : 0)));
  });

  return (
    <div className={"flex flex-col items-center gap-3 " + (className ?? "")}>
      <div className="relative">
        <div
          aria-hidden
          className="absolute inset-0 rounded-full bg-primary/30 pointer-events-none transition-transform duration-100"
          style={{ transform: `scale(${ringScale})`, opacity: ringOpacity }}
        />
        <button
          type="button"
          disabled={disabled || isTx}
          onClick={isRec ? stop : start}
          aria-label={isRec ? t("step3.mic.stop") : t("step3.mic.start")}
          className={
            "relative inline-flex items-center justify-center rounded-full w-24 h-24 sm:w-28 sm:h-28 transition-transform active:scale-95 disabled:opacity-60 " +
            "bg-primary text-primary-foreground shadow-md hover:shadow-lg"
          }
        >
          {isTx ? <Loader2 className="w-9 h-9 animate-spin" />
            : isRec ? <Square className="w-9 h-9" />
            : <Mic className="w-10 h-10" />}
        </button>
      </div>

      {/* equalizer bars, only shown while recording */}
      <div className="h-8 flex items-end justify-center gap-1" aria-hidden>
        {isRec ? barHeights.map((h, i) => (
          <span
            key={i}
            className="w-1.5 rounded-full bg-primary/70 transition-all duration-75"
            style={{ height: `${h}px` }}
          />
        )) : null}
      </div>

      <div className="text-center min-h-[2.5rem]">
        <p className="text-base font-medium">
          {isRec ? t("step3.voice.listening")
            : isTx ? t("step3.mic.transcribing")
            : t("step3.voice.cta")}
        </p>
        {!isRec && !isTx && !err && (
          <p className="text-xs text-muted-foreground mt-1">{t("step3.voice.sub")}</p>
        )}
        {isRec && (
          <p className="text-xs text-muted-foreground mt-1">{t("step3.mic.recording", { s: secs })}</p>
        )}
        {err && !isRec && !isTx && (
          <p className="text-xs text-destructive mt-1" role="alert">{err}</p>
        )}
      </div>
    </div>
  );
}
