import { useState } from "react";
import { useT } from "@/lib/i18n/context";
import { NEED_BUBBLES } from "@/lib/i18n/dict";

export function NeedBubbles({ onPick }: { onPick: (text: string) => void }) {
  const { lang, t } = useT();
  const pool = NEED_BUBBLES.map((b) => b[lang]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [popping, setPopping] = useState<string | null>(null);

  const handleClick = (text: string) => {
    if (picked.has(text)) return;
    onPick(text);
    setPopping(text);
    setTimeout(() => {
      setPicked((prev) => {
        const next = new Set(prev);
        next.add(text);
        return next;
      });
      setPopping(null);
    }, 200);
  };

  // duplicate the pool so the marquee loops seamlessly
  const track = [...pool, ...pool];

  return (
    <div
      className="relative overflow-hidden py-1 group"
      style={{
        maskImage:
          "linear-gradient(to right, transparent, black 6%, black 94%, transparent)",
        WebkitMaskImage:
          "linear-gradient(to right, transparent, black 6%, black 94%, transparent)",
      }}
      aria-label={t("needs.aria")}
    >
      <div
        className="flex gap-2 w-max group-hover:[animation-play-state:paused] focus-within:[animation-play-state:paused]"
        style={{ animation: "marquee 60s linear infinite" }}
      >
        {track.map((text, i) => {
          const isPicked = picked.has(text);
          const isPopping = popping === text;
          return (
            <button
              key={`${text}-${i}`}
              type="button"
              onClick={() => handleClick(text)}
              disabled={isPicked}
              className={`shrink-0 rounded-full border text-sm px-4 py-2 transition-all duration-200 ${
                isPicked
                  ? "border-border bg-muted text-muted-foreground line-through opacity-50 cursor-default"
                  : "border-primary/40 bg-card text-foreground shadow-sm hover:bg-primary/10 hover:border-primary hover:-translate-y-0.5 hover:shadow-md active:scale-95"
              } ${isPopping ? "animate-out fade-out zoom-out-75 duration-200 fill-mode-forwards" : ""}`}
            >
              {text}
            </button>
          );
        })}
      </div>
    </div>
  );
}
