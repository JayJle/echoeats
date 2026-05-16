import { useEffect, useRef, useState } from "react";

const POOL = [
  "不要游客店",
  "人均 100 元以内",
  "适合约会",
  "安静能聊天",
  "有包间",
  "可以预约",
  "有英文菜单",
  "靠近地铁",
  "本地人爱去",
  "必比登推荐",
  "适合拍照",
  "室外座位",
  "不用排队",
  "适合带小孩",
  "有素食选项",
  "夜里也开",
  "辣度可调",
  "推荐刺身",
  "想吃烧鸟",
  "想配清酒",
  "性价比高",
  "氛围有格调",
];

const SIZES = ["sm", "md", "lg"] as const;
type Size = (typeof SIZES)[number];

const SIZE_CLASS: Record<Size, string> = {
  sm: "text-xs px-3 py-1.5",
  md: "text-sm px-4 py-2",
  lg: "text-sm px-5 py-2.5",
};

type Bubble = { id: number; text: string; size: Size; leaving?: boolean };

const BUBBLE_COUNT = 6;
let idSeq = 1;

function pickText(used: Set<string>): string {
  const remaining = POOL.filter((t) => !used.has(t));
  const pool = remaining.length > 0 ? remaining : POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

function makeBubble(used: Set<string>): Bubble {
  return {
    id: idSeq++,
    text: pickText(used),
    size: SIZES[Math.floor(Math.random() * SIZES.length)],
  };
}

export function NeedBubbles({ onPick }: { onPick: (text: string) => void }) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const used = new Set<string>();
    const initial: Bubble[] = [];
    for (let i = 0; i < BUBBLE_COUNT; i++) {
      const b = makeBubble(used);
      used.add(b.text);
      initial.push(b);
    }
    setBubbles(initial);
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
  }, []);

  const handlePop = (b: Bubble) => {
    if (b.leaving) return;
    onPick(b.text);
    setBubbles((prev) => prev.map((x) => (x.id === b.id ? { ...x, leaving: true } : x)));
    const t = setTimeout(() => {
      setBubbles((prev) => {
        const used = new Set(prev.filter((x) => x.id !== b.id).map((x) => x.text));
        const fresh = makeBubble(used);
        return prev.map((x) => (x.id === b.id ? fresh : x));
      });
    }, 220);
    timersRef.current.push(t);
  };

  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2 min-h-[120px] py-2"
      aria-label="需求建议"
    >
      {bubbles.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() => handlePop(b)}
          className={`rounded-full border border-primary/40 bg-card text-foreground shadow-sm transition-all duration-200 hover:bg-primary/10 hover:border-primary hover:shadow-md hover:-translate-y-0.5 active:scale-95 ${
            SIZE_CLASS[b.size]
          } ${
            b.leaving
              ? "animate-out fade-out zoom-out-50 duration-200 fill-mode-forwards pointer-events-none"
              : "animate-in fade-in zoom-in-75 duration-300"
          }`}
        >
          {b.text}
        </button>
      ))}
    </div>
  );
}
