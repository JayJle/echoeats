import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Pencil } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { FeedbackPanel } from "@/components/FeedbackPanel";
import { Restaurant, useQueryStore } from "@/lib/store";
import { useT } from "@/lib/i18n/context";
import { LanguageToggle } from "@/components/LanguageToggle";
import { parseRequirements, searchRestaurants, consumeSearchStream } from "@/lib/echo.functions";

export const Route = createFileRoute("/results")({
  head: () => ({
    meta: [
      { title: "Echo Eats — Results" },
      { name: "description", content: "Restaurant picks from an AI cross-platform search." },
    ],
  }),
  component: ResultsPage,
});

function todayHoursLabel(
  weekdayDescriptions: string[] | null | undefined,
  openNow: boolean,
  t: (k: string, v?: Record<string, string | number>) => string,
): string {
  if (!weekdayDescriptions?.length) {
    return openNow ? t("results.hoursOpenNoInfo") : t("results.hoursClosed");
  }
  const idx = (new Date().getDay() + 6) % 7;
  const line = weekdayDescriptions[idx] ?? weekdayDescriptions[0];
  return line.replace(/^[^:：]+[:：]\s*/, "");
}

function ResultsPage() {
  const navigate = useNavigate();
  const { lang, t } = useT();
  const parsed = useQueryStore((s) => s.parsed);
  const results = useQueryStore((s) => s.results);
  const freeText = useQueryStore((s) => s.freeText);
  const setResults = useQueryStore((s) => s.setResults);
  const setParsed = useQueryStore((s) => s.setParsed);
  const setFreeText = useQueryStore((s) => s.setFreeText);

  const searchFn = useServerFn(searchRestaurants);
  const parseFn = useServerFn(parseRequirements);

  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(freeText);
  const conditionsRef = useRef<HTMLDivElement>(null);

  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);

  useEffect(() => () => {
    abortRef.current?.abort();
  }, []);

  if (!results || !parsed) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-xl font-semibold tracking-tight">{t("results.empty.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("results.empty.desc")}</p>
          <div className="flex justify-center gap-2">
            <Link to="/" className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              {t("results.empty.home")}
            </Link>
            <Link to="/requirements" className="inline-flex items-center justify-center rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-accent">
              {t("results.empty.requirements")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const isEmpty = results.groups.length === 0;
  const TIER_LABEL: Record<Restaurant["matchTier"], string> = {
    perfect: t("results.tier.perfect"),
    high: t("results.tier.high"),
    partial: t("results.tier.partial"),
  };
  const TIER_CLASS: Record<Restaurant["matchTier"], string> = {
    perfect: "bg-primary text-primary-foreground",
    high: "bg-accent text-accent-foreground",
    partial: "bg-secondary text-secondary-foreground",
  };
  const weekdayShort = t("results.weekday.short").split(",");

  const cancelRefine = () => {
    abortRef.current?.abort();
    runIdRef.current += 1;
    setRefining(false);
    setRefineError(null);
  };

  const buildParsedForSearch = () => ({ ...parsed, uiLanguage: lang });

  const runSearchAgain = async () => {
    setRefineError(null);
    setRefining(true);
    runIdRef.current += 1;
    const myRunId = runIdRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const iter = await searchFn({ data: buildParsedForSearch(), signal: ac.signal } as Parameters<typeof searchFn>[0]);
      const response = await consumeSearchStream(iter);
      if (myRunId !== runIdRef.current || ac.signal.aborted) return;
      setResults(response);
    } catch (err) {
      if (ac.signal.aborted || myRunId !== runIdRef.current) return;
      const msg = err instanceof Error ? err.message : t("err.fetchFailed");
      setRefineError(msg.includes("429") ? t("err.rateLimited") : msg);
    } finally {
      if (myRunId === runIdRef.current) setRefining(false);
    }
  };

  const openEditor = () => {
    setDraftText(freeText);
    setEditing(true);
    setTimeout(() => {
      conditionsRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
  };

  const applyEdit = async () => {
    if (!parsed) return;
    const text = draftText.trim();
    setRefineError(null);
    setRefining(true);
    runIdRef.current += 1;
    const myRunId = runIdRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const newParsed = await parseFn({
        data: { city: parsed.city, cuisines: parsed.cuisines, date: "", freeText: text, uiLanguage: lang },
        signal: ac.signal,
      } as Parameters<typeof parseFn>[0]);
      if (myRunId !== runIdRef.current || ac.signal.aborted) return;

      const newTotal =
        (newParsed.hardFilters?.length ?? 0) +
        (newParsed.softPreferences?.length ?? 0) +
        (newParsed.negativeFilters?.length ?? 0) +
        (newParsed.dishPreferences?.length ?? 0);
      const oldTotal =
        parsed.hardFilters.length + parsed.softPreferences.length +
        parsed.negativeFilters.length + parsed.dishPreferences.length;
      const parseLikelyEmpty = newTotal === 0 && oldTotal > 0;

      const merged = parseLikelyEmpty
        ? { ...parsed, mode: (parsed as { mode?: "quick" | "deep" }).mode ?? "deep", uiLanguage: lang }
        : {
            ...newParsed,
            city: newParsed.city || parsed.city,
            cuisines: newParsed.cuisines?.length ? newParsed.cuisines : parsed.cuisines,
            mode: (parsed as { mode?: "quick" | "deep" }).mode ?? "deep",
            uiLanguage: lang,
          };
      setFreeText(text);
      setParsed(merged);
      const iter = await searchFn({ data: merged, signal: ac.signal } as Parameters<typeof searchFn>[0]);
      const response = await consumeSearchStream(iter);
      if (myRunId !== runIdRef.current || ac.signal.aborted) return;
      setResults(response);
      setEditing(false);
    } catch (err) {
      if (ac.signal.aborted || myRunId !== runIdRef.current) return;
      const msg = err instanceof Error ? err.message : t("err.fetchFailed");
      if (msg.includes("429")) setRefineError(t("err.rateLimited"));
      else if (msg.includes("402")) setRefineError(t("err.quotaExhausted"));
      else setRefineError(msg);
    } finally {
      if (myRunId === runIdRef.current) setRefining(false);
    }
  };

  const restartFlow = () => {
    useQueryStore.getState().reset();
    navigate({ to: "/" });
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="px-6 py-5 flex items-center justify-between border-b border-border/60">
        <Link to="/" className="font-semibold tracking-tight">
          Echo <span className="text-primary">Eats</span>
        </Link>
        <div className="flex items-center gap-2">
          <LanguageToggle />
          <Button
            variant="outline"
            size="sm"
            onClick={runSearchAgain}
            disabled={refining}
          >
            {t("results.header.refetch")}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm">{t("results.header.restart")}</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("results.confirm.title")}</AlertDialogTitle>
                <AlertDialogDescription>{t("results.confirm.desc")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={restartFlow}>{t("results.confirm.ok")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </header>

      {refining && (
        <div className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-card border border-border rounded-2xl px-6 py-5 shadow-lg text-sm flex flex-col items-center gap-3">
            <p>{t("results.refining")}</p>
            <Button type="button" variant="ghost" size="sm" onClick={cancelRefine}>
              {t("results.cancelSearch")}
            </Button>
          </div>
        </div>
      )}

      <main className="max-w-3xl mx-auto px-4 py-10">
        <div ref={conditionsRef} className="mb-6 bg-card border border-border rounded-2xl p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">{t("results.label")}</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight flex flex-wrap items-center gap-x-2 gap-y-2">
                <span>{parsed.city} ·</span>
                {parsed.cuisines.map((c, i) => (
                  <span
                    key={i}
                    className={
                      parsed.cuisinesInferred
                        ? "inline-flex items-center px-2.5 py-0.5 text-base font-medium rounded-full bg-primary/10 text-primary border border-primary/20"
                        : "inline-flex items-center px-2.5 py-0.5 text-base font-medium rounded-full bg-muted text-foreground border border-border"
                    }
                  >
                    {parsed.cuisinesInferred && <span className="mr-1">✨</span>}
                    {c}
                  </span>
                ))}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">{parsed.dateTime}</p>
            </div>
          </div>
          {parsed.visitTime?.weekday != null && parsed.visitTime?.hhmm && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">{t("results.openHours")}</p>
              <div className="flex flex-wrap gap-1.5">
                <span className="px-2 py-0.5 text-xs rounded-full bg-primary/15 text-primary border border-primary/30">
                  🕐 {parsed.visitTime.raw || t("results.visit.defaultRaw")}{" "}
                  <span className="opacity-60">
                    {t("results.weekdayPrefix", { day: weekdayShort[parsed.visitTime.weekday], time: parsed.visitTime.hhmm })}
                  </span>
                </span>
              </div>
            </div>
          )}
          {parsed.hardFilters.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">{t("results.hardFilters")}</p>
              <div className="flex flex-wrap gap-1.5">
                {parsed.hardFilters.map((f, i) => (
                  <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-primary/15 text-primary border border-primary/30">
                    {f.text} <span className="opacity-60">· {f.weight.toFixed(1)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {parsed.softPreferences.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">{t("results.softPrefs")}</p>
              <div className="flex flex-wrap gap-1.5">
                {parsed.softPreferences.map((f, i) => (
                  <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-secondary text-secondary-foreground">
                    {f.text} <span className="opacity-60">· {f.weight.toFixed(1)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {parsed.negativeFilters.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">{t("results.negative")}</p>
              <div className="flex flex-wrap gap-1.5">
                {parsed.negativeFilters.map((f, i) => (
                  <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-destructive/10 text-destructive border border-destructive/30">
                    {f.text} <span className="opacity-60">· {f.weight.toFixed(1)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {parsed.dishPreferences.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">{t("results.dishes")}</p>
              <div className="flex flex-wrap gap-1.5">
                {parsed.dishPreferences.map((f, i) => (
                  <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-accent text-accent-foreground">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}
          {freeText && !editing && (
            <details className="mt-3">
              <summary className="text-[11px] uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground">{t("results.rawDesc")}</summary>
              <p className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">{freeText}</p>
            </details>
          )}
          {!editing && (
            <Button
              type="button"
              variant="outline"
              onClick={openEditor}
              disabled={refining}
              className="mt-5 w-full"
            >
              <Pencil className="w-4 h-4 mr-2" />
              {t("results.edit")}
            </Button>
          )}
          {editing && (
            <div className="mt-4 pt-4 border-t border-border space-y-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {t("results.editTitle")}
              </p>
              <Textarea
                autoFocus
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                maxLength={1000}
                disabled={refining}
                className="min-h-[120px] text-sm resize-none"
                placeholder={t("results.editPlaceholder")}
              />
              <p className="text-xs text-muted-foreground">{t("results.editHint")}</p>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(false);
                    setDraftText(freeText);
                  }}
                  disabled={refining}
                >
                  {t("common.cancel")}
                </Button>
                {refining ? (
                  <Button type="button" variant="outline" size="sm" onClick={cancelRefine}>
                    {t("results.cancelSearch")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void applyEdit()}
                    disabled={draftText.trim() === freeText.trim()}
                  >
                    {t("results.applyEdit")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {refineError && (
          <div className="mb-6 text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
            {refineError}
          </div>
        )}

        {results.error && (
          <div className="mb-6 bg-warning/10 border border-warning/30 rounded-2xl p-5">
            <p className="text-sm font-medium text-foreground">{results.error}</p>
            {results.suggestions.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
                {results.suggestions.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-primary">·</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">{t("results.disclaimer")}</p>
          </div>
        )}

        {isEmpty ? (
          <div className="bg-card border border-border rounded-2xl p-8 text-center">
            <p className="text-base font-medium">{t("results.noneTitle")}</p>
            <p className="mt-2 text-sm text-muted-foreground">{t("results.noneDesc")}</p>
            <Button asChild className="mt-5">
              <Link to="/requirements">{t("results.noneBack")}</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-10">
            {results.groups.map((group) => (
              <section key={group.cuisine}>
                <h2 className="mb-4 text-lg font-semibold tracking-tight border-l-4 border-primary pl-3">
                  {group.cuisine}
                </h2>
                <div className="space-y-5">
                  {group.restaurants.map((r, i) => (
                    <RestaurantCard key={r.id} index={i + 1} r={r} tierLabel={TIER_LABEL} tierClass={TIER_CLASS} />
                  ))}
                </div>

                {group.partialRestaurants && group.partialRestaurants.length > 0 && (
                  <div className="mt-8">
                    <div className="mb-3 border-l-4 border-warning pl-3">
                      <h3 className="text-base font-semibold tracking-tight">
                        {t("results.partialTitle")}
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">{t("results.partialDesc")}</p>
                    </div>
                    <div className="space-y-5">
                      {group.partialRestaurants.map((r, i) => (
                        <RestaurantCard key={r.id} index={i + 1} r={r} tierLabel={TIER_LABEL} tierClass={TIER_CLASS} />
                      ))}
                    </div>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}

        {!isEmpty && (
          <FeedbackPanel
            city={parsed.city}
            cuisines={parsed.cuisines}
            parsed={parsed}
            restaurants={results.groups.flatMap((g) => [
              ...g.restaurants,
              ...(g.partialRestaurants ?? []),
            ])}
            resultsSnapshot={results}
          />
        )}

        <div className="mt-12 flex justify-center">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline">{t("results.searchAgain")}</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("results.confirm.title")}</AlertDialogTitle>
                <AlertDialogDescription>{t("results.confirm.desc")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={restartFlow}>{t("results.confirm.ok")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </main>
    </div>
  );
}

function RestaurantCard({ index, r, tierLabel, tierClass }: { index: number; r: Restaurant; tierLabel: Record<Restaurant["matchTier"], string>; tierClass: Record<Restaurant["matchTier"], string> }) {
  const { t } = useT();
  const visitTime = useQueryStore((s) => s.parsed?.visitTime ?? null);
  const showVisitBadge = Boolean(visitTime && r.visitTimeMatch);
  const displayName = r.localName?.trim() || r.name;

  return (
    <article className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
      <div className="p-6 flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">#{index}</div>
          <h3 className="mt-0.5 text-xl font-semibold tracking-tight">
            <a href={r.googleMapsUri} target="_blank" rel="noreferrer" className="hover:text-primary transition-colors">
              {displayName}
            </a>
          </h3>
          {r.primaryType && (
            <p className="text-xs text-muted-foreground mt-0.5">{r.primaryType}</p>
          )}
          {r.address && (
            <p className="mt-1 text-sm text-muted-foreground">📍 {r.address}</p>
          )}
          <p
            className="mt-0.5 text-sm text-muted-foreground"
            title={r.weekdayDescriptions?.join("\n") ?? undefined}
          >
            {t("results.todayHours", { label: todayHoursLabel(r.weekdayDescriptions, r.openNow, t) })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {showVisitBadge && r.visitTimeMatch === "open" && (
              <span className="px-2 py-0.5 rounded-full bg-success/15 text-success">
                {t("results.visit.open", { raw: visitTime?.raw || t("results.visit.defaultRaw") })}
              </span>
            )}
            {showVisitBadge && r.visitTimeMatch === "unknown" && (
              <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {t("results.visit.unknown", { raw: visitTime?.raw || t("results.visit.defaultRaw") })}
              </span>
            )}
            {r.openNow && !showVisitBadge && (
              <span className="px-2 py-0.5 rounded-full bg-success/15 text-success">
                {t("results.openNow")}
              </span>
            )}
            {r.needsReview && (
              <span className="px-2 py-0.5 rounded-full bg-warning/15 text-warning">
                {t("results.needsReview")}
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${tierClass[r.matchTier]}`}>
            {tierLabel[r.matchTier]}
          </span>
          <div className="mt-2 text-2xl font-bold tracking-tight">{r.matchScore}%</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {t("results.matchScore")}
          </div>
        </div>
      </div>

      <div className="px-6 pb-2">
        {r.photoUrls && r.photoUrls.length > 0 ? (
          <div
            className="flex gap-2 overflow-x-auto snap-x snap-mandatory scroll-smooth -mx-1 px-1 pb-1"
            style={{ scrollbarWidth: "thin" }}
          >
            {r.photoUrls.map((url, i) => (
              <a
                key={i}
                href={r.googleMapsUri}
                target="_blank"
                rel="noreferrer"
                className="snap-start shrink-0 w-full aspect-[16/9] rounded-lg overflow-hidden bg-muted"
              >
                <img
                  src={url}
                  alt={`${displayName} ${i + 1}`}
                  loading="lazy"
                  className="w-full h-full object-cover hover:scale-105 transition-transform duration-500"
                />
              </a>
            ))}
          </div>
        ) : (
          <a
            href={`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(displayName + " " + (r.address || ""))}`}
            target="_blank"
            rel="noreferrer"
            className="block aspect-[16/9] rounded-lg bg-gradient-to-br from-accent to-secondary flex items-center justify-center text-xs text-muted-foreground hover:opacity-80 transition"
          >
            {t("results.imgSearch", { name: displayName })}
          </a>
        )}
      </div>

      <div className="px-6 py-4 border-t border-border">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          {t("results.ratings")}
        </h4>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          {r.ratings.map((rt) => (
            <div key={rt.platform} className="flex justify-between">
              <span className="text-muted-foreground">{rt.platform}</span>
              <span className="font-medium">{rt.score ?? t("results.noData")}</span>
            </div>
          ))}
        </div>
      </div>

      {r.tabelog && (
        <div className="px-6 py-4 border-t border-border bg-accent/20">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("results.tabelog.title")}
            </h4>
            <span className="text-[10px] text-muted-foreground">食べログ</span>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm mb-2">
            {r.tabelog.rating != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("results.tabelog.rating")}</span>
                <span className="font-medium">
                  {r.tabelog.rating}
                  {r.tabelog.reviewCount ? ` (${r.tabelog.reviewCount})` : ""}
                </span>
              </div>
            )}
            {r.tabelog.priceRange && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("results.tabelog.price")}</span>
                <span className="font-medium">{r.tabelog.priceRange}</span>
              </div>
            )}
          </div>
          {r.tabelog.summary && (
            <p className="text-sm leading-relaxed text-muted-foreground mb-2">
              "{r.tabelog.summary}"
            </p>
          )}
          {r.tabelog.url && (
            <a href={r.tabelog.url} target="_blank" rel="noreferrer" className="inline-block text-xs text-primary hover:underline">
              {t("results.tabelog.viewOn")}
            </a>
          )}
        </div>
      )}

      <div className="px-6 py-4 border-t border-border bg-muted/30">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          {t("results.aiSummary")}
        </h4>
        <p className="text-sm leading-relaxed">{r.aiSummary}</p>
      </div>

      <div className="px-6 py-4 border-t border-border">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          {t("results.matchDetails")}
        </h4>
        <ul className="space-y-1 text-sm">
          {r.matchDetails.map((d, i) => (
            <li key={i} className="flex gap-2">
              <span className={d.status === "ok" ? "text-success" : "text-warning"}>
                {d.status === "ok" ? "✓" : "⚠"}
              </span>
              <span>{d.label}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="px-6 py-4 border-t border-border grid sm:grid-cols-2 gap-4">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            {t("results.pros")}
          </h4>
          {r.pros.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {r.pros.map((p, i) => (
                <li key={i} className="text-foreground">
                  <span className="text-success mr-1">+</span>
                  {p}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground italic">{t("results.pros.empty")}</p>
          )}
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            {t("results.cons")}
          </h4>
          {r.cons.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {r.cons.map((c, i) => (
                <li key={i} className="text-foreground">
                  <span className="text-destructive mr-1">−</span>
                  {c}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground italic">{t("results.cons.empty")}</p>
          )}
        </div>
      </div>

      {r.links.length > 0 && (
        <div className="px-6 py-4 border-t border-border bg-muted/30 flex flex-wrap gap-2">
          {r.links.map((l, i) => (
            <a
              key={i}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 text-xs rounded-full bg-card border border-border hover:border-primary hover:text-primary transition-colors"
            >
              {l.label} ↗
            </a>
          ))}
        </div>
      )}
    </article>
  );
}
