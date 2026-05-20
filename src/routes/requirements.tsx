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
import { useQueryStore } from "@/lib/store";
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
const CN_CITIES = ["北京", "上海", "广州", "深圳", "成都", "杭州", "南京", "重庆", "武汉", "西安", "苏州", "天津", "厦门", "长沙"];

function reviewsHintKey(city: string): string {
  const c = city.toLowerCase();
  if (JP_CITIES.some((x) => c.includes(x.toLowerCase()))) return "stage.reviews.hint.jp";
  if (CN_CITIES.some((x) => city.includes(x))) return "stage.reviews.hint.cn";
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
  const progressValue = currentStage
    ? Math.min(100, ((currentIndex + 0.5) / stages.length) * 100)
    : 0;

  const runSearch = async (text: string, mode: "quick" | "deep" = "deep") => {
    setError(null);
    setLoading(true);
    setSearchMode(mode);
    setFreeText(text);
    setInferredCuisines(null);
    runIdRef.current += 1;
    const myRunId = runIdRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      setCurrentStage("parse");
      const parsed = await parseFn({
        data: { city, cuisines, autoInferCuisines, date: "", freeText: text, uiLanguage: lang },
        signal: ac.signal,
      } as Parameters<typeof parseFn>[0]);
      if (myRunId !== runIdRef.current || ac.signal.aborted) return;
      const parsedWithMode = { ...parsed, mode, uiLanguage: lang };
      setParsed(parsedWithMode);
      if (parsed.cuisinesInferred && parsed.cuisines.length > 0) {
        setInferredCuisines(parsed.cuisines);
      }

      setCurrentStage("search");
      clearTimers();

      const iter = await searchFn({
        data: parsedWithMode,
        signal: ac.signal,
      } as Parameters<typeof searchFn>[0]);
      const response = await consumeSearchStream(iter, (chunk) => {
        if (myRunId !== runIdRef.current || ac.signal.aborted) return;
        if (chunk.type === "stage") {
          if (chunk.stage === "places" || chunk.stage === "places-done") {
            setCurrentStage("search");
          } else if (
            chunk.stage === "reviews" ||
            chunk.stage === "tabelog" ||
            chunk.stage === "photos"
          ) {
            setCurrentStage("reviews");
          } else if (chunk.stage === "rank" || chunk.stage === "rank-fallback") {
            setCurrentStage("rank");
          }
        }
      });
      if (myRunId !== runIdRef.current || ac.signal.aborted) return;
      clearTimers();
      setCurrentStage("rank");
      setResults(response);
      navigate({ to: "/results" });
    } catch (err) {
      if (ac.signal.aborted || myRunId !== runIdRef.current) return;
      const msg = err instanceof Error ? err.message : t("err.fetchFailed");
      if (msg.includes("429")) setError(t("err.rateLimited"));
      else if (msg.includes("402")) setError(t("err.quotaExhausted"));
      else setError(msg);
      clearTimers();
      setCurrentStage(null);
    } finally {
      if (myRunId === runIdRef.current) setLoading(false);
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    runIdRef.current += 1;
    clearTimers();
    setLoading(false);
    setCurrentStage(null);
    setError(null);
    setInferredCuisines(null);
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
  }, []);

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

        <div className="relative">
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="min-h-[120px] text-base resize-none pr-20"
            maxLength={1000}
            disabled={loading}
          />
          <div className="absolute bottom-3 right-3 flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => void toggleRecording()}
              disabled={transcribing || loading}
              aria-label={recording ? t("step3.mic.stop") : t("step3.mic.start")}
              className={`flex h-14 w-14 items-center justify-center rounded-full text-primary-foreground shadow-md transition-colors disabled:opacity-60 ${
                recording
                  ? "bg-destructive hover:bg-destructive/90"
                  : "bg-primary hover:bg-primary/90"
              }`}
              style={recording ? { animation: "mic-ring 1.4s ease-out infinite" } : undefined}
            >
              {transcribing ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : recording ? (
                <Square className="h-5 w-5" fill="currentColor" />
              ) : (
                <Mic className="h-6 w-6" />
              )}
            </button>
            <span className="text-[10px] text-muted-foreground">
              {transcribing ? t("step3.mic.transcribing") : recording ? t("step3.mic.recording", { s: elapsed }) : t("step3.mic.tip")}
            </span>
          </div>
        </div>

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
