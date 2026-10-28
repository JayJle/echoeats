import { X } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import type { ParsedRequirements, WeightedCondition } from "@/lib/store";
import { PROMOTE_AT } from "@/lib/weights";
import { useT } from "@/lib/i18n/context";

type Bucket = "hardFilters" | "softPreferences" | "negativeFilters";

export function WeightEditor({
  draft,
  onChange,
}: {
  draft: ParsedRequirements;
  onChange: (p: ParsedRequirements) => void;
}) {
  const { t } = useT();
  const update = (b: Bucket, i: number, patch: Partial<WeightedCondition> | null) => {
    const arr = [...draft[b]];
    if (patch === null) arr.splice(i, 1);
    else arr[i] = { ...arr[i], ...patch };
    onChange({ ...draft, [b]: arr });
  };
  const move = (from: Bucket, to: Bucket, i: number) => {
    const item = draft[from][i];
    const weight = to === "softPreferences" ? Math.min(item.weight, 0.7) : Math.max(item.weight, PROMOTE_AT);
    onChange({
      ...draft,
      [from]: draft[from].filter((_, j) => j !== i),
      [to]: [...draft[to], { ...item, weight }],
    });
  };

  const groups: { b: Bucket; label: string }[] = [
    { b: "hardFilters", label: t("weights.must") },
    { b: "softPreferences", label: t("weights.nice") },
    { b: "negativeFilters", label: t("weights.avoid") },
  ];

  return (
    <div className="space-y-3">
      {groups.map(({ b, label }) =>
        draft[b].length === 0 ? null : (
          <div key={b} className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            {draft[b].map((c, i) => (
              <div key={`${b}-${i}`} className="rounded-md border border-border/60 p-2 space-y-1.5">
                <div className="flex items-start gap-2">
                  <span className="flex-1 text-xs">{c.text}</span>
                  <span className="text-xs tabular-nums font-medium">{c.weight.toFixed(1)}</span>
                  <button type="button" aria-label={t("weights.remove")} onClick={() => update(b, i, null)} className="text-muted-foreground hover:text-destructive">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <Slider
                  min={0.1} max={1} step={0.1} value={[c.weight]}
                  onValueChange={([v]) => update(b, i, { weight: Math.round(v * 10) / 10 })}
                />
                {b === "softPreferences" && c.weight >= PROMOTE_AT && (
                  <p className="text-[11px] text-primary">{t("weights.promoteHint")}</p>
                )}
                {b !== "negativeFilters" && (
                  <Button
                    type="button" variant="link" size="sm" className="h-auto p-0 text-[11px]"
                    onClick={() => move(b, b === "hardFilters" ? "softPreferences" : "hardFilters", i)}
                  >
                    {b === "hardFilters" ? t("weights.toNice") : t("weights.toMust")}
                  </Button>
                )}
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}
