import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Check, HelpCircle, Loader2, Mic, Sparkles, Square } from "lucide-react";
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
import { useVoiceInput } from "@/hooks/use-voice-input";
import { PlannerClarifyPanel } from "@/components/PlannerClarifyPanel";

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

  const freeText = useQueryStore((s) => s.freeText);
  const setFreeText = useQueryStore((s) => s.setFreeText);
  const setParsed = useQueryStore((s) => s.setParsed);
  const setResults = useQueryStore((s) => s.setResults);

  const [value, setValue] = useState(freeText);
  const [loading, setLoading] = useState(false);
  const [currentStage, setCurrentStage] = useState<StageKey | null>(null);
  const [searchMode, setSearchMode] = useState<"quick" | "deep">("deep");
  const [error, setError] = useState<string | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);

  // —— 平滑进度条状态 ——
  const [displayProgress, setDisplayProgress] = useState(0);
  const displayProgressRef = useRef(0);
  const targetProgressRef = useRef(0); // 软上限
  const lastFrameAtRef = useRef<number>(0);
  const rafProgressRef = useRef<number | null>(null);
  const currentRangeRef = useRef<[number, number]>([0, 100]);
  const stageExpectedMsRef = useRef<number>(8000);
  const jitterRef = useRef<{ at: number; factor: number }>({ at: 0, factor: 1 });
  const reviewMaxRef = useRef(0);
  const tabelogMaxRef = useRef(0);
  const yelpMaxRef = useRef(0);

  // —— 提前展示解析出的需求 ——
  const [parsedPreview, setParsedPreview] = useState<ParsedRequirements | null>(null);

  // —— Planner 澄清面板 ——
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [plannerSeed, setPlannerSeed] = useState<ParsedRequirements | null>(null);
  const [prechecking, setPrechecking] = useState(false);
  const pendingModeRef = useRef<"quick" | "deep">("deep");

  const parseFn = useServerFn(parseRequirements);
  const searchFn = useServerFn(searchRestaurants);

  const detectMissing = (p: ParsedRequirements): string[] => {
    const missing: string[] = [];
    const hasCuisine =
      p.cuisines.length > 0 &&
      !p.cuisines.every((c) => c === "餐厅" || c.toLowerCase() === "restaurants");
    if (!hasCuisine) missing.push("cuisine");
    const prefs = [...(p.hardFilters ?? []), ...(p.softPreferences ?? [])];
    if (prefs.length === 0) missing.push("hardFilter");
    if (!p.visitTime?.mentioned) missing.push("mealTime");
    const budgetRe = /(预算|人均|¥|￥|\$|€|£|jpy|usd|cny|rmb|元|块|budget|per person|price)/i;
    if (!prefs.some((f) => budgetRe.test(f.text))) missing.push("budget");
    return missing;
  };

  const handleSubmitClick = async (mode: "quick" | "deep") => {
    if (loading || prechecking) return;
    const text = value.trim();
    if (!text) {
      void runSearch(value, mode);
      return;
    }
    setError(null);
    setPrechecking(true);
    pendingModeRef.current = mode;
    try {
      const parsed = await parseFn({
        data: { city, cuisines, date: "", freeText: text, uiLanguage: lang },
      });
      const missing = detectMissing(parsed);
      if (missing.length === 0) {
        setPrechecking(false);
        void runSearch(text, mode, parsed);
        return;
      }
      setPlannerSeed(parsed);
      setPlannerOpen(true);
      setPrechecking(false);
    } catch (e) {
      console.warn("[precheck] parse failed, fallback to direct search", e);
      setPrechecking(false);
      void runSearch(text, mode);
    }
  };


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

  // 每个阶段期望走完的毫秒数（视觉节奏，与真实耗时无关）
  const STAGE_EXPECTED_MS: Record<"deep" | "quick", Record<StageKey, number>> = {
    deep: { parse: 4000, search: 8000, reviews: 30000, rank: 8000 },
    quick: { parse: 4000, search: 6000, reviews: 6000, rank: 5000 },
  };

  const setRangeForStage = (mode: "quick" | "deep", stage: StageKey) => {
    const [lo, hi] = STAGE_RANGES[mode][stage];
    currentRangeRef.current = [lo, hi];
    stageExpectedMsRef.current = STAGE_EXPECTED_MS[mode][stage];
    // 不瞬移 display，只抬 target 让动画自然走过去
    targetProgressRef.current = Math.max(targetProgressRef.current, lo);
  };

  const startProgressLoop = () => {
    if (rafProgressRef.current != null) return;
    lastFrameAtRef.current = performance.now();
    jitterRef.current = { at: 0, factor: 1 };
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(64, now - lastFrameAtRef.current); // clamp tab-switch 跳跃
      lastFrameAtRef.current = now;

      // ±20% 抖动，每 ~500ms 重抽
      if (now - jitterRef.current.at > 500) {
        jitterRef.current = {
          at: now,
          factor: 1 + (Math.random() - 0.5) * 0.4,
        };
      }

      const [lo, hi] = currentRangeRef.current;
      const expected = Math.max(500, stageExpectedMsRef.current);
      const vBase = (hi - lo) / expected; // %/ms
      const v = vBase * jitterRef.current.factor;

      const target = targetProgressRef.current;
      const ceiling = Math.min(target, hi - 0.5);

      const d = displayProgressRef.current;
      let next = d;
      if (d < ceiling) {
        next = Math.min(ceiling, d + v * dt);
      } else if (d < hi - 0.1) {
        // 超过软上限：1/6 速继续爬，永不停滞
        next = Math.min(hi - 0.1, d + (v * dt) / 6);
      }
      if (next !== d) {
        displayProgressRef.current = next;
        setDisplayProgress(next);
      }
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

  const runSearch = async (
    text: string,
    mode: "quick" | "deep" = "deep",
    preParsed?: ParsedRequirements,
  ) => {
    setError(null);
    setLoading(true);
    setSearchMode(mode);
    setFreeText(text);
    setParsedPreview(null);
    runIdRef.current += 1;
    const myRunId = runIdRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    // 重置进度
    targetProgressRef.current = 0;
    displayProgressRef.current = 0;
    setDisplayProgress(0);
    reviewMaxRef.current = 0;
    tabelogMaxRef.current = 0;
    yelpMaxRef.current = 0;
    startProgressLoop();

    try {
      setCurrentStage("parse");
      setRangeForStage(mode, "parse");
      targetProgressRef.current = Math.max(
        targetProgressRef.current,
        STAGE_RANGES[mode].parse[1],
      );
      let parsed = preParsed
        ? preParsed
        : await parseFn({
            data: { city, cuisines, date: "", freeText: text, uiLanguage: lang },
            signal: ac.signal,
          } as Parameters<typeof parseFn>[0]);
      if (myRunId !== runIdRef.current || ac.signal.aborted) return;
      const parsedWithMode = { ...parsed, mode, uiLanguage: lang };
      setParsed(parsedWithMode);
      setParsedPreview(parsed);


      setCurrentStage("search");
      setRangeForStage(mode, "search");
      // search 阶段也没有子事件 → 同样把 target 抬到该阶段末
      targetProgressRef.current = Math.max(
        targetProgressRef.current,
        STAGE_RANGES[mode].search[1],
      );
      clearTimers();

      const bumpTarget = (v: number) => {
        targetProgressRef.current = Math.max(targetProgressRef.current, v);
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
            bumpTarget(STAGE_RANGES[mode].search[1]);
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
            // rank 没有子事件 → 抬到末端
            bumpTarget(STAGE_RANGES[mode].rank[1]);
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
        }
        // heartbeat 不再调整 target，仅作存活信号（后端用来防 edge gateway 切流）
      });
      if (myRunId !== runIdRef.current || ac.signal.aborted) return;
      clearTimers();
      setCurrentStage("rank");
      setRangeForStage(mode, "rank");
      // 收尾：让动画匀速走完最后一段
      stageExpectedMsRef.current = 600;
      targetProgressRef.current = 100;
      setResults(response);

      // 轮询等 display 接近 100 再跳转；兜底 800ms
      const startedAt = performance.now();
      const waitAndNavigate = () => {
        if (myRunId !== runIdRef.current) return;
        if (displayProgressRef.current >= 99.5 || performance.now() - startedAt > 800) {
          navigate({ to: "/results" });
        } else {
          requestAnimationFrame(waitAndNavigate);
        }
      };
      requestAnimationFrame(waitAndNavigate);
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
        }, 900);
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
    setParsedPreview(null);
  };



  const appendText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setValue((v) => (v.trim() ? `${v.replace(/[、，,。.\s]+$/, "")}、${trimmed}` : trimmed));
  };

  const voice = useVoiceInput({ onText: appendText, disabled: loading });
  const { recording, transcribing, elapsed, level } = voice;
  const toggleRecording = voice.toggle;


  const micBusy = transcribing || loading;
  const ringScale = 1 + level * 0.7;
  const ringOpacity = 0.18 + level * 0.55;
  const bars = [0.45, 0.75, 1, 0.75, 0.45];

  return (
    <StepShell step={2} total={2} title={t("step3.title")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmitClick("deep");
        }}
        className="space-y-5"
      >
        {plannerOpen && plannerSeed && (
          <PlannerClarifyPanel
            city={city}
            freeText={value}
            initialParsed={plannerSeed}
            onDone={(finalParsed) => {
              setPlannerOpen(false);
              void runSearch(value, pendingModeRef.current, finalParsed);
            }}
            onCancel={() => {
              setPlannerOpen(false);
              setPlannerSeed(null);
            }}
          />
        )}


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
            <Progress value={displayProgress} className="h-1" />
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
                    </div>
                  </li>
                );
              })}
            </ul>
            {parsedPreview && (
              <div className="animate-fade-in border-t border-border/60 pt-3 space-y-2">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  {t("step3.parsedPreview")}
                </p>
                {(parsedPreview.city || parsedPreview.cuisines.length > 0) && (
                  <div className="flex flex-wrap gap-1.5">
                    {parsedPreview.city && (
                      <span className="px-2 py-0.5 text-xs rounded-full bg-muted text-foreground border border-border">
                        {parsedPreview.city}
                      </span>
                    )}
                    {parsedPreview.cuisines.map((c, i) => (
                      <span
                        key={`cu-${i}`}
                        className="px-2 py-0.5 text-xs rounded-full bg-muted text-foreground border border-border"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                )}
                {parsedPreview.hardFilters.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {parsedPreview.hardFilters.map((f, i) => (
                      <span key={`h-${i}`} className="px-2 py-0.5 text-xs rounded-full bg-primary/15 text-primary border border-primary/30">
                        {f.text}
                      </span>
                    ))}
                  </div>
                )}
                {parsedPreview.softPreferences.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {parsedPreview.softPreferences.map((f, i) => (
                      <span key={`s-${i}`} className="px-2 py-0.5 text-xs rounded-full bg-secondary text-secondary-foreground">
                        {f.text}
                      </span>
                    ))}
                  </div>
                )}
                {parsedPreview.negativeFilters.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {parsedPreview.negativeFilters.map((f, i) => {
                      const t = f.text.trim();
                      const hasNeg = /^(不要|不想|不喜欢|不接受|不能|别|勿|避免|排除|拒绝|讨厌|去掉|去除|杜绝|远离|禁止|avoid|no\s|not\s|non-|without|exclude|dislike|don'?t|hate|never|skip)/i.test(t);
                      const display = hasNeg ? t : (lang === "en" ? `Avoid ${t}` : `不要${t}`);
                      return (
                        <span key={`n-${i}`} className="px-2 py-0.5 text-xs rounded-full bg-destructive/10 text-destructive border border-destructive/30">
                          <span aria-hidden className="mr-1">✕</span>{display}
                        </span>
                      );
                    })}
                  </div>
                )}
                {parsedPreview.dishPreferences.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {parsedPreview.dishPreferences.map((f, i) => (
                      <span key={`d-${i}`} className="px-2 py-0.5 text-xs rounded-full bg-accent text-accent-foreground">
                        {f}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
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
            to="/"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("common.back")}
          </Link>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:gap-3">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={loading || prechecking || plannerOpen}
              onClick={() => void handleSubmitClick("quick")}
              className="w-full sm:w-auto"
            >
              {loading && searchMode === "quick" ? t("step3.quickLoading") : t("step3.quickBtn")}
            </Button>
            <div className="relative w-full sm:w-auto">
              <Button
                type="submit"
                disabled={loading || prechecking || plannerOpen}
                size="lg"
                className="w-full sm:w-auto"
              >
                {prechecking ? t("common.loading") : loading && searchMode === "deep" ? t("step3.deepLoading") : t("step3.deepBtn")}
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
