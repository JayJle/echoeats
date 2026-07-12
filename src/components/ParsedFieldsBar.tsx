import { useEffect, useState } from "react";
import { MapPin, Utensils, Sparkles, Clock, Ban, ChefHat } from "lucide-react";
import type { ParsedRequirements } from "@/lib/store";
import { useT } from "@/lib/i18n/context";

type Props = {
  parsed: ParsedRequirements | null;
  highlight?: string[];
};

const HIGHLIGHT_MS = 1600;

/** 实时字段胶囊条：展示当前 parsed，被 highlight 的字段做短暂高亮环。 */
export function ParsedFieldsBar({ parsed, highlight = [] }: Props) {
  const { t, lang } = useT();
  const [glow, setGlow] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (highlight.length === 0) return;
    setGlow(new Set(highlight));
    const id = setTimeout(() => setGlow(new Set()), HIGHLIGHT_MS);
    return () => clearTimeout(id);
  }, [highlight]);

  if (!parsed) return null;

  const on = (name: string) => glow.has(name);
  const ring = (name: string) =>
    on(name) ? "ring-2 ring-primary/70 shadow-[0_0_0_4px_hsl(var(--primary)/0.15)]" : "";

  const hasAny =
    parsed.city ||
    parsed.cuisines.length > 0 ||
    parsed.hardFilters.length > 0 ||
    parsed.softPreferences.length > 0 ||
    parsed.negativeFilters.length > 0 ||
    parsed.dishPreferences.length > 0 ||
    (parsed.visitTime && parsed.visitTime.mentioned);

  if (!hasAny) return null;

  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-2">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {t("planner.parsedTitle")}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {parsed.city && (
          <Pill icon={<MapPin className="h-3 w-3" />} tone="muted" className={ring("city")}>
            {parsed.city}
          </Pill>
        )}
        {parsed.cuisines.map((c, i) => (
          <Pill
            key={`cu-${i}`}
            icon={<Utensils className="h-3 w-3" />}
            tone="muted"
            className={ring("cuisines")}
          >
            {c}
          </Pill>
        ))}
        {parsed.visitTime?.mentioned && parsed.visitTime.raw && (
          <Pill icon={<Clock className="h-3 w-3" />} tone="primary-soft" className={ring("visitTime")}>
            {parsed.visitTime.raw}
          </Pill>
        )}
        {parsed.hardFilters.map((f, i) => (
          <Pill key={`h-${i}`} tone="primary" className={ring("hardFilters")}>
            {f.text}
          </Pill>
        ))}
        {parsed.softPreferences.map((f, i) => (
          <Pill key={`s-${i}`} icon={<Sparkles className="h-3 w-3" />} tone="secondary" className={ring("softPreferences")}>
            {f.text}
          </Pill>
        ))}
        {parsed.negativeFilters.map((f, i) => {
          const raw = f.text.trim();
          const hasNeg = /^(不要|不想|不喜欢|不接受|不能|别|勿|避免|排除|拒绝|讨厌|去掉|去除|杜绝|远离|禁止|avoid|no\s|not\s|non-|without|exclude|dislike|don'?t|hate|never|skip)/i.test(raw);
          const display = hasNeg ? raw : (lang === "en" ? `Avoid ${raw}` : `不要${raw}`);
          return (
            <Pill key={`n-${i}`} icon={<Ban className="h-3 w-3" />} tone="destructive" className={ring("negativeFilters")}>
              {display}
            </Pill>
          );
        })}
        {parsed.dishPreferences.map((d, i) => (
          <Pill key={`d-${i}`} icon={<ChefHat className="h-3 w-3" />} tone="accent" className={ring("dishPreferences")}>
            {d}
          </Pill>
        ))}
      </div>
    </div>
  );
}

type Tone = "muted" | "primary" | "primary-soft" | "secondary" | "destructive" | "accent";

function Pill({
  children,
  icon,
  tone,
  className = "",
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  tone: Tone;
  className?: string;
}) {
  const toneClass: Record<Tone, string> = {
    muted: "bg-muted text-foreground border border-border",
    primary: "bg-primary/15 text-primary border border-primary/30",
    "primary-soft": "bg-primary/10 text-primary border border-primary/20",
    secondary: "bg-secondary text-secondary-foreground border border-border/60",
    destructive: "bg-destructive/10 text-destructive border border-destructive/30",
    accent: "bg-accent text-accent-foreground border border-border/60",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-all duration-300 ${toneClass[tone]} ${className}`}
    >
      {icon}
      <span>{children}</span>
    </span>
  );
}
