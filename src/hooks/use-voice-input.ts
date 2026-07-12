import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/context";

type Options = {
  onText: (text: string) => void;
  disabled?: boolean;
};

/**
 * 语音录音 + 上传 /api/transcribe 的复用 hook。
 * 从原 requirements 页抽出来，供 PlannerClarifyPanel 和 requirements 页共用。
 */
export function useVoiceInput({ onText, disabled }: Options) {
  const { t } = useT();
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const stopAnalyser = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try { sourceRef.current?.disconnect(); } catch { /* noop */ }
    try { analyserRef.current?.disconnect(); } catch { /* noop */ }
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => { /* noop */ });
    }
    sourceRef.current = null;
    analyserRef.current = null;
    audioCtxRef.current = null;
    setLevel(0);
  };

  const startAnalyser = (stream: MediaStream) => {
    try {
      const Ctx: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      sourceRef.current = source;
      analyserRef.current = analyser;
      const buf = new Uint8Array(analyser.fftSize);
      let lastTs = 0;
      const loop = (ts: number) => {
        rafRef.current = requestAnimationFrame(loop);
        if (ts - lastTs < 33) return;
        lastTs = ts;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        setLevel(Math.min(1, rms * 3));
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch (err) {
      console.warn("[mic] analyser init failed", err);
    }
  };

  const isIOS = () => {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    return /iPad|iPhone|iPod/.test(ua) ||
      (ua.includes("Mac") && typeof document !== "undefined" && "ontouchend" in document);
  };

  const pickMimeType = (): string | null => {
    if (typeof MediaRecorder === "undefined") return null;
    const candidates = isIOS()
      ? ["audio/mp4", "audio/aac", "audio/webm"]
      : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
    for (const mt of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(mt)) return mt;
      } catch { /* ignore */ }
    }
    return null;
  };

  const stopRecordingInternal = () => {
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") mr.stop();
  };

  const toggle = async () => {
    if (recording) {
      stopRecordingInternal();
      return;
    }
    if (transcribing || disabled) return;

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error(t("err.mic.unsupported"));
      return;
    }

    const ios = isIOS();
    const inIframe = typeof window !== "undefined" && window.self !== window.top;

    if (inIframe && !ios) {
      toast.error(t("err.mic.iframe"), {
        action: {
          label: t("err.mic.iframeAction"),
          onClick: () => window.open(window.location.href, "_blank", "noopener,noreferrer"),
        },
        duration: 8000,
      });
      return;
    }

    const constraints: MediaStreamConstraints = ios
      ? { audio: true }
      : { audio: { echoCancellation: true, noiseSuppression: true } };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      const name = (err as { name?: string })?.name || "";
      const msg = (err as { message?: string })?.message || "";
      console.error("getUserMedia failed:", name, msg, err);
      if (name === "NotAllowedError" || name === "SecurityError") {
        toast.error(
          inIframe
            ? t("err.mic.denied.iframe")
            : ios
              ? t("err.mic.denied.ios")
              : t("err.mic.denied"),
        );
      } else if (name === "NotFoundError") toast.error(t("err.mic.notFound"));
      else if (name === "NotReadableError") toast.error(t("err.mic.busy"));
      else toast.error(t("err.mic.unknown", { detail: name || msg || "?" }));
      return;
    }

    const mimeType = pickMimeType();
    chunksRef.current = [];
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (err) {
      console.error("MediaRecorder init failed:", err);
      stream.getTracks().forEach((tr) => tr.stop());
      toast.error(t("err.mic.initFail"));
      return;
    }
    const usedMime = recorder.mimeType || mimeType || "audio/webm";
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      stopAnalyser();
      stream.getTracks().forEach((tr) => tr.stop());
      setRecording(false);
      setElapsed(0);

      const blob = new Blob(chunksRef.current, { type: usedMime });
      chunksRef.current = [];
      if (blob.size === 0) {
        toast.error(t("err.mic.empty"));
        return;
      }

      setTranscribing(true);
      try {
        const fd = new FormData();
        const ext = usedMime.includes("mp4") || usedMime.includes("aac")
          ? "mp4"
          : usedMime.includes("ogg")
            ? "ogg"
            : "webm";
        fd.append("audio", blob, `audio.${ext}`);
        const res = await fetch("/api/transcribe", { method: "POST", body: fd });
        const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!res.ok) {
          if (res.status === 429) toast.error(t("err.transcribe.busy"));
          else if (res.status === 402) toast.error(t("err.transcribe.elevenQuota"));
          else toast.error(data.error || t("err.transcribe.fail"));
          return;
        }
        if (data.text) onText(data.text);
        else toast.error(t("err.transcribe.noContent"));
      } catch (err) {
        console.error("[mic] transcribe failed", err);
        toast.error(t("err.transcribe.network"));
      } finally {
        setTranscribing(false);
      }
    };

    try {
      recorder.start(500);
    } catch (err) {
      console.error("[mic] recorder.start failed", err);
      stream.getTracks().forEach((tr) => tr.stop());
      toast.error(t("err.mic.initFail"));
      return;
    }
    startAnalyser(stream);
    setRecording(true);
    setElapsed(0);
    const startedAt = Date.now();
    elapsedTimerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    autoStopTimerRef.current = setTimeout(() => stopRecordingInternal(), 60_000);
  };

  useEffect(() => () => {
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") mr.stop();
    stopAnalyser();
  }, []);

  return { recording, transcribing, elapsed, level, toggle };
}
