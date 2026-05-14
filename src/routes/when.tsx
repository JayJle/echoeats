import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { FormEvent, useEffect } from "react";
import { StepShell } from "@/components/StepShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useQueryStore } from "@/lib/store";

export const Route = createFileRoute("/when")({
  head: () => ({
    meta: [
      { title: "Echo Eats — 选择日期与时间" },
      { name: "description", content: "选择你想去吃饭的日期和时间。" },
    ],
  }),
  component: StepWhen,
});

function StepWhen() {
  const navigate = useNavigate();
  const cuisines = useQueryStore((s) => s.cuisines);
  const date = useQueryStore((s) => s.date);
  const time = useQueryStore((s) => s.time);
  const setDate = useQueryStore((s) => s.setDate);
  const setTime = useQueryStore((s) => s.setTime);

  useEffect(() => {
    if (!cuisines.length) navigate({ to: "/" });
  }, [cuisines, navigate]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!date || !time) return;
    navigate({ to: "/requirements" });
  };

  return (
    <StepShell step={3} title="你想什么时候去吃？" hint="系统会优先匹配该时段营业的餐厅">
      <form onSubmit={onSubmit} className="space-y-6">
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">日期</label>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-12 text-base"
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">时间</label>
          <Input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="h-12 text-base"
          />
        </div>
        <div className="flex items-center justify-between">
          <Link
            to="/cuisines"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            ← 返回
          </Link>
          <Button type="submit" disabled={!date || !time} size="lg">
            下一步 →
          </Button>
        </div>
      </form>
    </StepShell>
  );
}
