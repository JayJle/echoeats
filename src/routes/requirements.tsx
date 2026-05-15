import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { FormEvent, useEffect, useState } from "react";
import { HelpCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

  const runSearch = async (text: string, mode: "quick" | "deep" = "deep") => {
    setError(null);
    setLoading(true);
    setFreeText(text);
    try {
      setStage("parsing");
      const parsed = await parseFn({
        data: { city, cuisines, date: "", freeText: text },
      });
      const parsedWithMode = { ...parsed, mode };
      setParsed(parsedWithMode);

      setStage("searching");
      const response = await searchFn({ data: parsedWithMode });
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

  const onSkip = async () => {
    await runSearch("", "deep");
  };

  return (
    <StepShell
      step={3}
      total={3}
      title="还有什么要求？随便写"
      hint="可跳过，先看结果再补充。预算、人数、氛围、菜品偏好、避雷……越具体越好"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch(value, "deep");
        }}
        className="space-y-6"
      >
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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:flex-wrap">
          <Link
            to="/cuisines"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors order-last sm:order-first text-center sm:text-left"
          >
            ← 返回
          </Link>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:gap-3 sm:flex-wrap">
            <Button
              type="button"
              variant="ghost"
              onClick={onSkip}
              disabled={loading}
              className="w-full sm:w-auto"
            >
              跳过 →
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={loading || !value.trim()}
              onClick={() => void runSearch(value, "quick")}
              className="w-full sm:w-auto"
            >
              {stage === "searching" ? "搜索中…" : "⚡ 快速搜索"}
            </Button>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <Button
                type="submit"
                disabled={loading || !value.trim()}
                size="lg"
                className="flex-1 sm:flex-none"
              >
                {stage === "parsing"
                  ? "AI 正在理解需求…"
                  : stage === "searching"
                    ? "AI 深度搜索中…"
                    : "AI 深度搜索 →"}
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="深度搜索说明"
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <HelpCircle className="w-4 h-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-72 text-sm leading-relaxed" align="end">
                  <p className="font-medium mb-2">两种搜索模式</p>
                  <p className="mb-1">
                    <span className="font-medium">⚡ 快速搜索</span>：只取主流地图候选 + AI 排序，几秒出结果。
                  </p>
                  <p>
                    <span className="font-medium">AI 深度搜索</span>：根据所在地区综合多个本地点评/美食平台，抓真实网友口碑、价位等信号再交给 AI 综合判断，更准但更慢。
                  </p>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>
      </form>
    </StepShell>
  );
}
