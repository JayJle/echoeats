import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { FormEvent, useState } from "react";
import { StepShell } from "@/components/StepShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useQueryStore } from "@/lib/store";
import { useT } from "@/lib/i18n/context";
import { CUISINE_SUGGESTIONS } from "@/lib/i18n/dict";

export const Route = createFileRoute("/cuisines")({
  head: () => ({
    meta: [
      { title: "Echo Eats — Pick a cuisine" },
      { name: "description", content: "Choose the cuisine you're in the mood for." },
    ],
  }),
  component: StepCuisines,
});

function fallbackWord(lang: string): string {
  if (lang === "ja") return "レストラン";
  if (lang === "ko") return "음식점";
  if (lang === "zh") return "餐厅";
  return "restaurants";
}

function uniqueCuisines(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.normalize("NFKC").trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function StepCuisines() {
  const navigate = useNavigate();
  const cuisines = useQueryStore((s) => s.cuisines);
  const setCuisines = useQueryStore((s) => s.setCuisines);
  const setAutoInferCuisines = useQueryStore((s) => s.setAutoInferCuisines);
  const { lang, t } = useT();

  const sep = lang === "zh" ? "，" : ", ";
  const [value, setValue] = useState(uniqueCuisines(cuisines).join(sep));
  const [skipDialogOpen, setSkipDialogOpen] = useState(false);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const list = uniqueCuisines(value.split(/[，,、\s]+/));
    if (!list.length) return;
    setCuisines(list);
    setAutoInferCuisines(false);
    navigate({ to: "/requirements" });
  };

  const addSuggestion = (s: string) => {
    const current = value.trim();
    if (current.split(/[，,、\s]+/).includes(s)) return;
    setValue(current ? `${current}${sep}${s}` : s);
  };

  const chooseAutoInfer = () => {
    setCuisines([]);
    setAutoInferCuisines(true);
    setSkipDialogOpen(false);
    navigate({ to: "/requirements" });
  };

  const chooseSearchAll = () => {
    setCuisines([fallbackWord(lang)]);
    setAutoInferCuisines(false);
    setSkipDialogOpen(false);
    navigate({ to: "/requirements" });
  };

  return (
    <StepShell step={2} total={3} title={t("step2.title")} hint={t("step2.hint")}>
      <form onSubmit={onSubmit} className="space-y-6">
        <div className="space-y-2">
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("step2.placeholder")}
            className="h-12 text-base"
            maxLength={200}
          />
          <div className="flex flex-wrap gap-2 pt-1">
            {CUISINE_SUGGESTIONS.map((s) => {
              const label = s[lang];
              return (
                <button
                  type="button"
                  key={label}
                  onClick={() => addSuggestion(label)}
                  className="px-3 py-1.5 text-xs rounded-full bg-secondary text-secondary-foreground hover:bg-accent transition-colors"
                >
                  + {label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <Link
            to="/"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("common.back")}
          </Link>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSkipDialogOpen(true)}
              size="lg"
            >
              {t("common.skip")}
            </Button>
            <Button type="submit" disabled={!value.trim()} size="lg">
              {t("common.next")}
            </Button>
          </div>
        </div>
      </form>

      <AlertDialog open={skipDialogOpen} onOpenChange={setSkipDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("cuisines.skipDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("cuisines.skipDialog.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={chooseSearchAll}>
              {t("cuisines.skipDialog.all")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={chooseAutoInfer}>
              {t("cuisines.skipDialog.auto")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </StepShell>
  );
}
