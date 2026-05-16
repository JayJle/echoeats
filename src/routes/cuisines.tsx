import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { FormEvent, useEffect, useState } from "react";
import { StepShell } from "@/components/StepShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useQueryStore } from "@/lib/store";

export const Route = createFileRoute("/cuisines")({
  head: () => ({
    meta: [
      { title: "Echo Eats — 选择料理类型" },
      { name: "description", content: "选择你想吃的料理类型。" },
    ],
  }),
  component: StepCuisines,
});

const SUGGESTIONS = ["寿司", "烧鸟", "omakase", "拉面", "牛排", "居酒屋", "蟹料理", "法餐", "甜品"];

function StepCuisines() {
  const navigate = useNavigate();
  const city = useQueryStore((s) => s.city);
  const cuisines = useQueryStore((s) => s.cuisines);
  const setCuisines = useQueryStore((s) => s.setCuisines);
  

  const [value, setValue] = useState(cuisines.join("，"));

  // 不再强制跳首页：缺城市时下一步会提示补全

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
    setValue(current ? `${current}，${s}` : s);
  };

  return (
    <StepShell step={2} total={3} title="想吃什么料理？" hint="可输入多个，用逗号或空格分隔">
      <form onSubmit={onSubmit} className="space-y-6">
        <div className="space-y-2">
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="牛排，居酒屋，蟹料理"
            className="h-12 text-base"
            maxLength={200}
          />
          <div className="flex flex-wrap gap-2 pt-1">
            {SUGGESTIONS.map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => addSuggestion(s)}
                className="px-3 py-1.5 text-xs rounded-full bg-secondary text-secondary-foreground hover:bg-accent transition-colors"
              >
                + {s}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <Link
            to="/"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            ← 返回
          </Link>
          <Button type="submit" disabled={!value.trim()} size="lg">
            下一步 →
          </Button>
        </div>
      </form>
    </StepShell>
  );
}
