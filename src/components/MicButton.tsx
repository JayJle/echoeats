import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";

type Props = {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "icon" | "default";
};

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const cands = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ];
  for (const m of cands) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return undefined;
}

export function MicButton({ onTranscript, disabled, className, size = "icon" }: Props) {
  const { t } = useT();
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [secs, setSecs] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => cleanup(), []);

  function cleanup() {
    try { recorderRef.current?.state !== "inactive" && recorderRef.current?.stop(); } catch { /* noop */ }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
  }

  async function start() {
    setErr(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setErr(t("err.mic.unsupported"));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => void handleStop(rec.mimeType || mime || "audio/webm");
      rec.start();
      setSecs(0);
      timerRef.current = window.setInterval(() => setSecs((s) => s + 1), 1000);
      setState("recording");
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "NotAllowedError") setErr(t("err.mic.denied"));
      else if (name === "NotFoundError") setErr(t("err.mic.notFound"));
      else if (name === "NotReadableError") setErr(t("err.mic.busy"));
      else setErr(t("err.mic.unknown", { detail: (e as Error).message || String(e) }));
      cleanup();
      setState("idle");
    }
  }

  async function handleStop(mimeType: string) {
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    if (blob.size < 1024) {
      setErr(t("err.mic.empty"));
      setState("idle");
      return;
    }
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

  return (
    <div className={className}>
      <Button
        type="button"
        variant={isRec ? "default" : "outline"}
        size={size}
        disabled={disabled || isTx}
        onClick={isRec ? stop : start}
        aria-label={isRec ? t("step3.mic.stop") : t("step3.mic.start")}
        title={isRec ? t("step3.mic.stop") : t("step3.mic.start")}
        style={isRec ? { animation: "mic-ring 1.4s ease-out infinite" } : undefined}
      >
        {isTx ? <Loader2 className="w-4 h-4 animate-spin" />
          : isRec ? <Square className="w-4 h-4" />
          : <Mic className="w-4 h-4" />}
      </Button>
      {(isRec || isTx || err) && (
        <p className="text-xs text-muted-foreground mt-1">
          {isRec ? t("step3.mic.recording", { s: secs })
            : isTx ? t("step3.mic.transcribing")
            : err}
        </p>
      )}
    </div>
  );
}
