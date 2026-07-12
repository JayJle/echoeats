import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState, FormEvent } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useQueryStore, type ChatMsg, type ExtractedKeyFields } from "@/lib/store";
import { useT } from "@/lib/i18n/context";
import { LanguageToggle } from "@/components/LanguageToggle";
import { VoiceInput } from "@/components/VoiceInput";
import {
  extractKeyFields,
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

type KeyField = "cuisine" | "visitTime" | "budget";
const KEY_FIELDS: KeyField[] = ["cuisine", "visitTime", "budget"];

const FIXED_CHIPS_ZH: Record<Exclude<KeyField, "cuisine">, string[]> = {
  visitTime: ["现在", "今晚", "明天午餐", "明天晚上", "周末"],
  budget: ["100 元内", "100-200", "200-400", "400+", "不限"],
};
const FIXED_CHIPS_EN: Record<Exclude<KeyField, "cuisine">, string[]> = {
  visitTime: ["Now", "Tonight", "Tomorrow lunch", "Tomorrow dinner", "Weekend"],
  budget: ["Under $20", "$20-40", "$40-80", "$80+", "No limit"],
};

// ---- progress helpers ----
type ProgressState = {
  phase: "startingUp" | "places" | "reviews" | "rank" | "photos" | "done";
  percent: number;
  detail: string; // e.g. "3 / 12"
};

function chunkToProgress(chunk: SearchStreamChunk, prev: ProgressState): ProgressState {
  if (chunk.type === "stage") {
    switch (chunk.stage) {
      case "places":
        return { phase: "places", percent: 15, detail: "" };
      case "places-done":
        return { phase: "places", percent: 25, detail: chunk.count ? `${chunk.count}` : "" };
      case "tabelog":
      case "yelp":
        return { phase: "reviews", percent: Math.max(prev.percent, 30), detail: chunk.total ? `0 / ${chunk.total}` : "" };
      case "rank":
        return { phase: "rank", percent: 80, detail: "" };
      case "photos":
        return { phase: "photos", percent: 92, detail: "" };
      default:
        return prev;
    }
  }
  if (chunk.type === "review-progress" || chunk.type === "tabelog-progress" || chunk.type === "yelp-progress") {
    const ratio = chunk.total ? chunk.done / chunk.total : 0;
    // reviews phase covers 30% → 78%
    const percent = 30 + Math.round(ratio * 48);
    return { phase: "reviews", percent: Math.max(prev.percent, percent), detail: `${chunk.done} / ${chunk.total}` };
  }
  return prev;
}

function ChatPage() {
  const navigate = useNavigate();
  const { lang, t } = useT();
  const city = useQueryStore((s) => s.city);
  const chatHistory = useQueryStore((s) => s.chatHistory);
  const askedFields = useQueryStore((s) => s.askedFields);
  const skippedFields = useQueryStore((s) => s.skippedFields);
  const extracted = useQueryStore((s) => s.extracted);
  const freeText = useQueryStore((s) => s.freeText);
  const setChatHistory = useQueryStore((s) => s.setChatHistory);
  const setAskedFields = useQueryStore((s) => s.setAskedFields);
  const setSkippedFields = useQueryStore((s) => s.setSkippedFields);
  const setExtracted = useQueryStore((s) => s.setExtracted);
  const setFreeText = useQueryStore((s) => s.setFreeText);
  const setParsed = useQueryStore((s) => s.setParsed);
  const setResults = useQueryStore((s) => s.setResults);

  const extractFn = useServerFn(extractKeyFields);
  const parseFn = useServerFn(parseRequirements);
  const searchFn = useServerFn(searchRestaurants);

  const [thinking, setThinking] = useState(false);
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState<ProgressState>({ phase: "startingUp", percent: 5, detail: "" });
  const [introText, setIntroText] = useState("");
  const [showIntroText, setShowIntroText] = useState(false);
  const [freeInput, setFreeInput] = useState("");
  const [showFreeText, setShowFreeText] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, thinking, searching]);

  useEffect(() => {
    if (!city) navigate({ to: "/" });
  }, [city, navigate]);

  if (!city) return null;

  // Which fields are still missing after all inputs so far?
  const missingFields = (ext: ExtractedKeyFields | null, asked: string[], skipped: string[]): KeyField[] => {
    const has: Record<KeyField, boolean> = {
      cuisine: !!ext?.cuisine,
      visitTime: !!ext?.visitTime,
      budget: !!ext?.budget,
    };
    const askedSet = new Set(asked);
    const skippedSet = new Set(skipped);
    return KEY_FIELDS.filter((f) => !has[f] && !askedSet.has(f) && !skippedSet.has(f));
  };

  const questionFor = (f: KeyField): string =>
    ({
      cuisine: t("chat.q.cuisine"),
      visitTime: t("chat.q.visitTime"),
      budget: t("chat.q.budget"),
    }[f]);

  const chipsFor = (f: KeyField, ext: ExtractedKeyFields | null): string[] => {
    if (f === "cuisine") {
      const s = ext?.cuisineSuggestions ?? [];
      if (s.length > 0) return s;
      return lang === "en"
        ? ["Japanese", "Chinese", "Western", "Southeast Asian", "Cafe"]
        : ["日料", "中餐", "西餐", "东南亚", "咖啡简餐"];
    }
    return (lang === "en" ? FIXED_CHIPS_EN : FIXED_CHIPS_ZH)[f];
  };

  const advance = async (ext: ExtractedKeyFields | null, history: ChatMsg[], asked: string[], skipped: string[]) => {
    const missing = missingFields(ext, asked, skipped);
    if (missing.length === 0) {
      await runSearch(ext, history);
      return;
    }
    const next = missing[0];
    const aiMsg: ChatMsg = { role: "ai", text: questionFor(next), field: next };
    setChatHistory([...history, aiMsg]);
    setShowFreeText(false);
    setFreeInput("");
  };

  const runIntro = async (rawText: string) => {
    const text = rawText.trim();
    if (!text || thinking) return;
    setError(null);
    setThinking(true);
    setFreeText(text);
    try {
      const ext = await extractFn({ data: { city, freeText: text, uiLanguage: lang } });
      setExtracted(ext);
      const userMsg: ChatMsg = { role: "user", text };
      const history: ChatMsg[] = [userMsg];
      setChatHistory(history);
      await advance(ext, history, askedFields, skippedFields);
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
    // find the current asked field: last AI msg's field
    const lastAi = [...chatHistory].reverse().find((m) => m.role === "ai");
    const field = (lastAi?.field ?? null) as KeyField | null;
    if (!field) return;
    const cleaned = text.trim();
    if (!cleaned && !opts.skipped) return;

    const userMsg: ChatMsg = {
      role: "user",
      text: opts.skipped ? (lang === "en" ? "(skipped)" : "（跳过）") : cleaned,
      field,
    };
    const nextHistory = [...chatHistory, userMsg];
    const nextAsked = [...askedFields, field];
    const nextSkipped = opts.skipped ? [...skippedFields, field] : skippedFields;
    // patch extracted with the user's answer (unless skipped)
    const nextExtracted: ExtractedKeyFields = {
      cuisine: extracted?.cuisine ?? null,
      visitTime: extracted?.visitTime ?? null,
      budget: extracted?.budget ?? null,
      cuisineSuggestions: extracted?.cuisineSuggestions ?? [],
    };
    if (!opts.skipped) nextExtracted[field] = cleaned;

    setChatHistory(nextHistory);
    setAskedFields(nextAsked);
    if (opts.skipped) setSkippedFields(nextSkipped);
    setExtracted(nextExtracted);
    setFreeInput("");
    await advance(nextExtracted, nextHistory, nextAsked, nextSkipped);
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
      // Compose free-text for parseRequirements: original + explicit key-field lines
      const answered: string[] = [];
      if (ext?.cuisine) answered.push(lang === "en" ? `Cuisine: ${ext.cuisine}` : `品类：${ext.cuisine}`);
      if (ext?.visitTime) answered.push(lang === "en" ? `When: ${ext.visitTime}` : `时间：${ext.visitTime}`);
      if (ext?.budget) answered.push(lang === "en" ? `Budget: ${ext.budget}` : `预算：${ext.budget}`);
      const combined = [freeText, ...answered].filter(Boolean).join("；");
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
      void history;
      navigate({ to: "/results" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("err.fetchFailed");
      setError(msg.includes("429") ? t("err.rateLimited") : msg);
      setSearching(false);
    }
  };

  // Identified strip
  const identifiedRow = () => {
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
  const lastAi = [...chatHistory].reverse().find((m) => m.role === "ai");
  const lastAiField = (lastAi?.field ?? null) as KeyField | null;
  const awaitingAnswer = !!lastAi && chatHistory[chatHistory.length - 1].role === "ai";

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

            {awaitingAnswer && lastAiField && !thinking && !searching && (
              <div className="space-y-4 border-t border-border/60 pt-5">
                <div className="flex flex-wrap gap-2 justify-center">
                  {chipsFor(lastAiField, extracted).map((chip) => (
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
            <span>
              {progress.percent}% {progress.detail ? `· ${progress.detail}` : ""}
            </span>
          </div>
        </div>

        <div className="space-y-2 text-xs">
          <p className="uppercase tracking-wider text-muted-foreground">{t("chat.identified")}</p>
          <div className="flex flex-wrap gap-1.5">
            <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">📍 {city}</span>
            {extracted?.cuisine && (
              <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">🍱 {extracted.cuisine}</span>
            )}
            {extracted?.visitTime && (
              <span className="px-2 py-0.5 rounded-full bg-muted text-foreground border border-border">⏰ {extracted.visitTime}</span>
            )}
            {extracted?.budget && (
              <span className="px-2 py-0.5 rounded-full bg-muted text-foreground border border-border">💰 {extracted.budget}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
