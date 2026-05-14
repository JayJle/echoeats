import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { FormEvent, useEffect, useState } from "react";
import { StepShell } from "@/components/StepShell";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useQueryStore } from "@/lib/store";
import { useServerFn } from "@tanstack/react-start";
import { parseRequirements } from "@/lib/echo.functions";

export const Route = createFileRoute("/requirements")({
  head: () => ({
    meta: [
      { title: "Echo Eats — 描述你的需求" },
      { name: "description", content: "用自然语言描述预算、氛围、菜品偏好和避雷需求。" },
    ],
  }),
  component: StepRequirements,
});

function StepRequirements() {
  const navigate = useNavigate();
  const { city, cuisines, date, freeText } = useQueryStore();
  const setFreeText = useQueryStore((s) => s.setFreeText);
  const setParsed = useQueryStore((s) => s.setParsed);
  const setResults = useQueryStore((s) => s.setResults);
  const [value, setValue] = useState(freeText);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parseFn = useServerFn(parseRequirements);

  useEffect(() => {
    if (!date) navigate({ to: "/" });
  }, [date, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    setFreeText(value);
    try {
      const parsed = await parseFn({
        data: { city, cuisines, date, freeText: value },
      });
      setParsed(parsed);
      setResults(null);
      navigate({ to: "/confirm" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "解析失败，请重试";
      if (msg.includes("429")) setError("请求过于频繁，请稍后再试");
      else if (msg.includes("402")) setError("AI 额度已用完，请在 Settings → Workspace 添加额度");
      else setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <StepShell
      step={4}
      title="还有什么要求？随便写"
      hint="预算、人数、氛围、菜品偏好、避雷……越具体越好"
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
            to="/when"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            ← 返回
          </Link>
          <Button type="submit" disabled={loading} size="lg">
            {loading ? "AI 正在理解需求…" : "AI 帮我找餐厅 →"}
          </Button>
        </div>
      </form>
    </StepShell>
  );
}
