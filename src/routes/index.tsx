import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FormEvent, useState } from "react";
import { StepShell } from "@/components/StepShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useQueryStore } from "@/lib/store";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Echo Eats — AI 餐厅发现 Agent" },
      {
        name: "description",
        content:
          "用一句话描述你想吃什么，Echo Eats 帮你跨平台搜索、理解评论、找出最适合你的餐厅。",
      },
      { property: "og:title", content: "Echo Eats — AI 餐厅发现 Agent" },
      {
        property: "og:description",
        content: "自然语言描述需求，AI 跨平台搜索并解释为什么推荐。",
      },
    ],
  }),
  component: StepCity,
});

function StepCity() {
  const navigate = useNavigate();
  const city = useQueryStore((s) => s.city);
  const setCity = useQueryStore((s) => s.setCity);
  const [value, setValue] = useState(city);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setCity(value.trim());
    navigate({ to: "/cuisines" });
  };

  return (
    <StepShell
      step={1}
      title="你想在哪个城市找餐厅？"
      hint="例如：Tokyo / 东京、Shanghai / 上海、Paris"
    >
      <form onSubmit={onSubmit} className="space-y-6">
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Tokyo / 东京"
          className="h-12 text-base"
          maxLength={80}
        />
        <div className="flex justify-end">
          <Button type="submit" disabled={!value.trim()} size="lg">
            下一步 →
          </Button>
        </div>
      </form>
    </StepShell>
  );
}
