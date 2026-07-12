import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState, FormEvent } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useQueryStore, type ChatMsg } from "@/lib/store";
import { useT } from "@/lib/i18n/context";
import { LanguageToggle } from "@/components/LanguageToggle";
import {
  clarifyNextStep,
  parseRequirements,
  searchRestaurants,
  consumeSearchStream,
} from "@/lib/echo.functions";

export const Route = createFileRoute("/chat")({
  head: () => ({
    meta: [
      { title: "Echo Eats — Chat" },
      { name: "description", content: "Tell Echo Eats what you want in a quick back-and-forth chat." },
    ],
  }),
  component: ChatPage,
});

type AskState = {
  field: string;
  question: string;
  suggestions: string[];
  allowSkip: boolean;
};

function ChatPage() {
  const navigate = useNavigate();
  const { lang, t } = useT();
  const city = useQueryStore((s) => s.city);
  const chatHistory = useQueryStore((s) => s.chatHistory);
  const askedFields = useQueryStore((s) => s.askedFields);
  const skippedFields = useQueryStore((s) => s.skippedFields);
  const setChatHistory = useQueryStore((s) => s.setChatHistory);
  const setAskedFields = useQueryStore((s) => s.setAskedFields);
  const setSkippedFields = useQueryStore((s) => s.setSkippedFields);
  const setFreeText = useQueryStore((s) => s.setFreeText);
  const setParsed = useQueryStore((s) => s.setParsed);
  const setResults = useQueryStore((s) => s.setResults);

  const clarifyFn = useServerFn(clarifyNextStep);
  const parseFn = useServerFn(parseRequirements);
  const searchFn = useServerFn(searchRestaurants);

  const [ask, setAsk] = useState<AskState | null>(null);
  const [thinking, setThinking] = useState(false);
  const [searching, setSearching] = useState(false);
  const [freeInput, setFreeInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const bootedRef = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, ask, thinking, searching]);

  // Bootstrap: if no city, back home; else request first question.
  useEffect(() => {
    if (!city) {
      navigate({ to: "/" });
      return;
    }
    if (bootedRef.current) return;
    bootedRef.current = true;
    if (chatHistory.length === 0) {
      void requestNextStep([], [], []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city]);

  const requestNextStep = async (
    history: ChatMsg[],
    asked: string[],
    skipped: string[],
  ) => {
    setThinking(true);
    setError(null);
    try {
      const lastUser = [...history].reverse().find((m) => m.role === "user")?.text ?? "";
      const res = await clarifyFn({
        data: {
          city,
          askedFields: asked,
          skippedFields: skipped,
          lastUserMessage: lastUser,
          roundIndex: asked.length,
          uiLanguage: lang,
        },
      });
      if (res.action === "search") {
        setAsk(null);
        await runSearch(history);
        return;
      }
      const aiMsg: ChatMsg = {
        role: "ai",
        text: res.question ?? "",
        field: res.field,
      };
      const nextHistory = [...history, aiMsg];
      setChatHistory(nextHistory);
      setAsk({
        field: res.field ?? "unknown",
        question: res.question ?? "",
        suggestions: res.suggestions ?? [],
        allowSkip: res.allowSkip ?? true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("err.fetchFailed");
      setError(msg);
    } finally {
      setThinking(false);
    }
  };

  const runSearch = async (history: ChatMsg[]) => {
    setSearching(true);
    setError(null);
    try {
      // 把 chat 里的用户回复拼成一段自由文本，交给现有 parseRequirements
      const combinedFreeText = history
        .filter((m) => m.role === "user")
        .map((m) => (m.field ? `[${m.field}] ${m.text}` : m.text))
        .join("；");
      setFreeText(combinedFreeText);
      const parsed = await parseFn({
        data: {
          city,
          cuisines: [],
          autoInferCuisines: true,
          date: "",
          freeText: combinedFreeText,
          uiLanguage: lang,
        },
      });
      setParsed(parsed);
      const iter = await searchFn({
        data: { ...parsed, uiLanguage: lang } as Parameters<typeof searchFn>[0]["data"],
      });
      const response = await consumeSearchStream(iter);
      setResults(response);
      navigate({ to: "/results" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("err.fetchFailed");
      setError(msg.includes("429") ? t("err.rateLimited") : msg);
      setSearching(false);
    }
  };

  const submitAnswer = async (text: string, opts: { skipped?: boolean } = {}) => {
    if (!ask) return;
    const cleaned = text.trim();
    if (!cleaned && !opts.skipped) return;
    const userMsg: ChatMsg = {
      role: "user",
      text: opts.skipped ? (lang === "en" ? "(skipped)" : "（跳过）") : cleaned,
      field: ask.field,
    };
    const nextHistory = [...chatHistory, userMsg];
    const nextAsked = [...askedFields, ask.field];
    const nextSkipped = opts.skipped ? [...skippedFields, ask.field] : skippedFields;
    setChatHistory(nextHistory);
    setAskedFields(nextAsked);
    if (opts.skipped) setSkippedFields(nextSkipped);
    setFreeInput("");
    setAsk(null);
    await requestNextStep(nextHistory, nextAsked, nextSkipped);
  };

  const onFreeSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!freeInput.trim()) return;
    void submitAnswer(freeInput);
  };

  if (!city) return null;

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

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 py-6 flex flex-col gap-4">
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

          {error && (
            <div className="text-sm text-destructive" role="alert">
              {error}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {ask && !thinking && !searching && (
          <div className="space-y-3 border-t border-border/60 pt-4">
            <div className="flex flex-wrap gap-2">
              {ask.suggestions.map((chip) => (
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
              {ask.allowSkip && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => submitAnswer("", { skipped: true })}
                >
                  {t("chat.skip")}
                </Button>
              )}
            </div>
            <form onSubmit={onFreeSubmit} className="flex gap-2">
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
      </main>

      {searching && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-card border border-border rounded-2xl px-6 py-5 shadow-lg text-sm flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
            <p>{t("chat.searching")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
