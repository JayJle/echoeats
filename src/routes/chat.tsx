import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState, FormEvent } from "react";
import { Check, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { useQueryStore, type ChatMsg, type ExtractedKeyFields } from "@/lib/store";
import { useT } from "@/lib/i18n/context";
import { LanguageToggle } from "@/components/LanguageToggle";
import { VoiceInput } from "@/components/VoiceInput";
import {
  extractKeyFields,
  analyzeAndAskNext,
  parseRequirements,
  searchRestaurants,
  consumeSearchStream,
  type SearchStreamChunk,
} from "@/lib/echo.functions";

export const Route = createFileRoute("/chat")({
  head: () => ({
    meta: [
      { title: "Echo Eats — Chat" },
      { name: "description", content: "Tell Echo Eats what you're craving; it only asks for what's missing." },
    ],
  }),
  component: ChatPage,
});

const MAX_CLARIFY_ROUNDS = 5;

// ---- stepper progress ----
type StageKey = "parse" | "search" | "reviews" | "rank";

const STAGE_RANGES: Record<StageKey, [number, number]> = {
  parse: [0, 12],
  search: [12, 25],
  reviews: [25, 80],
  rank: [80, 99],
};

const STAGE_EXPECTED_MS: Record<StageKey, number> = {
  parse: 4000,
  search: 8000,
  reviews: 30000,
  rank: 8000,
};

const STAGE_ORDER: StageKey[] = ["parse", "search", "reviews", "rank"];

const JP_CITIES = ["东京", "大阪", "京都", "名古屋", "福冈", "札幌", "横滨", "tokyo", "osaka", "kyoto", "nagoya", "fukuoka", "sapporo", "yokohama"];
function reviewsHintKey(city: string): string {
  const c = (city || "").toLowerCase();
  if (JP_CITIES.some((x) => c.includes(x.toLowerCase()))) return "stage.reviews.hint.jp";
  return "stage.reviews.hint.other";
}


function ChatPage() {
  const navigate = useNavigate();
  const { lang, t } = useT();
  const city = useQueryStore((s) => s.city);
  const chatHistory = useQueryStore((s) => s.chatHistory);
  const extracted = useQueryStore((s) => s.extracted);
  const freeText = useQueryStore((s) => s.freeText);
  const roundsUsed = useQueryStore((s) => s.roundsUsed);
  const currentSuggestions = useQueryStore((s) => s.currentSuggestions);
  const analysisSummary = useQueryStore((s) => s.analysisSummary);
  const setChatHistory = useQueryStore((s) => s.setChatHistory);
  const setExtracted = useQueryStore((s) => s.setExtracted);
  const setFreeText = useQueryStore((s) => s.setFreeText);
  const setParsed = useQueryStore((s) => s.setParsed);
  const setResults = useQueryStore((s) => s.setResults);
  const setRoundsUsed = useQueryStore((s) => s.setRoundsUsed);
  const setCurrentQuestion = useQueryStore((s) => s.setCurrentQuestion);
  const setCurrentSuggestions = useQueryStore((s) => s.setCurrentSuggestions);
  const setAnalysisSummary = useQueryStore((s) => s.setAnalysisSummary);

  const extractFn = useServerFn(extractKeyFields);
  const analyzeFn = useServerFn(analyzeAndAskNext);
  const parseFn = useServerFn(parseRequirements);
  const searchFn = useServerFn(searchRestaurants);

  const [thinking, setThinking] = useState(false);
  const [searching, setSearching] = useState(false);
  const [currentStage, setCurrentStage] = useState<StageKey | null>(null);
  const [displayProgress, setDisplayProgress] = useState(0);
  const [introText, setIntroText] = useState("");
  const [freeInput, setFreeInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // progress animation refs
  const displayProgressRef = useRef(0);
  const targetProgressRef = useRef(0);
  const stageExpectedMsRef = useRef<number>(STAGE_EXPECTED_MS.parse);
  const jitterRef = useRef({ at: 0, factor: 1 });
  const rafProgressRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number>(0);
  const currentStageRef = useRef<StageKey | null>(null);

  const setRangeForStage = (stage: StageKey) => {
    const [lo] = STAGE_RANGES[stage];
    stageExpectedMsRef.current = STAGE_EXPECTED_MS[stage];
    targetProgressRef.current = Math.max(targetProgressRef.current, lo);
    currentStageRef.current = stage;
    setCurrentStage(stage);
  };

  const bumpTarget = (v: number) => {
    targetProgressRef.current = Math.max(targetProgressRef.current, v);
  };

  const startProgressLoop = () => {
    if (rafProgressRef.current != null) return;
    lastFrameAtRef.current = performance.now();
    const tick = (now: number) => {
      const dt = Math.max(0, now - lastFrameAtRef.current);
      lastFrameAtRef.current = now;
      // refresh jitter every ~500ms
      if (now - jitterRef.current.at > 500) {
        jitterRef.current = { at: now, factor: 0.8 + Math.random() * 0.4 };
      }
      const stage = currentStageRef.current;
      if (stage) {
        const [lo, hi] = STAGE_RANGES[stage];
        const expected = Math.max(500, stageExpectedMsRef.current);
        const vBase = (hi - lo) / expected;
        const v = vBase * jitterRef.current.factor;
        const target = targetProgressRef.current;
        const ceiling = Math.min(target, hi - 0.5);
        const d = displayProgressRef.current;
        let next = d;
        if (d < ceiling) next = d + v * dt;
        else next = d + (v * dt) / 6;
        next = Math.min(next, hi - 0.1);
        if (stage === "rank" && target >= 100) next = Math.min(d + v * dt * 3, target);
        if (next !== d) {
          displayProgressRef.current = next;
          setDisplayProgress(next);
        }
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


  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, thinking, searching]);

  useEffect(() => {
    if (!city) navigate({ to: "/" });
  }, [city, navigate]);

  if (!city) return null;

  const askNext = async (history: ChatMsg[], usedSoFar: number, extForSearch: ExtractedKeyFields | null) => {
    if (usedSoFar >= MAX_CLARIFY_ROUNDS) {
      const notice: ChatMsg = { role: "ai", text: t("chat.autoSearchNotice") };
      const nextHistory = [...history, notice];
      setChatHistory(nextHistory);
      setCurrentQuestion(null);
      setCurrentSuggestions([]);
      await runSearch(extForSearch, nextHistory);
      return;
    }
    try {
      const res = await analyzeFn({
        data: {
          city,
          uiLanguage: lang,
          history: history.map((m) => ({ role: m.role, text: m.text })),
          roundsUsed: usedSoFar,
          maxRounds: MAX_CLARIFY_ROUNDS,
        },
      });
      if (res.summary) setAnalysisSummary(res.summary);
      if (res.done || !res.question) {
        setCurrentQuestion(null);
        setCurrentSuggestions([]);
        await runSearch(extForSearch, history);
        return;
      }
      const aiMsg: ChatMsg = { role: "ai", text: res.question };
      const nextHistory = [...history, aiMsg];
      setChatHistory(nextHistory);
      setCurrentQuestion(res.question);
      setCurrentSuggestions(res.suggestions);
      setRoundsUsed(usedSoFar + 1);
      setFreeInput("");
    } catch (err) {
      // Fallback: just search
      console.warn("askNext failed", err);
      await runSearch(extForSearch, history);
    }
  };

  const runIntro = async (rawText: string) => {
    const text = rawText.trim();
    if (!text || thinking) return;
    setError(null);
    setThinking(true);
    setFreeText(text);
    try {
      // Kick off extract (for identified strip / parseRequirements) but don't block on it.
      const extPromise = extractFn({ data: { city, freeText: text, uiLanguage: lang } }).catch(() => null);
      const userMsg: ChatMsg = { role: "user", text };
      const history: ChatMsg[] = [userMsg];
      setChatHistory(history);
      setRoundsUsed(0);
      const ext = await extPromise;
      if (ext) setExtracted(ext);
      await askNext(history, 0, ext);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("err.fetchFailed"));
    } finally {
      setThinking(false);
    }
  };

  const onIntroSubmit = (e: FormEvent) => {
    e.preventDefault();
    void runIntro(introText);
  };

  const submitAnswer = async (text: string, opts: { skipped?: boolean } = {}) => {
    const cleaned = text.trim();
    if (!cleaned && !opts.skipped) return;
    if (thinking) return;

    const userMsg: ChatMsg = {
      role: "user",
      text: opts.skipped ? (lang === "en" ? "(skipped)" : "（跳过）") : cleaned,
    };
    const nextHistory = [...chatHistory, userMsg];
    setChatHistory(nextHistory);
    setFreeInput("");
    setCurrentQuestion(null);
    setCurrentSuggestions([]);
    setThinking(true);
    setError(null);
    try {
      // Refresh extracted from full free-text (best-effort)
      const combined = nextHistory
        .filter((m) => m.role === "user")
        .map((m) => m.text)
        .join("；");
      const extPromise = extractFn({ data: { city, freeText: combined, uiLanguage: lang } }).catch(() => null);
      const ext = await extPromise;
      if (ext) setExtracted(ext);
      await askNext(nextHistory, roundsUsed, ext ?? extracted);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("err.fetchFailed"));
    } finally {
      setThinking(false);
    }
  };

  const onFreeSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!freeInput.trim()) return;
    void submitAnswer(freeInput);
  };

  const runSearch = async (ext: ExtractedKeyFields | null, history: ChatMsg[]) => {
    setSearching(true);
    setError(null);
    // reset progress
    displayProgressRef.current = 0;
    targetProgressRef.current = 0;
    setDisplayProgress(0);
    currentStageRef.current = null;
    startProgressLoop();
    setRangeForStage("parse");
    bumpTarget(STAGE_RANGES.parse[0] + (STAGE_RANGES.parse[1] - STAGE_RANGES.parse[0]) * 0.5);

    try {
      const userTurns = history.filter((m) => m.role === "user").map((m) => m.text);
      const answered: string[] = [];
      if (ext?.cuisine) answered.push(lang === "en" ? `Cuisine: ${ext.cuisine}` : `品类:${ext.cuisine}`);
      if (ext?.visitTime) answered.push(lang === "en" ? `When: ${ext.visitTime}` : `时间:${ext.visitTime}`);
      if (ext?.budget) answered.push(lang === "en" ? `Budget: ${ext.budget}` : `预算:${ext.budget}`);
      const combined = [freeText, ...userTurns, ...answered].filter(Boolean).join(";");
      setFreeText(combined);

      const parsed = await parseFn({
        data: {
          city,
          cuisines: [],
          autoInferCuisines: true,
          date: "",
          freeText: combined,
          uiLanguage: lang,
        },
      });
      setParsed(parsed);
      bumpTarget(STAGE_RANGES.parse[1] - 0.5);

      const iter = await searchFn({
        data: { ...parsed, uiLanguage: lang },
      } as Parameters<typeof searchFn>[0]);
      const response = await consumeSearchStream(iter, (chunk: SearchStreamChunk) => {
        handleSearchChunk(chunk);
      });

      // finalize
      setRangeForStage("rank");
      stageExpectedMsRef.current = 600;
      targetProgressRef.current = 100;

      // wait for animation to reach ~99.5 before navigating
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const check = () => {
          if (displayProgressRef.current >= 99.5 || performance.now() - start > 800) {
            resolve();
          } else {
            requestAnimationFrame(check);
          }
        };
        check();
      });
      stopProgressLoop();
      setResults(response);
      navigate({ to: "/results" });
    } catch (err) {
      stopProgressLoop();
      const msg = err instanceof Error ? err.message : t("err.fetchFailed");
      setError(msg.includes("429") ? t("err.rateLimited") : msg);
      setSearching(false);
    }
  };

  const handleSearchChunk = (chunk: SearchStreamChunk) => {
    if (chunk.type === "stage") {
      switch (chunk.stage) {
        case "places": {
          setRangeForStage("search");
          const [lo, hi] = STAGE_RANGES.search;
          bumpTarget(lo + (hi - lo) * 0.5);
          return;
        }
        case "places-done": {
          setRangeForStage("search");
          bumpTarget(STAGE_RANGES.search[1] - 0.5);
          return;
        }
        case "tabelog":
        case "yelp": {
          setRangeForStage("reviews");
          const [lo] = STAGE_RANGES.reviews;
          bumpTarget(lo + 2);
          return;
        }
        case "rank": {
          setRangeForStage("rank");
          const [lo, hi] = STAGE_RANGES.rank;
          bumpTarget(lo + (hi - lo) * 0.4);
          return;
        }
        case "photos": {
          setRangeForStage("rank");
          const [lo, hi] = STAGE_RANGES.rank;
          bumpTarget(lo + (hi - lo) * 0.8);
          return;
        }
        default:
          return;
      }
    }
    if (
      chunk.type === "review-progress" ||
      chunk.type === "tabelog-progress" ||
      chunk.type === "yelp-progress"
    ) {
      setRangeForStage("reviews");
      const [lo, hi] = STAGE_RANGES.reviews;
      const ratio = chunk.total ? chunk.done / chunk.total : 0;
      bumpTarget(lo + Math.min(1, ratio) * (hi - lo));
    }
  };


  const identifiedRow = () => {
    if (analysisSummary) {
      return (
        <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
          <span>📍 {city}</span>
          <span>💡 {t("chat.summary.label")}：<span className="text-foreground">{analysisSummary}</span></span>
        </div>
      );
    }
    const val = (v: string | null | undefined) => v || t("chat.identified.pending");
    return (
      <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
        <span>📍 {city}</span>
        <span>🍱 {t("chat.identified.cuisine")}：<span className={extracted?.cuisine ? "text-foreground" : "opacity-60"}>{val(extracted?.cuisine)}</span></span>
        <span>⏰ {t("chat.identified.visitTime")}：<span className={extracted?.visitTime ? "text-foreground" : "opacity-60"}>{val(extracted?.visitTime)}</span></span>
        <span>💰 {t("chat.identified.budget")}：<span className={extracted?.budget ? "text-foreground" : "opacity-60"}>{val(extracted?.budget)}</span></span>
      </div>
    );
  };

  const showIntro = chatHistory.length === 0 && !thinking && !searching;
  const lastMsg = chatHistory[chatHistory.length - 1];
  const awaitingAnswer = !!lastMsg && lastMsg.role === "ai" && roundsUsed > 0 && roundsUsed <= MAX_CLARIFY_ROUNDS;
  const roundsRemaining = Math.max(0, MAX_CLARIFY_ROUNDS - roundsUsed);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="px-6 py-5 flex items-center justify-between border-b border-border/60">
        <Link to="/" className="font-semibold tracking-tight">
          Echo <span className="text-primary">Eats</span>
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">📍 {city}</span>
          <LanguageToggle />
        </div>
      </header>

      {!showIntro && (
        <div className="border-b border-border/40 px-4 py-2 bg-muted/30">
          <div className="max-w-2xl mx-auto">{identifiedRow()}</div>
        </div>
      )}

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 py-6 flex flex-col gap-4">
        {showIntro ? (
          <form onSubmit={onIntroSubmit} className="mt-6 space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">{t("chat.intro.title")}</h1>
              <p className="text-sm text-muted-foreground">{t("chat.intro.hint")}</p>
            </div>

            <div className="py-4">
              <VoiceInput
                variant="hero"
                disabled={thinking}
                onTranscript={(text) => {
                  setIntroText((prev) => (prev ? `${prev}${prev.endsWith(" ") ? "" : " "}${text}` : text).slice(0, 500));
                }}
              />
            </div>

            <div className="space-y-3">
              <Textarea
                value={introText}
                onChange={(e) => setIntroText(e.target.value)}
                placeholder={t("chat.intro.placeholder")}
                className="min-h-[100px] text-base resize-none"
                maxLength={500}
              />
              <div className="flex justify-end">
                <Button type="submit" size="lg" disabled={!introText.trim() || thinking}>
                  {thinking ? <><Loader2 className="animate-spin mr-2 w-4 h-4" />{t("chat.thinking")}</> : t("chat.intro.submit")}
                </Button>
              </div>
            </div>
            {error && <p className="text-sm text-destructive text-center" role="alert">{error}</p>}
          </form>
        ) : (
          <>
            <div className="flex-1 space-y-3">
              {chatHistory.map((m, i) => (
                <div
                  key={i}
                  className={
                    m.role === "ai"
                      ? "max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm"
                      : "max-w-[85%] ml-auto rounded-2xl bg-primary text-primary-foreground px-4 py-2.5 text-sm"
                  }
                >
                  {m.text}
                </div>
              ))}
              {thinking && (
                <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t("chat.thinking")}
                </div>
              )}
              {error && <div className="text-sm text-destructive" role="alert">{error}</div>}
              <div ref={bottomRef} />
            </div>

            {awaitingAnswer && !thinking && !searching && (
              <div className="space-y-4 border-t border-border/60 pt-5">
                <div className="text-xs text-muted-foreground text-center">
                  {t("chat.roundsHint", { n: roundsRemaining })}
                </div>
                {currentSuggestions.length > 0 && (
                  <div className="flex flex-wrap gap-2 justify-center">
                    {currentSuggestions.map((chip) => (
                      <Button
                        key={chip}
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => submitAnswer(chip)}
                      >
                        {chip}
                      </Button>
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => submitAnswer("", { skipped: true })}
                    >
                      {t("chat.skip")}
                    </Button>
                  </div>
                )}
                {currentSuggestions.length === 0 && (
                  <div className="flex justify-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => submitAnswer("", { skipped: true })}
                    >
                      {t("chat.skip")}
                    </Button>
                  </div>
                )}

                <div className="py-2">
                  <VoiceInput
                    variant="hero"
                    onTranscript={(text) => {
                      setFreeInput((prev) => (prev ? `${prev}${prev.endsWith(" ") ? "" : " "}${text}` : text).slice(0, 200));
                    }}
                  />
                </div>

                <form onSubmit={onFreeSubmit} className="flex gap-2 items-center">
                  <Input
                    value={freeInput}
                    onChange={(e) => setFreeInput(e.target.value)}
                    placeholder={t("chat.orTypeYourOwn")}
                    className="flex-1"
                    maxLength={200}
                  />
                  <Button type="submit" size="icon" disabled={!freeInput.trim()}>
                    <Send className="w-4 h-4" />
                  </Button>
                </form>
              </div>
            )}
          </>
        )}
      </main>

      {searching && (
        <SearchProgressOverlay
          currentStage={currentStage}
          displayProgress={displayProgress}
          city={city}
          extracted={extracted}
          analysisSummary={analysisSummary}
          t={t}
          lang={lang}
        />
      )}
    </div>
  );
}

function SearchProgressOverlay({
  currentStage,
  displayProgress,
  city,
  extracted,
  analysisSummary,
  t,
  lang,
}: {
  currentStage: StageKey | null;
  displayProgress: number;
  city: string;
  extracted: ExtractedKeyFields | null;
  analysisSummary: string;
  t: (k: string, v?: Record<string, string | number>) => string;
  lang: "zh" | "en";
}) {
  const stages: { key: StageKey; label: string; hint: string }[] = [
    { key: "parse", label: t("stage.parse.label"), hint: t("stage.parse.hint") },
    {
      key: "search",
      label: t("stage.search.label", { city: city || t("stage.search.placeholder") }),
      hint: t("stage.search.hintDeep"),
    },
    { key: "reviews", label: t("stage.reviews.label"), hint: t(reviewsHintKey(city)) },
    { key: "rank", label: t("stage.rank.label"), hint: t("stage.rank.hintDeep") },
  ];
  const currentIndex = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1;

  const cuisineLabel = lang === "en" ? "Cuisine" : "品类";
  const timeLabel = lang === "en" ? "When" : "时间";
  const budgetLabel = lang === "en" ? "Budget" : "预算";
  const hasIdentified = !!(extracted?.cuisine || extracted?.visitTime || extracted?.budget) || !!city;

  return (
    <div className="fixed inset-0 z-50 bg-background/85 backdrop-blur-sm flex items-center justify-center px-4">
      <div className="bg-card border border-border rounded-2xl p-6 shadow-lg w-full max-w-md space-y-4">
        <div className="flex items-center gap-2">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
          <h2 className="text-base font-semibold">{t("chat.progress.title")}</h2>
        </div>

        {hasIdentified && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5 text-xs">
              {city && (
                <span className="rounded-full border border-border/60 bg-background/60 px-2.5 py-0.5">
                  📍 {city}
                </span>
              )}
              {extracted?.cuisine && (
                <span className="rounded-full border border-border/60 bg-background/60 px-2.5 py-0.5">
                  🍱 {cuisineLabel}: {extracted.cuisine}
                </span>
              )}
              {extracted?.visitTime && (
                <span className="rounded-full border border-border/60 bg-background/60 px-2.5 py-0.5">
                  ⏰ {timeLabel}: {extracted.visitTime}
                </span>
              )}
              {extracted?.budget && (
                <span className="rounded-full border border-border/60 bg-background/60 px-2.5 py-0.5">
                  💰 {budgetLabel}: {extracted.budget}
                </span>
              )}
            </div>
            {analysisSummary && (
              <p className="text-xs text-muted-foreground italic">
                💡 {t("chat.summary.label")}: {analysisSummary}
              </p>
            )}
          </div>
        )}

        <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-4">
          <Progress value={displayProgress} className="h-1" />
          <ul className="space-y-3">
            {stages.map((s, i) => {
              const state = i < currentIndex ? "done" : i === currentIndex ? "active" : "todo";
              return (
                <li key={s.key} className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                    {state === "done" && <Check className="h-4 w-4 text-primary" />}
                    {state === "active" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                    {state === "todo" && <span className="h-3 w-3 rounded-full border border-border" />}
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
        </div>
      </div>
    </div>
  );
}

