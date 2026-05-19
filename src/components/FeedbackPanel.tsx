import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Restaurant } from "@/lib/store";
import { useT } from "@/lib/i18n/context";
import {
  createSearchSession,
  submitSearchFeedback,
} from "@/lib/feedback.functions";

const ANON_KEY = "echo-eats-anon-id";

function getAnonId(): string {
  if (typeof window === "undefined") return "ssr";
  let id = localStorage.getItem(ANON_KEY);
  if (!id) {
    id =
      (crypto.randomUUID?.() as string | undefined) ??
      `anon-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(ANON_KEY, id);
  }
  return id;
}

type Props = {
  city: string;
  cuisines: string[];
  parsed: unknown;
  restaurants: Restaurant[];
  resultsSnapshot: unknown;
};

export function FeedbackPanel({
  city,
  cuisines,
  parsed,
  restaurants,
  resultsSnapshot,
}: Props) {
  const { t } = useT();
  const create = useServerFn(createSearchSession);
  const submit = useServerFn(submitSearchFeedback);

  const DOWN_REASONS = [
    { key: "feedback.down.r1", text: t("feedback.down.r1") },
    { key: "feedback.down.r2", text: t("feedback.down.r2") },
    { key: "feedback.down.r3", text: t("feedback.down.r3") },
    { key: "feedback.down.r4", text: t("feedback.down.r4") },
    { key: "feedback.down.r5", text: t("feedback.down.r5") },
  ];

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [externalName, setExternalName] = useState("");
  const [showExternal, setShowExternal] = useState(false);
  const [overall, setOverall] = useState<"up" | "down" | null>(null);
  const [downReasons, setDownReasons] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await create({
          data: {
            anonId: getAnonId(),
            city,
            cuisines,
            parsed,
            results: resultsSnapshot,
          },
        });
        if (!cancelled) setSessionId(res.sessionId);
      } catch (e) {
        console.warn("[feedback] create session failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restaurantOptions = useMemo(() => {
    return restaurants.map((r) => ({
      id: r.id,
      label: r.localName?.trim() || r.name,
    }));
  }, [restaurants]);

  if (submitted) {
    return (
      <div className="mt-10 bg-card border border-border rounded-2xl p-6 text-center text-sm text-muted-foreground">
        {t("feedback.thanks")}
      </div>
    );
  }

  const canSubmit = overall !== null && !!sessionId;

  const handleSubmit = async () => {
    if (!canSubmit || !sessionId) return;
    setError(null);
    try {
      const res = await submit({
        data: {
          sessionId,
          chosenFromResults: chosenId,
          chosenExternalName:
            showExternal && externalName.trim() ? externalName.trim() : null,
          overall: overall!,
          downReasons: overall === "down" ? downReasons : [],
          comment: comment.trim() ? comment.trim() : null,
        },
      });
      if (res.ok) setSubmitted(true);
      else setError(res.error || t("feedback.submitFail"));
    } catch (e) {
      console.error(e);
      setError(t("feedback.submitFail"));
    }
  };

  const toggleReason = (r: string) => {
    setDownReasons((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r],
    );
  };

  return (
    <section className="mt-10 bg-card border border-border rounded-2xl p-6">
      <h3 className="text-base font-semibold tracking-tight">{t("feedback.title")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("feedback.note")}</p>

      <div className="mt-5">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          {t("feedback.chosenLabel")}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {restaurantOptions.map((r) => {
            const active = chosenId === r.id;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setChosenId(active ? null : r.id);
                  if (!active) setShowExternal(false);
                }}
                className={`px-2.5 py-1 text-xs rounded-full border transition ${
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background border-border hover:border-primary"
                }`}
              >
                {active ? "✓ " : ""}
                {r.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              setShowExternal((v) => !v);
              if (!showExternal) setChosenId(null);
            }}
            className={`px-2.5 py-1 text-xs rounded-full border transition ${
              showExternal
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background border-border hover:border-primary"
            }`}
          >
            {t("feedback.external")}
          </button>
        </div>
        {showExternal && (
          <input
            type="text"
            value={externalName}
            onChange={(e) => setExternalName(e.target.value.slice(0, 200))}
            placeholder={t("feedback.externalPlaceholder")}
            className="mt-2 w-full px-3 py-2 text-sm rounded-lg bg-background border border-border focus:outline-none focus:border-primary"
          />
        )}
      </div>

      <div className="mt-5">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          {t("feedback.qualityLabel")}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setOverall("up")}
            className={`flex-1 py-2.5 text-sm rounded-lg border transition ${
              overall === "up"
                ? "bg-success/15 border-success text-success font-medium"
                : "bg-background border-border hover:border-success"
            }`}
          >
            {t("feedback.up")}
          </button>
          <button
            type="button"
            onClick={() => setOverall("down")}
            className={`flex-1 py-2.5 text-sm rounded-lg border transition ${
              overall === "down"
                ? "bg-destructive/10 border-destructive text-destructive font-medium"
                : "bg-background border-border hover:border-destructive"
            }`}
          >
            {t("feedback.down")}
          </button>
        </div>
      </div>

      {overall === "down" && (
        <div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            {t("feedback.downLabel")}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {DOWN_REASONS.map((r) => {
              const active = downReasons.includes(r.text);
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => toggleReason(r.text)}
                  className={`px-2.5 py-1 text-xs rounded-full border transition ${
                    active
                      ? "bg-destructive/10 text-destructive border-destructive"
                      : "bg-background border-border hover:border-destructive/50"
                  }`}
                >
                  {active ? "✓ " : ""}
                  {r.text}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {overall !== null && (
        <div className="mt-4">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, 500))}
            placeholder={t("feedback.commentPlaceholder")}
            rows={2}
            className="w-full px-3 py-2 text-sm rounded-lg bg-background border border-border focus:outline-none focus:border-primary resize-none"
          />
        </div>
      )}

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="mt-5 flex justify-end">
        <Button onClick={handleSubmit} disabled={!canSubmit} size="sm">
          {t("feedback.submit")}
        </Button>
      </div>
    </section>
  );
}
