import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { FormEvent, useEffect, useState } from "react";
import { StepShell } from "@/components/StepShell";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useQueryStore } from "@/lib/store";
import { useServerFn } from "@tanstack/react-start";
import { parseRequirements, searchRestaurants } from "@/lib/echo.functions";

export const Route = createFileRoute("/requirements")({
  head: () => ({
    meta: [
      { title: "Echo Eats — 描述你的需求" },
      { name: "description", content: "用自然语言描述预算、氛围、菜品偏好和避雷需求。可跳过。" },
    ],
  }),
  component: StepRequirements,
});

function StepRequirements() {
  const navigate = useNavigate();
  const city = useQueryStore((s) => s.city);
  const cuisines = useQueryStore((s) => s.cuisines);
  const freeText = useQueryStore((s) => s.freeText);
  const setFreeText = useQueryStore((s) => s.setFreeText);
  const setParsed = useQueryStore((s) => s.setParsed);
  const setResults = useQueryStore((s) => s.setResults);

  const [value, setValue] = useState(freeText);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<"idle" | "parsing" | "searching">("idle");
  const [error, setError] = useState<string | null>(null);

  const parseFn = useServerFn(parseRequirements);
  const searchFn = useServerFn(searchRestaurants);

  useEffect(() => {
    if (!city || cuisines.length === 0) navigate({ to: "/" });
  }, [city, cuisines, navigate]);

  const runSearch = async (text: string) => {
    setError(null);
    setLoading(true);
    setFreeText(text);
    try {
      setStage("parsing");
      const parsed = await parseFn({
        data: { city, cuisines, date: "", freeText: text },
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

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await runSearch(value);
  };

  const onSkip = async () => {
    await runSearch("");
  };

  return (
    <StepShell
      step={3}
      total={3}
      title="还有什么要求？随便写"
      hint="可跳过，先看结果再补充。预算、人数、氛围、菜品偏好、避雷……越具体越好"
    >
      <form onSubmit={onSubmit} className="space-y-6">
        <Textarea
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="两个人预算 15000 日元以内，不要游客店，适合聊天，最好有蟹刺身，评分高一点，可以预约。"
          className="min-h-[160px] text-base resize-none"
          maxLength={1000}
          disabled={loading}
        />
        {error && (
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between">
          <Link
            to="/cuisines"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            ← 返回
          </Link>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={onSkip}
              disabled={loading}
            >
              跳过 →
            </Button>
            <Button type="submit" disabled={loading || !value.trim()} size="lg">
              {stage === "parsing"
                ? "AI 正在理解需求…"
                : stage === "searching"
                  ? "AI 正在搜索餐厅…"
                  : "AI 帮我找餐厅 →"}
            </Button>
          </div>
        </div>
      </form>
    </StepShell>
  );
}
