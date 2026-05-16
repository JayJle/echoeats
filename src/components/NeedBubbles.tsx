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

type Bubble = {
  id: number;
  text: string;
  xPct: number; // 0~100
  yPct: number; // 0~100
  size: Size;
  drift: number; // px
  duration: number; // s
  delay: number; // s
  popping?: boolean;
  entering?: boolean;
};

const SIZE_CLASS: Record<Size, string> = {
  sm: "text-xs px-3 py-1.5",
  md: "text-sm px-4 py-2",
  lg: "text-sm px-5 py-2.5",
};

const BUBBLE_COUNT = 6;
const AREA_HEIGHT = 180;

let idSeq = 1;

function pickText(used: Set<string>): string {
  const remaining = POOL.filter((t) => !used.has(t));
  const pool = remaining.length > 0 ? remaining : POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

function makeBubble(used: Set<string>, entering = false): Bubble {
  const text = pickText(used);
  return {
    id: idSeq++,
    text,
    xPct: 4 + Math.random() * 78,
    yPct: 8 + Math.random() * 70,
    size: SIZES[Math.floor(Math.random() * SIZES.length)],
    drift: (Math.random() * 14 - 7),
    duration: 3.5 + Math.random() * 2.5,
    delay: -Math.random() * 3,
    entering,
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
    if (b.popping) return;
    onPick(b.text);
    setBubbles((prev) => prev.map((x) => (x.id === b.id ? { ...x, popping: true } : x)));

    const t1 = setTimeout(() => {
      setBubbles((prev) => {
        const used = new Set(prev.filter((x) => x.id !== b.id).map((x) => x.text));
        const fresh = makeBubble(used, true);
        return prev.map((x) => (x.id === b.id ? fresh : x));
      });
    }, 280);
    timersRef.current.push(t1);

    const t2 = setTimeout(() => {
      setBubbles((prev) => prev.map((x) => (x.entering ? { ...x, entering: false } : x)));
    }, 900);
    timersRef.current.push(t2);
  };

  return (
    <div
      className="relative w-full overflow-hidden rounded-xl"
      style={{ height: AREA_HEIGHT }}
      aria-label="需求建议"
    >
      {bubbles.map((b) => {
        const animation = b.popping
          ? "bubble-pop 280ms ease-in forwards"
          : b.entering
            ? `bubble-rise-in 600ms ease-out both, bubble-float ${b.duration}s ease-in-out ${b.duration * 0.6}s infinite`
            : `bubble-float ${b.duration}s ease-in-out ${b.delay}s infinite`;
        return (
          <button
            key={b.id}
            type="button"
            onClick={() => handlePop(b)}
            className={`absolute rounded-full border border-primary/25 bg-primary/10 text-foreground/85 backdrop-blur-sm shadow-sm hover:bg-primary/20 hover:border-primary/40 transition-colors whitespace-nowrap ${SIZE_CLASS[b.size]}`}
            style={{
              left: `${b.xPct}%`,
              top: `${b.yPct}%`,
              animation,
              // @ts-expect-error css var
              "--bx": `${b.drift}px`,
            }}
          >
            {b.text}
          </button>
        );
      })}
    </div>
  );
}
