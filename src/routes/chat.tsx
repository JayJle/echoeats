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
  const [progress, setProgress] = useState<ProgressState>({ phase: "startingUp", percent: 5, detail: "" });
  const [introText, setIntroText] = useState("");
  const [freeInput, setFreeInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

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
    setProgress({ phase: "startingUp", percent: 5, detail: "" });
    setError(null);
    try {
      const userTurns = history.filter((m) => m.role === "user").map((m) => m.text);
      const answered: string[] = [];
      if (ext?.cuisine) answered.push(lang === "en" ? `Cuisine: ${ext.cuisine}` : `品类：${ext.cuisine}`);
      if (ext?.visitTime) answered.push(lang === "en" ? `When: ${ext.visitTime}` : `时间：${ext.visitTime}`);
      if (ext?.budget) answered.push(lang === "en" ? `Budget: ${ext.budget}` : `预算：${ext.budget}`);
      const combined = [freeText, ...userTurns, ...answered].filter(Boolean).join("；");
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

      const iter = await searchFn({
        data: { ...parsed, uiLanguage: lang },
      } as Parameters<typeof searchFn>[0]);
      const response = await consumeSearchStream(iter, (chunk) => {
        setProgress((prev) => chunkToProgress(chunk, prev));
      });
      setProgress({ phase: "done", percent: 100, detail: "" });
      setResults(response);
      navigate({ to: "/results" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("err.fetchFailed");
      setError(msg.includes("429") ? t("err.rateLimited") : msg);
      setSearching(false);
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
          progress={progress}
          city={city}
          extracted={extracted}
          t={t}
        />
      )}
    </div>
  );
}

function SearchProgressOverlay({
  progress,
  city,
  extracted,
  t,
}: {
  progress: ProgressState;
  city: string;
  extracted: ExtractedKeyFields | null;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const phaseLabel: Record<ProgressState["phase"], string> = {
    startingUp: t("chat.progress.startingUp"),
    places: t("chat.progress.places", { city }),
    reviews: t("chat.progress.reviews"),
    rank: t("chat.progress.rank"),
    photos: t("chat.progress.photos"),
    done: t("chat.progress.done"),
  };
  return (
    <div className="fixed inset-0 z-50 bg-background/85 backdrop-blur-sm flex items-center justify-center px-4">
      <div className="bg-card border border-border rounded-2xl px-6 py-6 shadow-lg w-full max-w-md space-y-5">
        <div className="flex items-center gap-2">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
          <h2 className="text-base font-semibold">{t("chat.progress.title")}</h2>
        </div>

        <div>
          <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-500 ease-out"
              style={{ width: `${Math.max(2, Math.min(100, progress.percent))}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>{phaseLabel[progress.phase]}</span>
            <span>{progress.detail}</span>
          </div>
        </div>

        {extracted && (
          <div className="text-xs text-muted-foreground space-y-1">
            {extracted.cuisine && <div>🍱 {extracted.cuisine}</div>}
            {extracted.visitTime && <div>⏰ {extracted.visitTime}</div>}
            {extracted.budget && <div>💰 {extracted.budget}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
