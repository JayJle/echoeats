import { useState } from "react";

const POOL = [
  // 价位
  "人均 100 元以内",
  "人均 200 元以内",
  "人均 500+ 高端",
  "性价比高",
  // 评分/口碑
  "谷歌评分 4.0 以上",
  "必比登推荐",
  "米其林",
  "本地人爱去",
  "不要游客店",
  // 氛围
  "适合约会",
  "安静能聊天",
  "氛围有格调",
  "适合商务",
  "适合带小孩",
  "适合多人聚餐",
  // 位置
  "靠近地铁",
  "在商场里",
  "步行可达",
  "有停车位",
  // 体验
  "有包间",
  "可以预约",
  "不用排队",
  "有英文菜单",
  "有中文菜单",
  "室外座位",
  "夜里也开",
  // 食材/出品
  "食材新鲜",
  "现做现卖",
  "分量足",
  "摆盘精致",
  "辣度可调",
  "有素食选项",
  // 菜品偏好
  "推荐刺身",
  "想吃烧鸟",
  "想配清酒",
  "招牌菜必点",
  "适合拍照",
];

export function NeedBubbles({ onPick }: { onPick: (text: string) => void }) {
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
  const track = [...POOL, ...POOL];

  return (
    <div
      className="relative overflow-hidden py-1 group"
      style={{
        maskImage:
          "linear-gradient(to right, transparent, black 6%, black 94%, transparent)",
        WebkitMaskImage:
          "linear-gradient(to right, transparent, black 6%, black 94%, transparent)",
      }}
      aria-label="需求灵感"
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
