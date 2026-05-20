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
  const { lang, t } = useT();
  const create = useServerFn(createSearchSession);
  const submit = useServerFn(submitSearchFeedback);

  const DOWN_REASONS = [
    { key: "feedback.down.r1", text: t("feedback.down.r1") },
    { key: "feedback.down.r2", text: t("feedback.down.r2") },
    { key: "feedback.down.r3", text: t("feedback.down.r3") },
    { key: "feedback.down.r4", text: t("feedback.down.r4") },
    { key: "feedback.down.r5", text: t("feedback.down.r5") },
  ];

  const CHOSEN_REASONS = [
    { key: "feedback.chosen.r1", text: t("feedback.chosen.r1") },
    { key: "feedback.chosen.r2", text: t("feedback.chosen.r2") },
    { key: "feedback.chosen.r3", text: t("feedback.chosen.r3") },
    { key: "feedback.chosen.r4", text: t("feedback.chosen.r4") },
    { key: "feedback.chosen.r5", text: t("feedback.chosen.r5") },
  ];

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [externalName, setExternalName] = useState("");
  const [showExternal, setShowExternal] = useState(false);
  const [rating, setRating] = useState<number>(0);
  const [hoverRating, setHoverRating] = useState<number>(0);
  const [downReasons, setDownReasons] = useState<string[]>([]);
  const [chosenReasons, setChosenReasons] = useState<string[]>([]);
  const [wouldRecommend, setWouldRecommend] = useState<boolean | null>(null);
  const [contact, setContact] = useState("");
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const restaurantCount = restaurants.length;
        const res = await create({
          data: {
            anonId: getAnonId(),
            city,
            cuisines,
            parsed,
            results: resultsSnapshot,
            lang,
            resultCount: restaurantCount,
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

  const canSubmit = rating > 0 && !!sessionId;
  const showDownReasons = rating > 0 && rating <= 3;
  const showChosenReasons = rating >= 4 && (chosenId || (showExternal && externalName.trim()));

  const handleSubmit = async () => {
    if (!canSubmit || !sessionId) return;
    setError(null);
    if (contact.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim())) {
      setError(t("feedback.contactInvalid"));
      return;
    }
    try {
      const res = await submit({
        data: {
          sessionId,
          chosenFromResults: chosenId,
          chosenExternalName:
            showExternal && externalName.trim() ? externalName.trim() : null,
          rating,
          downReasons: showDownReasons ? downReasons : [],
          chosenReasons: rating >= 4 ? chosenReasons : [],
          wouldRecommend,
          contact: contact.trim() || null,
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

  const toggleDown = (r: string) => {
    setDownReasons((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r],
    );
  };
  const toggleChosen = (r: string) => {
    setChosenReasons((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r],
    );
  };

  const ratingLabels = [
    "",
    t("feedback.star.1"),
    t("feedback.star.2"),
    t("feedback.star.3"),
    t("feedback.star.4"),
    t("feedback.star.5"),
  ];

  return (
    <section className="mt-10 bg-card border border-border rounded-2xl p-6">
      <h3 className="text-base font-semibold tracking-tight">{t("feedback.title")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("feedback.note")}</p>

      <div className="mt-5">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          {t("feedback.ratingLabel")}
        </div>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => {
            const active = (hoverRating || rating) >= n;
            return (
              <button
                key={n}
                type="button"
                onMouseEnter={() => setHoverRating(n)}
                onMouseLeave={() => setHoverRating(0)}
                onClick={() => setRating(n)}
                className={`text-2xl leading-none transition ${
                  active ? "text-amber-400" : "text-muted-foreground/30"
                }`}
                aria-label={`${n} star${n > 1 ? "s" : ""}`}
              >
                ★
              </button>
            );
          })}
          <span className="ml-2 text-xs text-muted-foreground">
            {(hoverRating || rating) > 0 ? ratingLabels[hoverRating || rating] : ""}
          </span>
        </div>
      </div>

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

      {showDownReasons && (
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
                  onClick={() => toggleDown(r.text)}
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

      {showChosenReasons && (
        <div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            {t("feedback.chosenReasonLabel")}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CHOSEN_REASONS.map((r) => {
              const active = chosenReasons.includes(r.text);
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => toggleChosen(r.text)}
                  className={`px-2.5 py-1 text-xs rounded-full border transition ${
                    active
                      ? "bg-success/15 text-success border-success"
                      : "bg-background border-border hover:border-success/50"
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

      {rating > 0 && (
        <div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            {t("feedback.recommendLabel")}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setWouldRecommend(wouldRecommend === true ? null : true)}
              className={`px-3 py-1.5 text-xs rounded-full border transition ${
                wouldRecommend === true
                  ? "bg-success/15 border-success text-success"
                  : "bg-background border-border hover:border-success"
              }`}
            >
              {t("feedback.recommendYes")}
            </button>
            <button
              type="button"
              onClick={() => setWouldRecommend(wouldRecommend === false ? null : false)}
              className={`px-3 py-1.5 text-xs rounded-full border transition ${
                wouldRecommend === false
                  ? "bg-destructive/10 border-destructive text-destructive"
                  : "bg-background border-border hover:border-destructive"
              }`}
            >
              {t("feedback.recommendNo")}
            </button>
          </div>
        </div>
      )}

      {rating > 0 && (
        <div className="mt-4">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, 500))}
            placeholder={t("feedback.commentPlaceholder")}
            rows={2}
            className="w-full px-3 py-2 text-sm rounded-lg bg-background border border-border focus:outline-none focus:border-primary resize-none"
          />
          <input
            type="email"
            value={contact}
            onChange={(e) => setContact(e.target.value.slice(0, 200))}
            placeholder={t("feedback.contactPlaceholder")}
            className="mt-2 w-full px-3 py-2 text-sm rounded-lg bg-background border border-border focus:outline-none focus:border-primary"
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
