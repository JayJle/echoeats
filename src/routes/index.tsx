import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FormEvent, useState } from "react";
import { Info } from "lucide-react";
import { StepShell } from "@/components/StepShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useQueryStore } from "@/lib/store";
import { useT } from "@/lib/i18n/context";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Echo Eats — AI Restaurant Discovery Agent" },
      {
        name: "description",
        content:
          "Describe what you want in one sentence. Echo Eats searches across platforms, reads the reviews, and finds the best match.",
      },
    ],
  }),
  component: StepCity,
});

function StepCity() {
  const navigate = useNavigate();
  const city = useQueryStore((s) => s.city);
  const setCity = useQueryStore((s) => s.setCity);
  const [value, setValue] = useState(city);
  const { t } = useT();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setCity(value.trim());
    navigate({ to: "/cuisines" });
  };

  return (
    <StepShell step={1} total={3} title={t("step1.title")} hint={t("step1.hint")}>
      <form onSubmit={onSubmit} className="space-y-6">
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("step1.placeholder")}
          className="h-12 text-base"
          maxLength={80}
        />
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
          <span>{t("home.notice.dianping")}</span>
        </p>
        <div className="flex justify-end">
          <Button type="submit" disabled={!value.trim()} size="lg">
            {t("common.next")}
          </Button>
        </div>
      </form>
    </StepShell>
  );
}
