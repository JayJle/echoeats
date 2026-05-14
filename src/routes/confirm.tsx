import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useQueryStore } from "@/lib/store";
import { useServerFn } from "@tanstack/react-start";
import { searchRestaurants } from "@/lib/echo.functions";

export const Route = createFileRoute("/confirm")({
  head: () => ({
    meta: [
      { title: "Echo Eats — 确认搜索需求" },
      { name: "description", content: "AI 已结构化你的需求，确认后开始搜索。" },
    ],
  }),
  component: ConfirmPage,
});

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <ul className="mt-2 space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="text-sm text-foreground flex gap-2">
            <span className="text-primary mt-0.5">•</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConfirmPage() {
  const navigate = useNavigate();
  const parsed = useQueryStore((s) => s.parsed);
  const setResults = useQueryStore((s) => s.setResults);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchFn = useServerFn(searchRestaurants);

  useEffect(() => {
    if (!parsed) navigate({ to: "/" });
  }, [parsed, navigate]);

  if (!parsed) return null;

  const onSearch = async () => {
    setError(null);
    setLoading(true);
    try {
      const response = await searchFn({ data: parsed });
      setResults(response);
      navigate({ to: "/results" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "搜索失败";
      if (msg.includes("429")) setError("请求过于频繁，请稍后再试");
      else if (msg.includes("402")) setError("AI 额度已用完，请添加额度");
      else setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="px-6 py-5 flex items-center justify-between border-b border-border/60">
        <Link to="/" className="font-semibold tracking-tight">
          Echo <span className="text-primary">Eats</span>
        </Link>
      </header>
      <main className="max-w-2xl mx-auto px-4 py-10">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            AI 已理解你的需求
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">确认后开始搜索</h1>
        </div>

        <div className="bg-card border border-border rounded-2xl p-7 shadow-sm space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                City
              </h3>
              <p className="mt-1 text-sm font-medium">{parsed.city}</p>
            </div>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Date & Time
              </h3>
              <p className="mt-1 text-sm font-medium">{parsed.dateTime}</p>
            </div>
            <div className="col-span-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Cuisine Types
              </h3>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {parsed.cuisines.map((c) => (
                  <span
                    key={c}
                    className="px-2.5 py-0.5 text-xs rounded-full bg-accent text-accent-foreground"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="border-t border-border" />

          <Section title="Hard Filters" items={parsed.hardFilters} />
          <Section title="Soft Preferences" items={parsed.softPreferences} />
          <Section title="Negative Filters" items={parsed.negativeFilters} />
          <Section title="Dish Preferences" items={parsed.dishPreferences} />
          <Section title="Search Strategy" items={parsed.searchStrategy} />
        </div>

        {error && (
          <div className="mt-4 text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <Button asChild variant="outline">
            <Link to="/requirements">编辑需求</Link>
          </Button>
          <Button onClick={onSearch} disabled={loading} size="lg">
            {loading ? "AI 正在搜索餐厅…" : "开始搜索 →"}
          </Button>
        </div>
      </main>
    </div>
  );
}
