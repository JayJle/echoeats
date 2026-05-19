import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { FormEvent, useState } from "react";
import { StepShell } from "@/components/StepShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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

function StepCuisines() {
  const navigate = useNavigate();
  const cuisines = useQueryStore((s) => s.cuisines);
  const setCuisines = useQueryStore((s) => s.setCuisines);
  const { lang, t } = useT();

  const sep = lang === "zh" ? "，" : ", ";
  const [value, setValue] = useState(cuisines.join(sep));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const list = value
      .split(/[，,、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length) return;
    setCuisines(list);
    navigate({ to: "/requirements" });
  };

  const addSuggestion = (s: string) => {
    const current = value.trim();
    if (current.split(/[，,、\s]+/).includes(s)) return;
    setValue(current ? `${current}${sep}${s}` : s);
  };

  const onSkip = () => {
    setCuisines([]);
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
            <Button type="button" variant="ghost" onClick={onSkip} size="lg">
              {t("common.skip")}
            </Button>
            <Button type="submit" disabled={!value.trim()} size="lg">
              {t("common.next")}
            </Button>
          </div>
        </div>
      </form>
    </StepShell>
  );
}
