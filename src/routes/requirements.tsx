import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Check, HelpCircle, Loader2, Mic, Square } from "lucide-react";
import { toast } from "sonner";
import { NeedBubbles } from "@/components/NeedBubbles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StepShell } from "@/components/StepShell";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useQueryStore, useStoreHydrated } from "@/lib/store";
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

type StageKey = "parse" | "search" | "reviews" | "rank";

const JP_CITIES = ["东京", "大阪", "京都", "札幌", "福冈", "名古屋", "横滨", "神户", "tokyo", "osaka", "kyoto", "sapporo", "fukuoka", "nagoya", "yokohama", "kobe"];
const CN_CITIES = ["北京", "上海", "广州", "深圳", "成都", "杭州", "南京", "重庆", "武汉", "西安", "苏州", "天津", "厦门", "长沙"];

function reviewsHintFor(city: string) {
  const c = city.toLowerCase();
  if (JP_CITIES.some((x) => c.includes(x.toLowerCase()))) return "翻 Tabelog、食べログ、小红书…";
  if (CN_CITIES.some((x) => city.includes(x))) return "翻大众点评、小红书…";
  return "翻 Google、Yelp、小红书…";
}

function StepRequirements() {
  const navigate = useNavigate();
  const city = useQueryStore((s) => s.city);
  const cuisines = useQueryStore((s) => s.cuisines);
  const freeText = useQueryStore((s) => s.freeText);
  const setFreeText = useQueryStore((s) => s.setFreeText);
  const setParsed = useQueryStore((s) => s.setParsed);
  const setResults = useQueryStore((s) => s.setResults);
  const hydrated = useStoreHydrated();

  const [value, setValue] = useState(freeText);
  const [loading, setLoading] = useState(false);
  const [currentStage, setCurrentStage] = useState<StageKey | null>(null);
  const [searchMode, setSearchMode] = useState<"quick" | "deep">("deep");
  const [error, setError] = useState<string | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);

  const parseFn = useServerFn(parseRequirements);
  const searchFn = useServerFn(searchRestaurants);

  useEffect(() => {
    if (!hydrated) return;
    if (!city || cuisines.length === 0) navigate({ to: "/" });
  }, [hydrated, city, cuisines, navigate]);

  useEffect(() => () => {
    timersRef.current.forEach(clearTimeout);
    abortRef.current?.abort();
  }, []);

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };

  const stages: { key: StageKey; label: string; hint: string }[] =
    searchMode === "deep"
      ? [
          { key: "parse", label: "理解你的需求", hint: "AI 在拆解预算、氛围、避雷点…" },
          { key: "search", label: `在 ${city || "目的地"} 搜寻候选餐厅`, hint: "扫一遍主流地图和本地榜单" },
          { key: "reviews", label: "抓取本地点评与口碑", hint: reviewsHintFor(city) },
          { key: "rank", label: "AI 综合排序", hint: "把口碑、价位、距离揉在一起打分" },
        ]
      : [
          { key: "parse", label: "理解你的需求", hint: "AI 在拆解预算、氛围、避雷点…" },
          { key: "search", label: `在 ${city || "目的地"} 搜寻候选餐厅`, hint: "扫一遍主流地图,几秒就好" },
          { key: "rank", label: "AI 综合排序", hint: "把候选揉在一起打分" },
        ];

  const currentIndex = currentStage ? stages.findIndex((s) => s.key === currentStage) : -1;
  const progressValue = currentStage
    ? Math.min(100, ((currentIndex + 0.5) / stages.length) * 100)
    : 0;

  const runSearch = async (text: string, mode: "quick" | "deep" = "deep") => {
    setError(null);
    setLoading(true);
    setSearchMode(mode);
    setFreeText(text);
    runIdRef.current += 1;
    const myRunId = runIdRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      setCurrentStage("parse");
      const parsed = await parseFn({
        data: { city, cuisines, date: "", freeText: text },
        signal: ac.signal,
      } as Parameters<typeof parseFn>[0]);
      if (myRunId !== runIdRef.current || ac.signal.aborted) return;
      const parsedWithMode = { ...parsed, mode };
      setParsed(parsedWithMode);

      // 进入 search 阶段;按预估耗时推进 reviews → rank
      setCurrentStage("search");
      clearTimers();
      if (mode === "deep") {
        timersRef.current.push(
          setTimeout(() => setCurrentStage("reviews"), 3000),
          setTimeout(() => setCurrentStage("rank"), 13000),
        );
      } else {
        timersRef.current.push(setTimeout(() => setCurrentStage("rank"), 2500));
      }

      const response = await searchFn({
        data: parsedWithMode,
        signal: ac.signal,
      } as Parameters<typeof searchFn>[0]);
      if (myRunId !== runIdRef.current || ac.signal.aborted) return;
      clearTimers();
      setCurrentStage("rank");
      setResults(response);
      navigate({ to: "/results" });
    } catch (err) {
      if (ac.signal.aborted || myRunId !== runIdRef.current) return;
      const msg = err instanceof Error ? err.message : "搜索失败,请重试";
      if (msg.includes("429")) setError("请求过于频繁,请稍后再试");
      else if (msg.includes("402")) setError("AI 额度已用完,请在 Settings → Workspace 添加额度");
      else setError(msg);
      clearTimers();
      setCurrentStage(null);
    } finally {
      if (myRunId === runIdRef.current) setLoading(false);
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    runIdRef.current += 1;
    clearTimers();
    setLoading(false);
    setCurrentStage(null);
    setError(null);
  };

  const [recording, setRecording] = useState(false);
  const toggleRecording = () => {
    if (recording) {
      setRecording(false);
      toast("语音输入即将上线");
    } else {
      setRecording(true);
    }
  };

  const appendBubble = (text: string) => {
    setValue((v) => (v.trim() ? `${v.replace(/[、，,]\s*$/, "")}、${text}` : text));
  };

  return (
    <StepShell step={3} total={3} title="还想要点什么?">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch(value, "deep");
        }}
        className="space-y-5"
      >
        <NeedBubbles onPick={appendBubble} />

        <div className="relative">
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="min-h-[120px] text-base resize-none pr-20"
            maxLength={1000}
            disabled={loading}
          />
          <div className="absolute bottom-3 right-3 flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={toggleRecording}
              aria-label={recording ? "停止录音" : "开始语音输入"}
              className={`flex h-14 w-14 items-center justify-center rounded-full text-primary-foreground shadow-md transition-colors ${
                recording
                  ? "bg-destructive hover:bg-destructive/90"
                  : "bg-primary hover:bg-primary/90"
              }`}
              style={recording ? { animation: "mic-ring 1.4s ease-out infinite" } : undefined}
            >
              {recording ? <Square className="h-5 w-5" fill="currentColor" /> : <Mic className="h-6 w-6" />}
            </button>
            <span className="text-[10px] text-muted-foreground">
              {recording ? "录音中…" : "语音输入"}
            </span>
          </div>
        </div>

        {loading && currentStage && (
          <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-4">
            <Progress value={progressValue} className="h-1" />
            <ul className="space-y-3">
              {stages.map((s, i) => {
                const state =
                  i < currentIndex ? "done" : i === currentIndex ? "active" : "todo";
                return (
                  <li key={s.key} className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                      {state === "done" && <Check className="h-4 w-4 text-primary" />}
                      {state === "active" && (
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      )}
                      {state === "todo" && (
                        <span className="h-3 w-3 rounded-full border border-border" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <p
                        className={
                          state === "todo"
                            ? "text-sm text-muted-foreground"
                            : "text-sm font-medium text-foreground"
                        }
                      >
                        {s.label}
                      </p>
                      {state === "active" && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{s.hint}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="flex justify-end pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={handleCancel}>
                取消搜索
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Link
            to="/cuisines"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            ← 返回
          </Link>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:gap-3">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={loading}
              onClick={() => void runSearch(value, "quick")}
              className="w-full sm:w-auto"
            >
              {loading && searchMode === "quick" ? "搜索中…" : "⚡ 快速搜索"}
            </Button>
            <div className="relative w-full sm:w-auto">
              <Button
                type="submit"
                disabled={loading}
                size="lg"
                className="w-full sm:w-auto"
              >
                {loading && searchMode === "deep" ? "深度搜索中…" : "🔍 深度搜索"}
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="深度搜索说明"
                    className="absolute -top-2 -right-2 z-10 rounded-full bg-background p-0.5 text-muted-foreground hover:text-foreground transition-colors shadow-sm border border-border"
                  >
                    <HelpCircle className="w-4 h-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-72 text-sm leading-relaxed" align="end">
                  <p className="font-medium mb-2">两种搜索模式</p>
                  <p className="mb-1">
                    <span className="font-medium">⚡ 快速搜索</span>:只取主流地图候选 + AI 排序,几秒出结果。
                  </p>
                  <p>
                    <span className="font-medium">🔍 深度搜索</span>:根据所在地区综合多个本地点评/美食平台,抓真实网友口碑、价位等信号再交给 AI 综合判断,更准但更慢。
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
