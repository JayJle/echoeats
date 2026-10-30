import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight, CheckCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useQueryStore, useStoreHydrated } from "@/lib/store";
import { useT } from "@/lib/i18n/context";
import { parseRequirements, searchRestaurants, consumeSearchStream } from "@/lib/echo.functions";

// Root-owned work survives navigation between the needs and results pages.
export function ResearchNotice() {
  const hydrated = useStoreHydrated();
  const job = useQueryStore((s) => s.researchJob);
  const pending = useQueryStore((s) => s.pendingResults);
  const error = useQueryStore((s) => s.researchError);
  const { t } = useT();
  const navigate = useNavigate();
  const parseFn = useServerFn(parseRequirements);
  const searchFn = useServerFn(searchRestaurants);
  const [promptOpen, setPromptOpen] = useState(false);

  useEffect(() => {
    if (!job) return;
    const ac = new AbortController();
    let lastDataAt = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastDataAt > 90_000) {
        stalled = true;
        ac.abort();
        useQueryStore.getState().failResearch(job, "err.searchStalled");
      }
    }, 5_000);
    void (async () => {
      try {
        const parsed = job.reparse ? await parseFn({
          data: { city: job.parsed.city, cuisines: job.parsed.cuisines, date: "", freeText: job.freeText, uiLanguage: job.language, autoInferCuisines: job.autoInferCuisines },
          signal: ac.signal,
        } as Parameters<typeof parseFn>[0]) : job.parsed;
        if (ac.signal.aborted) return;
        lastDataAt = Date.now();
        const next = { ...parsed, mode: (job.parsed as { mode?: "quick" | "deep" }).mode ?? "deep", uiLanguage: job.language };
        const stream = await searchFn({ data: next, signal: ac.signal } as Parameters<typeof searchFn>[0]);
        const results = await consumeSearchStream(stream, () => { lastDataAt = Date.now(); });
        if (ac.signal.aborted) return;
        if (results.error && results.groups.length === 0) throw new Error(results.error);
        useQueryStore.getState().finishResearch(job, { parsed: next, results, freeText: job.freeText });
      } catch (err) {
        if (ac.signal.aborted && !stalled) return;
        const message = err instanceof Error ? err.message : "err.fetchFailed";
        useQueryStore.getState().failResearch(job, message.includes("429") ? "err.rateLimited" : message.includes("402") ? "err.quotaExhausted" : message);
      } finally {
        clearInterval(watchdog);
      }
    })();
    return () => { ac.abort(); clearInterval(watchdog); };
  }, [job, parseFn, searchFn]);

  useEffect(() => { setPromptOpen(!!pending); }, [pending]);

  const viewResults = () => {
    useQueryStore.getState().viewPendingResults();
    setPromptOpen(false);
    void navigate({ to: "/results" }).then(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  };

  if (!hydrated || (!job && !pending && !error)) return null;
  return <>
    <aside aria-live="polite" className="fixed bottom-4 left-4 right-4 z-40 mx-auto max-w-xl rounded-lg border-2 border-primary bg-background px-4 py-3 shadow-lg sm:left-auto sm:mx-0 sm:w-[26rem]">
      <div className="flex items-center gap-3">
        {job ? <Loader2 aria-hidden className="h-5 w-5 shrink-0 text-primary motion-safe:animate-spin" /> : <CheckCheck aria-hidden className="h-5 w-5 shrink-0 text-primary" />}
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold">{job ? t("results.refining") : pending ? t("research.ready") : t("research.failed")}</p>
          {error && <p className="mt-1 break-words text-destructive">{t(error)}</p>}
        </div>
        {pending && <Button onClick={viewResults} className="shrink-0">{t("research.view")}<ArrowRight aria-hidden className="ml-2 h-4 w-4" /></Button>}
        {job && <Button variant="outline" size="sm" onClick={() => useQueryStore.getState().cancelResearch()}>{t("results.cancelSearch")}</Button>}
        {!job && !pending && error && <Button variant="ghost" size="sm" onClick={() => useQueryStore.getState().cancelResearch()}>{t("common.cancel")}</Button>}
      </div>
    </aside>
    <AlertDialog open={promptOpen && !!pending} onOpenChange={setPromptOpen}>
      <AlertDialogContent className="w-[calc(100%-2rem)] rounded-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("research.ready")}</AlertDialogTitle>
          <AlertDialogDescription>{t("research.readyDesc")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("research.later")}</AlertDialogCancel>
          <AlertDialogAction onClick={viewResults}>{t("research.view")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}