import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { FormEvent, useEffect, useState } from "react";
import { StepShell } from "@/components/StepShell";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useQueryStore } from "@/lib/store";
import { useServerFn } from "@tanstack/react-start";
import { parseRequirements, searchRestaurants } from "@/lib/echo.functions";

export const Route = createFileRoute("/cuisines")({
  head: () => ({
    meta: [
      { title: "Echo Eats — 选择料理类型" },
      { name: "description", content: "选择你想吃的料理类型，可选填补充需求。" },
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
  const freeText = useQueryStore((s) => s.freeText);
  const setFreeText = useQueryStore((s) => s.setFreeText);
  const setDate = useQueryStore((s) => s.setDate);
  const setParsed = useQueryStore((s) => s.setParsed);
  const setResults = useQueryStore((s) => s.setResults);

  const [value, setValue] = useState(cuisines.join("，"));
  const [desc, setDesc] = useState(freeText);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<"idle" | "parsing" | "searching">("idle");
  const [error, setError] = useState<string | null>(null);

  const parseFn = useServerFn(parseRequirements);
  const searchFn = useServerFn(searchRestaurants);

  useEffect(() => {
    if (!city) navigate({ to: "/" });
  }, [city, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const list = value
      .split(/[，,、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length) return;

    setError(null);
    setLoading(true);
    setCuisines(list);
    setFreeText(desc);
    setDate("");

    try {
      setStage("parsing");
      const parsed = await parseFn({
        data: { city, cuisines: list, date: "", freeText: desc },
      });
      setParsed(parsed);

      setStage("searching");
      const response = await searchFn({ data: parsed });
      setResults(response);
      navigate({ to: "/results" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "搜索失败，请重试";
      if (msg.includes("429")) setError("请求过于频繁，请稍后再试");
      else if (msg.includes("402")) setError("AI 额度已用完，请在 Settings → Workspace 添加额度");
      else setError(msg);
    } finally {
      setLoading(false);
      setStage("idle");
    }
  };

  const addSuggestion = (s: string) => {
    const current = value.trim();
    if (current.split(/[，,、\s]+/).includes(s)) return;
    setValue(current ? `${current}，${s}` : s);
  };

  return (
    <StepShell step={2} total={2} title="想吃什么？" hint="料理类型必填，补充需求可跳过">
      <form onSubmit={onSubmit} className="space-y-6">
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">料理类型</label>
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="牛排，居酒屋，蟹料理"
            className="h-12 text-base"
            maxLength={200}
            disabled={loading}
          />
          <div className="flex flex-wrap gap-2 pt-1">
            {SUGGESTIONS.map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => addSuggestion(s)}
                disabled={loading}
                className="px-3 py-1.5 text-xs rounded-full bg-secondary text-secondary-foreground hover:bg-accent transition-colors disabled:opacity-50"
              >
                + {s}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            补充需求 <span className="text-muted-foreground font-normal">（可选）</span>
          </label>
          <Textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="预算、人数、氛围、菜品偏好、避雷……越具体越好。也可以留空，先看结果再补充。"
            className="min-h-[120px] text-base resize-none"
            maxLength={1000}
            disabled={loading}
          />
        </div>

        {error && (
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between">
          <Link
            to="/"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            ← 返回
          </Link>
          <Button type="submit" disabled={loading || !value.trim()} size="lg">
            {stage === "parsing"
              ? "AI 正在理解需求…"
              : stage === "searching"
                ? "AI 正在搜索餐厅…"
                : "AI 帮我找餐厅 →"}
          </Button>
        </div>
      </form>
    </StepShell>
  );
}
