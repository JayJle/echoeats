import { useT } from "@/lib/i18n/context";

export function LanguageToggle({ className = "" }: { className?: string }) {
  const { lang, setLang } = useT();
  const next = lang === "zh" ? "en" : "zh";
  const label = lang === "zh" ? "EN" : "中文";
  return (
    <button
      type="button"
      onClick={() => setLang(next)}
      aria-label={`Switch language to ${label}`}
      className={`inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground/80 hover:text-foreground hover:border-primary/50 transition-colors ${className}`}
    >
      🌐 {label}
    </button>
  );
}
