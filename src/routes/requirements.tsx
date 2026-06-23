import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Check, HelpCircle, Loader2, Mic, Sparkles, Square } from "lucide-react";
import { toast } from "sonner";
import { NeedBubbles } from "@/components/NeedBubbles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StepShell } from "@/components/StepShell";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useQueryStore, type ParsedRequirements } from "@/lib/store";
import { useT } from "@/lib/i18n/context";
import { useServerFn } from "@tanstack/react-start";
import { parseRequirements, searchRestaurants, consumeSearchStream } from "@/lib/echo.functions";

export const Route = createFileRoute("/requirements")({
  head: () => ({
    meta: [
      { title: "Echo Eats — Tell us your needs" },
      { name: "description", content: "Describe budget, vibe, dish preferences and dealbreakers in natural language. Optional." },
    ],
  }),
  component: StepRequirements,
});

type StageKey = "parse" | "search" | "reviews" | "rank";

const JP_CITIES = ["东京", "大阪", "京都", "札幌", "福冈", "名古屋", "横滨", "神户", "tokyo", "osaka", "kyoto", "sapporo", "fukuoka", "nagoya", "yokohama", "kobe"];

function reviewsHintKey(city: string): string {
  const c = city.toLowerCase();
  if (JP_CITIES.some((x) => c.includes(x.toLowerCase()))) return "stage.reviews.hint.jp";
  return "stage.reviews.hint.other";
}

function StepRequirements() {
  const navigate = useNavigate();
  const { lang, t } = useT();
  const city = useQueryStore((s) => s.city);
  const cuisines = useQueryStore((s) => s.cuisines);
  const autoInferCuisines = useQueryStore((s) => s.autoInferCuisines);

  const freeText = useQueryStore((s) => s.freeText);
  const setFreeText = useQueryStore((s) => s.setFreeText);
  const setParsed = useQueryStore((s) => s.setParsed);
  const setResults = useQueryStore((s) => s.setResults);

  const [value, setValue] = useState(freeText);
  const [loading, setLoading] = useState(false);
  const [currentStage, setCurrentStage] = useState<StageKey | null>(null);
  const [searchMode, setSearchMode] = useState<"quick" | "deep">("deep");
  const [error, setError] = useState<string | null>(null);
  const [inferredCuisines, setInferredCuisines] = useState<string[] | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);

  // —— 平滑进度条状态 ——
  const [displayProgress, setDisplayProgress] = useState(0);
  const targetProgressRef = useRef(0);
  const lastChunkAtRef = useRef<number>(0);
  const rafProgressRef = useRef<number | null>(null);
  const currentRangeRef = useRef<[number, number]>([0, 100]);
  const reviewMaxRef = useRef(0);
  const tabelogMaxRef = useRef(0);
  const yelpMaxRef = useRef(0);

  // —— 提前展示解析出的需求 ——
  const [parsedPreview, setParsedPreview] = useState<ParsedRequirements | null>(null);

  const parseFn = useServerFn(parseRequirements);
  const searchFn = useServerFn(searchRestaurants);

  useEffect(() => () => {
    timersRef.current.forEach(clearTimeout);
    abortRef.current?.abort();
  }, []);

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };

  const stages: { key: StageKey; label: string; hint: string }[] =
    searchMode === "deep"
      ? [
          { key: "parse", label: t("stage.parse.label"), hint: t("stage.parse.hint") },
          { key: "search", label: t("stage.search.label", { city: city || t("stage.search.placeholder") }), hint: t("stage.search.hintDeep") },
          { key: "reviews", label: t("stage.reviews.label"), hint: t(reviewsHintKey(city)) },
          { key: "rank", label: t("stage.rank.label"), hint: t("stage.rank.hintDeep") },
        ]
      : [
          { key: "parse", label: t("stage.parse.label"), hint: t("stage.parse.hint") },
          { key: "search", label: t("stage.search.label", { city: city || t("stage.search.placeholder") }), hint: t("stage.search.hintQuick") },
          { key: "rank", label: t("stage.rank.label"), hint: t("stage.rank.hintQuick") },
        ];

  const currentIndex = currentStage ? stages.findIndex((s) => s.key === currentStage) : -1;

  // —— 各 stage 在总进度条上占用的 [起点, 终点] 百分比 ——
  const STAGE_RANGES: Record<"deep" | "quick", Record<StageKey, [number, number]>> = {
    deep: {
      parse: [0, 8],
      search: [8, 25],
      reviews: [25, 80],
      rank: [80, 100],
    },
    quick: {
      parse: [0, 12],
      search: [12, 55],
      reviews: [12, 55], // quick 无 reviews，但避免 lookup 空
      rank: [55, 100],
    },
  };

  const setRangeForStage = (mode: "quick" | "deep", stage: StageKey) => {
    const [lo, hi] = STAGE_RANGES[mode][stage];
    currentRangeRef.current = [lo, hi];
    targetProgressRef.current = Math.max(targetProgressRef.current, lo);
    lastChunkAtRef.current = performance.now();
  };

  const startProgressLoop = () => {
    if (rafProgressRef.current != null) return;
    const tick = () => {
      const now = performance.now();
      const [lo, hi] = currentRangeRef.current;
      // 兜底蠕动：>800ms 没新 chunk → 缓慢向 hi*0.9 处爬升
      if (now - lastChunkAtRef.current > 800) {
        const ceiling = lo + (hi - lo) * 0.9;
        if (targetProgressRef.current < ceiling) {
          targetProgressRef.current = Math.min(
            ceiling,
            targetProgressRef.current + 0.025,
          );
        }
      }
      setDisplayProgress((d) => {
        const next = d + (targetProgressRef.current - d) * 0.08;
        return Math.abs(next - targetProgressRef.current) < 0.05
          ? targetProgressRef.current
          : next;
      });
      rafProgressRef.current = requestAnimationFrame(tick);
    };
    rafProgressRef.current = requestAnimationFrame(tick);
  };

  const stopProgressLoop = () => {
    if (rafProgressRef.current != null) {
      cancelAnimationFrame(rafProgressRef.current);
      rafProgressRef.current = null;
    }
  };

  useEffect(() => () => stopProgressLoop(), []);

  const runSearch = async (text: string, mode: "quick" | "deep" = "deep") => {
    setError(null);
    setLoading(true);
    setSearchMode(mode);
    setFreeText(text);
    setInferredCuisines(null);
    setParsedPreview(null);
    runIdRef.current += 1;
    const myRunId = runIdRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    // 重置进度
    targetProgressRef.current = 0;
    setDisplayProgress(0);
    reviewMaxRef.current = 0;
    tabelogMaxRef.current = 0;
    yelpMaxRef.current = 0;
    lastChunkAtRef.current = performance.now();
    startProgressLoop();

    try {
      setCurrentStage("parse");
      setRangeForStage(mode, "parse");
      const parsed = await parseFn({
        data: { city, cuisines, autoInferCuisines, date: "", freeText: text, uiLanguage: lang },
        signal: ac.signal,
      } as Parameters<typeof parseFn>[0]);
      if (myRunId !== runIdRef.current || ac.signal.aborted) return;
      const parsedWithMode = { ...parsed, mode, uiLanguage: lang };
      setParsed(parsedWithMode);
      setParsedPreview(parsed);
      if (parsed.cuisinesInferred && parsed.cuisines.length > 0) {
        setInferredCuisines(parsed.cuisines);
      }

      setCurrentStage("search");
      setRangeForStage(mode, "search");
      clearTimers();

      const bumpTarget = (v: number) => {
        targetProgressRef.current = Math.max(targetProgressRef.current, v);
        lastChunkAtRef.current = performance.now();
      };
      const computeReviewsTarget = () => {
        const [lo, hi] = STAGE_RANGES[mode].reviews;
        const frac = Math.max(
          reviewMaxRef.current,
          tabelogMaxRef.current,
          yelpMaxRef.current,
        );
        return lo + Math.min(1, frac) * (hi - lo);
      };

      const iter = await searchFn({
        data: parsedWithMode,
        signal: ac.signal,
      } as Parameters<typeof searchFn>[0]);
      const response = await consumeSearchStream(iter, (chunk) => {
        if (myRunId !== runIdRef.current || ac.signal.aborted) return;
        if (chunk.type === "stage") {
          if (chunk.stage === "places" || chunk.stage === "places-done") {
            setCurrentStage("search");
            setRangeForStage(mode, "search");
          } else if (
            chunk.stage === "reviews" ||
            chunk.stage === "tabelog" ||
            chunk.stage === "yelp" ||
            chunk.stage === "photos"
          ) {
            setCurrentStage("reviews");
            setRangeForStage(mode, "reviews");
          } else if (chunk.stage === "rank" || chunk.stage === "rank-fallback") {
            setCurrentStage("rank");
            setRangeForStage(mode, "rank");
          }
        } else if (chunk.type === "review-progress") {
          if (chunk.total > 0) reviewMaxRef.current = chunk.done / chunk.total;
          bumpTarget(computeReviewsTarget());
        } else if (chunk.type === "tabelog-progress") {
          if (chunk.total > 0) tabelogMaxRef.current = chunk.done / chunk.total;
          bumpTarget(computeReviewsTarget());
        } else if (chunk.type === "yelp-progress") {
          if (chunk.total > 0) yelpMaxRef.current = chunk.done / chunk.total;
          bumpTarget(computeReviewsTarget());
        } else if (chunk.type === "heartbeat") {
          const [lo, hi] = currentRangeRef.current;
          const ceiling = lo + (hi - lo) * 0.95;
          targetProgressRef.current = Math.min(
            ceiling,
            targetProgressRef.current + 0.3,
          );
          lastChunkAtRef.current = performance.now();
        }
      });
      if (myRunId !== runIdRef.current || ac.signal.aborted) return;
      clearTimers();
      setCurrentStage("rank");
      setRangeForStage(mode, "rank");
      targetProgressRef.current = 100;
      setResults(response);
      // 让进度条收尾动画再跳转
      setTimeout(() => {
        if (myRunId === runIdRef.current) navigate({ to: "/results" });
      }, 220);
    } catch (err) {
      if (ac.signal.aborted || myRunId !== runIdRef.current) return;
      const msg = err instanceof Error ? err.message : t("err.fetchFailed");
      if (msg.includes("429")) setError(t("err.rateLimited"));
      else if (msg.includes("402")) setError(t("err.quotaExhausted"));
      else setError(msg);
      clearTimers();
      setCurrentStage(null);
      setParsedPreview(null);
      stopProgressLoop();
    } finally {
      if (myRunId === runIdRef.current) setLoading(false);
      if (myRunId === runIdRef.current) {
        // 给收尾动画一点时间再停 loop
        setTimeout(() => {
          if (myRunId === runIdRef.current) stopProgressLoop();
        }, 400);
      }
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    runIdRef.current += 1;
    clearTimers();
    stopProgressLoop();
    setLoading(false);
    setCurrentStage(null);
    setError(null);
    setInferredCuisines(null);
    setParsedPreview(null);
  };



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
        (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
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
        // amplify and clamp to 0..1
        setLevel(Math.min(1, rms * 3));
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch (err) {
      console.warn("[mic] analyser init failed", err);
    }
  };

  const appendText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setValue((v) => (v.trim() ? `${v.replace(/[、，,。.\s]+$/, "")}、${trimmed}` : trimmed));
  };

  const appendBubble = (text: string) => {
    setValue((v) => (v.trim() ? `${v.replace(/[、，,]\s*$/, "")}、${text}` : text));
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
    for (const t of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(t)) return t;
      } catch {
        /* ignore */
      }
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
    if (mr && mr.state !== "inactive") {
      mr.stop();
    }
  };

  const toggleRecording = async () => {
    if (recording) {
      stopRecordingInternal();
      return;
    }
    if (transcribing) return;

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
    const streamPromise = navigator.mediaDevices.getUserMedia(constraints);

    let stream: MediaStream;
    try {
      stream = await streamPromise;
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
      } else if (name === "NotFoundError") {
        toast.error(t("err.mic.notFound"));
      } else if (name === "NotReadableError") {
        toast.error(t("err.mic.busy"));
      } else {
        toast.error(t("err.mic.unknown", { detail: name || msg || "?" }));
      }
      return;
    }

    const mimeType = pickMimeType();
    chunksRef.current = [];
    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (err) {
      console.error("MediaRecorder init failed:", err);
      stream.getTracks().forEach((t) => t.stop());
      toast.error(t("err.mic.initFail"));
      return;
    }
    const usedMime = recorder.mimeType || mimeType || "audio/webm";
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      console.log("[mic] dataavailable size=", e.data?.size ?? 0);
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      console.log("[mic] onstop chunks=", chunksRef.current.length, "mime=", usedMime);
      stopAnalyser();
      stream.getTracks().forEach((tr) => tr.stop());
      setRecording(false);
      setElapsed(0);

      const blob = new Blob(chunksRef.current, { type: usedMime });
      chunksRef.current = [];
      if (blob.size === 0) {
        console.warn("[mic] empty blob after stop");
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
        console.log("[mic] uploading", blob.size, "bytes as audio." + ext, "mime=", usedMime);
        const res = await fetch("/api/transcribe", { method: "POST", body: fd });
        const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        console.log("[mic] response", res.status, data);
        if (!res.ok) {
          if (res.status === 429) toast.error(t("err.transcribe.busy"));
          else if (res.status === 402) toast.error(t("err.transcribe.elevenQuota"));
          else toast.error(data.error || t("err.transcribe.fail"));
          return;
        }
        if (data.text) {
          appendText(data.text);
        } else {
          toast.error(t("err.transcribe.noContent"));
        }
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
    console.log("[mic] recording started mime=", usedMime);
    startAnalyser(stream);
    setRecording(true);
    setElapsed(0);
    const startedAt = Date.now();
    elapsedTimerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    autoStopTimerRef.current = setTimeout(() => stopRecordingInternal(), 60_000);
  };

  // First-visit nudge to highlight voice input
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (!localStorage.getItem("ee_voice_tip_seen")) {
        const id = setTimeout(() => {
          toast(t("step3.voice.firstTip"), { duration: 5000 });
          localStorage.setItem("ee_voice_tip_seen", "1");
        }, 600);
        return () => clearTimeout(id);
      }
    } catch { /* noop */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") mr.stop();
    stopAnalyser();
  }, []);

  const micBusy = transcribing || loading;
  const ringScale = 1 + level * 0.7;
  const ringOpacity = 0.18 + level * 0.55;
  const bars = [0.45, 0.75, 1, 0.75, 0.45];

  return (
    <StepShell step={3} total={3} title={t("step3.title")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch(value, "deep");
        }}
        className="space-y-5"
      >
        <NeedBubbles onPick={appendBubble} />

        {/* Prominent voice input card */}
        <div
          className={`relative overflow-hidden rounded-2xl border p-5 transition-colors ${
            recording
              ? "border-destructive/40 bg-destructive/5"
              : "border-primary/30 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="gap-1">
                  <Sparkles className="h-3 w-3" />
                  {t("step3.voice.badge")}
                </Badge>
              </div>
              <p className="mt-2 text-base font-semibold text-foreground">
                {recording ? t("step3.voice.listening") : t("step3.voice.cta")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {transcribing
                  ? t("step3.mic.transcribing")
                  : recording
                    ? t("step3.mic.recording", { s: elapsed })
                    : t("step3.voice.sub")}
              </p>
            </div>

            <div className="relative flex h-20 w-20 shrink-0 items-center justify-center">
              {/* reactive outer ring */}
              {recording && (
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-destructive/30 transition-transform"
                  style={{
                    transform: `scale(${ringScale})`,
                    opacity: ringOpacity,
                    transitionDuration: "80ms",
                  }}
                />
              )}
              {/* idle halo */}
              {!recording && !transcribing && (
                <span
                  aria-hidden
                  className="absolute inset-1 rounded-full bg-primary/20 animate-pulse"
                />
              )}
              <button
                type="button"
                onClick={() => void toggleRecording()}
                disabled={micBusy}
                aria-label={recording ? t("step3.mic.stop") : t("step3.mic.start")}
                className={`relative flex h-16 w-16 items-center justify-center rounded-full text-primary-foreground shadow-lg transition-colors disabled:opacity-60 ${
                  recording
                    ? "bg-destructive hover:bg-destructive/90"
                    : "bg-primary hover:bg-primary/90"
                }`}
              >
                {transcribing ? (
                  <Loader2 className="h-6 w-6 animate-spin" />
                ) : recording ? (
                  <Square className="h-5 w-5" fill="currentColor" />
                ) : (
                  <Mic className="h-7 w-7" />
                )}
              </button>
            </div>
          </div>

          {/* live equalizer bars */}
          {recording && (
            <div
              aria-hidden
              className="mt-4 flex h-8 items-end justify-center gap-1.5"
            >
              {bars.map((weight, i) => {
                const h = Math.max(4, Math.min(32, level * weight * 56));
                return (
                  <span
                    key={i}
                    className="w-1.5 rounded-full bg-destructive transition-[height] duration-75"
                    style={{ height: `${h}px` }}
                  />
                );
              })}
            </div>
          )}
        </div>

        <div className="relative flex items-center">
          <div className="h-px flex-1 bg-border" />
          <span className="px-3 text-[11px] uppercase tracking-wide text-muted-foreground">
            {t("step3.voice.orType")}
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-h-[120px] text-base resize-none"
          maxLength={1000}
          disabled={loading}
        />


        {loading && currentStage && (
          <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-4">
            <Progress value={progressValue} className="h-1" />
            <ul className="space-y-3">
              {stages.map((s, i) => {
                const state =
                  i < currentIndex ? "done" : i === currentIndex ? "active" : "todo";
                return (
                  <li key={s.key} className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                      {state === "done" && <Check className="h-4 w-4 text-primary" />}
                      {state === "active" && (
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      )}
                      {state === "todo" && (
                        <span className="h-3 w-3 rounded-full border border-border" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <p
                        className={
                          state === "todo"
                            ? "text-sm text-muted-foreground"
                            : "text-sm font-medium text-foreground"
                        }
                      >
                        {s.label}
                      </p>
                      {state === "active" && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{s.hint}</p>
                      )}
                      {state === "active" &&
                        (s.key === "search" || s.key === "reviews") &&
                        inferredCuisines && inferredCuisines.length > 0 && (
                          <p className="mt-1 text-xs text-primary/80">
                            {t("step3.inferred", { n: inferredCuisines.length, list: inferredCuisines.join(" / ") })}
                          </p>
                        )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="flex justify-end pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={handleCancel}>
                {t("step3.cancel")}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Link
            to="/cuisines"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("common.back")}
          </Link>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:gap-3">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={loading}
              onClick={() => void runSearch(value, "quick")}
              className="w-full sm:w-auto"
            >
              {loading && searchMode === "quick" ? t("step3.quickLoading") : t("step3.quickBtn")}
            </Button>
            <div className="relative w-full sm:w-auto">
              <Button
                type="submit"
                disabled={loading}
                size="lg"
                className="w-full sm:w-auto"
              >
                {loading && searchMode === "deep" ? t("step3.deepLoading") : t("step3.deepBtn")}
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("step3.modeTitle")}
                    className="absolute -top-2 -right-2 z-10 rounded-full bg-background p-0.5 text-muted-foreground hover:text-foreground transition-colors shadow-sm border border-border"
                  >
                    <HelpCircle className="w-4 h-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-72 text-sm leading-relaxed" align="end">
                  <p className="font-medium mb-2">{t("step3.modeTitle")}</p>
                  <p className="mb-1">
                    <span className="font-medium">{t("step3.modeQuick")}</span>: {t("step3.modeQuickDesc")}
                  </p>
                  <p>
                    <span className="font-medium">{t("step3.modeDeep")}</span>: {t("step3.modeDeepDesc")}
                  </p>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>
      </form>
    </StepShell>
  );
}
