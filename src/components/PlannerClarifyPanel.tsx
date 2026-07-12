import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Mic, Send, Square, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ParsedFieldsBar } from "@/components/ParsedFieldsBar";
import { useT } from "@/lib/i18n/context";
import { useVoiceInput } from "@/hooks/use-voice-input";
import type { ParsedRequirements } from "@/lib/store";
import {
  plannerTurn,
  type PlannerField,
  type PlannerResponse,
  type PlannerTurn,
} from "@/lib/planner.functions";

type Props = {
  city: string;
  freeText: string;
  initialParsed: ParsedRequirements;
  onDone: (finalParsed: ParsedRequirements) => void;
  onCancel: () => void;
};

const MAX_TURNS = 5;

type UiMessage =
  | { id: string; role: "assistant"; text: string; field?: PlannerField | null; suggestions?: { label: string; value: string }[] }
  | { id: string; role: "user"; text: string };

/**
 * Planner 多轮澄清面板 —— 语音优先，实时展示字段解析。
 * 用户答/跳过每一轮 → 调 plannerTurn → 更新 parsed → 高亮新增字段 → 展示下一条追问。
 */
export function PlannerClarifyPanel({
  city,
  freeText,
  initialParsed,
  onDone,
  onCancel,
}: Props) {
  const { t, lang } = useT();
  const plannerFn = useServerFn(plannerTurn);

  const [parsed, setParsed] = useState<ParsedRequirements>(initialParsed);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [skipped, setSkipped] = useState<PlannerField[]>([]);
  const [turnCount, setTurnCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const currentQuestionRef = useRef<PlannerResponse["question"]>(null);
  const inFlightRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bootstrappedRef = useRef(false);

  const currentQuestion = currentQuestionRef.current;

  const voice = useVoiceInput({
    onText: (text) => {
      setCustomOpen(true);
      setCustomValue((v) => (v.trim() ? `${v} ${text}` : text));
    },
    disabled: loading,
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading, customOpen]);

  const runPlanner = async (opts: {
    userText?: string;
    newHistory?: UiMessage[];
    newSkipped?: PlannerField[];
    incrementTurn?: boolean;
  }) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const history = (opts.newHistory ?? messages).map<PlannerTurn>((m) =>
        m.role === "assistant"
          ? { role: "assistant", content: m.text, field: m.field ?? null }
          : { role: "user", content: m.text },
      );
      const nextSkipped = opts.newSkipped ?? skipped;
      const nextTurn = (opts.incrementTurn ? turnCount + 1 : turnCount);
      const res = await plannerFn({
        data: {
          city,
          uiLanguage: lang,
          freeText,
          history,
          parsed,
          skippedFields: nextSkipped,
          turnCount: nextTurn,
        },
      });
      // 计算 diff -> 高亮
      const diff = res.newlyFilled.length > 0 ? res.newlyFilled : diffFields(parsed, res.parsed);
      setParsed(res.parsed as ParsedRequirements);
      setHighlight(diff);
      setSkipped(nextSkipped);
      setTurnCount(nextTurn);
      currentQuestionRef.current = res.question;

      if (res.done || !res.question || nextTurn >= MAX_TURNS) {
        onDone(res.parsed as ParsedRequirements);
        return;
      }

      const q = res.question;
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: q.prompt,
          field: q.field,
          suggestions: q.suggestions,
        },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[planner] failed", msg);
      setError(t("planner.error"));
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  };

  // 首次挂载：跑一次 planner 展开第一条追问
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void runPlanner({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitAnswer = (userText: string, viaSuggestion = false) => {
    if (!userText.trim() || loading || inFlightRef.current || !currentQuestionRef.current) return;
    currentQuestionRef.current = null;
    const nextHistory: UiMessage[] = [
      ...messages,
      { id: `u-${Date.now()}`, role: "user", text: userText.trim() },
    ];
    setMessages(nextHistory);
    setCustomValue("");
    setCustomOpen(false);
    void runPlanner({ userText, newHistory: nextHistory, incrementTurn: true });
    if (viaSuggestion) {
      // 无操作，仅语义标记
    }
  };

  const skipCurrent = () => {
    const q = currentQuestionRef.current;
    if (!q || loading || inFlightRef.current) return;
    currentQuestionRef.current = null;
    const nextSkipped = Array.from(new Set([...skipped, q.field]));
    const nextHistory: UiMessage[] = [
      ...messages,
      { id: `u-${Date.now()}`, role: "user", text: t("planner.skipMark") },
    ];
    setMessages(nextHistory);
    void runPlanner({
      newHistory: nextHistory,
      newSkipped: nextSkipped,
      incrementTurn: true,
    });
  };

  const skipAll = () => {
    onDone(parsed);
  };

  const progress = useMemo(() => `${Math.min(turnCount, MAX_TURNS)} / ${MAX_TURNS}`, [turnCount]);
  const activeAssistantMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id;
    }
    return null;
  }, [messages]);

  return (
    <div className="rounded-2xl border border-primary/30 bg-card shadow-sm overflow-hidden">
      <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border/60 bg-primary/5">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{t("planner.title")}</p>
          <p className="text-xs text-muted-foreground">{t("planner.subtitle", { progress })}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={skipAll} disabled={loading}>
            {t("planner.skipAll")}
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={onCancel} aria-label={t("common.cancel")}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="p-4 space-y-3">
        <ParsedFieldsBar parsed={parsed} highlight={highlight} />

        <div
          ref={scrollRef}
          className="max-h-72 overflow-y-auto space-y-3 rounded-xl border border-border/50 bg-background/60 p-3"
        >
          {messages.length === 0 && !loading && (
            <p className="text-xs text-muted-foreground text-center py-4">
              {t("planner.startingSoon")}
            </p>
          )}
          {messages.map((m) => (
            <div key={m.id} className={m.role === "assistant" ? "flex flex-col items-start" : "flex flex-col items-end"}>
              <div
                className={
                  m.role === "assistant"
                    ? "max-w-[85%] rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-sm text-foreground"
                    : "max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-sm text-primary-foreground"
                }
              >
                {m.text}
              </div>
              {m.role === "assistant" && m.suggestions && m.suggestions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5 max-w-full">
                  {m.suggestions.map((s, i) => (
                    <button
                      key={i}
                      type="button"
                      disabled={loading || m.id !== activeAssistantMessageId}
                      onClick={() => {
                        if (m.id === activeAssistantMessageId) submitAnswer(s.value, true);
                      }}
                      className="rounded-full border border-primary/40 bg-primary/5 px-3 py-1 text-xs text-primary hover:bg-primary/10 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("planner.thinking")}
            </div>
          )}
        </div>

        {error && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        {/* 语音 + 跳过 + 自定义 */}
        {currentQuestion && !loading && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void voice.toggle()}
                disabled={voice.transcribing || loading}
                aria-label={voice.recording ? t("step3.mic.stop") : t("step3.mic.start")}
                className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-primary-foreground shadow transition-colors disabled:opacity-60 ${
                  voice.recording ? "bg-destructive hover:bg-destructive/90" : "bg-primary hover:bg-primary/90"
                }`}
              >
                {voice.transcribing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : voice.recording ? (
                  <Square className="h-4 w-4" fill="currentColor" />
                ) : (
                  <Mic className="h-5 w-5" />
                )}
              </button>
              <div className="flex-1 text-xs text-muted-foreground">
                {voice.recording
                  ? t("step3.mic.recording", { s: voice.elapsed })
                  : voice.transcribing
                    ? t("step3.mic.transcribing")
                    : t("planner.voiceHint")}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={skipCurrent} disabled={loading}>
                {t("planner.skipOne")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCustomOpen((v) => !v)}
                disabled={loading}
              >
                {t("planner.custom")}
              </Button>
            </div>

            {customOpen && (
              <div className="flex items-end gap-2">
                <Textarea
                  value={customValue}
                  onChange={(e) => setCustomValue(e.target.value)}
                  placeholder={t("planner.customPlaceholder")}
                  className="min-h-[60px] text-sm resize-none"
                  maxLength={500}
                  autoFocus
                />
                <Button
                  type="button"
                  size="icon"
                  onClick={() => submitAnswer(customValue)}
                  disabled={!customValue.trim() || loading}
                  aria-label={t("planner.send")}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// 简单比较 parsed 前后差异，返回变化字段名（作为 highlight）
function diffFields(prev: ParsedRequirements, next: ParsedRequirements): string[] {
  const changed: string[] = [];
  const arrLen = (a?: unknown[]) => (a ? a.length : 0);
  if (prev.city !== next.city) changed.push("city");
  if (arrLen(prev.cuisines) !== arrLen(next.cuisines)) changed.push("cuisines");
  if (arrLen(prev.hardFilters) !== arrLen(next.hardFilters)) changed.push("hardFilters");
  if (arrLen(prev.softPreferences) !== arrLen(next.softPreferences)) changed.push("softPreferences");
  if (arrLen(prev.negativeFilters) !== arrLen(next.negativeFilters)) changed.push("negativeFilters");
  if (arrLen(prev.dishPreferences) !== arrLen(next.dishPreferences)) changed.push("dishPreferences");
  const pv = prev.visitTime?.mentioned ? prev.visitTime.raw : "";
  const nv = next.visitTime?.mentioned ? next.visitTime.raw : "";
  if (pv !== nv) changed.push("visitTime");
  return changed;
}
