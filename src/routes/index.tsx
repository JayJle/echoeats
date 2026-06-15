import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { FormEvent, useState } from "react";
import { Loader2, MapPin } from "lucide-react";
import { StepShell } from "@/components/StepShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useQueryStore } from "@/lib/store";
import { useT } from "@/lib/i18n/context";
import {
  validateCity,
  type CityValidationCandidate,
  type CityValidationResult,
} from "@/lib/city.functions";

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
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<CityValidationCandidate[]>([]);
  const validateCityFn = useServerFn(validateCity);
  const { t } = useT();

  const continueWithCity = (candidate: CityValidationCandidate) => {
    setCity(candidate.displayName);
    setCandidates([]);
    navigate({ to: "/cuisines" });
  };

  const handleResult = (result: CityValidationResult) => {
    if (result.status === "confirmed") {
      continueWithCity(result.candidate);
      return;
    }
    if (result.status === "choose") {
      setCandidates(result.candidates);
      return;
    }
    const key =
      result.status === "invalid"
        ? "step1.invalid"
        : result.status === "not_found"
          ? "step1.notFound"
          : result.status === "unsupported_region"
            ? "step1.unsupportedRegion"
            : "step1.unavailable";
    setError(t(key));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.normalize("NFKC").trim();
    if (!trimmed || isChecking) return;
    setError("");
    setIsChecking(true);
    try {
      const result = await validateCityFn({ data: { city: trimmed } });
      handleResult(result);
    } catch {
      setError(t("step1.unavailable"));
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <StepShell step={1} total={3} title={t("step1.title")}>
      <form onSubmit={onSubmit} className="space-y-6">
        <Input
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError("");
          }}
          placeholder={t("step1.placeholder")}
          className="h-12 text-base"
          maxLength={80}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "city-error" : undefined}
        />
        {error ? <p id="city-error" className="text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={!value.trim() || isChecking} size="lg">
            {isChecking ? <><Loader2 className="animate-spin" />{t("step1.checking")}</> : t("common.next")}
          </Button>
        </div>
      </form>

      <AlertDialog open={candidates.length > 0} onOpenChange={(open) => !open && setCandidates([])}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("step1.chooseTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("step1.chooseDesc", { city: value.trim() })}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            {candidates.map((candidate) => (
              <Button
                key={candidate.placeId}
                type="button"
                variant="outline"
                className="h-auto justify-start whitespace-normal px-4 py-3 text-left"
                onClick={() => continueWithCity(candidate)}
              >
                <MapPin className="shrink-0 text-primary" />
                <span>
                  <span className="block font-medium">{candidate.city}</span>
                  {candidate.countryOrRegion ? <span className="block text-xs text-muted-foreground">{candidate.countryOrRegion}</span> : null}
                </span>
              </Button>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </StepShell>

  );
}
