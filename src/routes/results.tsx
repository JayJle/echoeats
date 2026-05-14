import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Restaurant, useQueryStore } from "@/lib/store";

export const Route = createFileRoute("/results")({
  head: () => ({
    meta: [
      { title: "Echo Eats — 搜索结果" },
      { name: "description", content: "AI 跨平台搜索后的餐厅推荐结果。" },
    ],
  }),
  component: ResultsPage,
});

const TIER_LABEL: Record<Restaurant["matchTier"], string> = {
  perfect: "★ 完全匹配",
  high: "高度匹配",
  partial: "部分匹配",
};

const TIER_CLASS: Record<Restaurant["matchTier"], string> = {
  perfect: "bg-primary text-primary-foreground",
  high: "bg-accent text-accent-foreground",
  partial: "bg-secondary text-secondary-foreground",
};

function ResultsPage() {
  const navigate = useNavigate();
  const parsed = useQueryStore((s) => s.parsed);
  const results = useQueryStore((s) => s.results);

  useEffect(() => {
    if (!results || !parsed) navigate({ to: "/" });
  }, [results, parsed, navigate]);

  if (!results || !parsed) return null;

  const isEmpty = results.groups.length === 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="px-6 py-5 flex items-center justify-between border-b border-border/60">
        <Link to="/" className="font-semibold tracking-tight">
          Echo <span className="text-primary">Eats</span>
        </Link>
        <Button asChild variant="outline" size="sm">
          <Link to="/confirm">编辑需求</Link>
        </Button>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-10">
        <div className="mb-8 bg-card border border-border rounded-2xl p-6">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">搜索结果</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {parsed.city} · {parsed.cuisines.join(" / ")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{parsed.dateTime}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {parsed.hardFilters.slice(0, 5).map((f, i) => (
              <span
                key={i}
                className="px-2 py-0.5 text-xs rounded-full bg-secondary text-secondary-foreground"
              >
                {f}
              </span>
            ))}
          </div>
        </div>

        {results.error && (
          <div className="mb-6 bg-warning/10 border border-warning/30 rounded-2xl p-5">
            <p className="text-sm font-medium text-foreground">{results.error}</p>
            {results.suggestions.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
                {results.suggestions.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-primary">·</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Echo Eats 是 AI 决策层，不直接抓取地图数据。如果 AI 对某个城市/料理把握不大，会诚实说"没把握"，而不是编造店铺。
            </p>
          </div>
        )}

        {isEmpty ? (
          <div className="bg-card border border-border rounded-2xl p-8 text-center">
            <p className="text-base font-medium">没有可展示的餐厅</p>
            <p className="mt-2 text-sm text-muted-foreground">
              请回到上一步调整需求后重新搜索。
            </p>
            <Button asChild className="mt-5">
              <Link to="/confirm">返回编辑需求</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-10">
            {results.groups.map((group) => (
              <section key={group.cuisine}>
                <h2 className="mb-4 text-lg font-semibold tracking-tight border-l-4 border-primary pl-3">
                  {group.cuisine}
                </h2>
                <div className="space-y-5">
                  {group.restaurants.map((r, i) => (
                    <RestaurantCard key={r.id} index={i + 1} r={r} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <div className="mt-12 flex justify-center">
          <Button asChild variant="outline">
            <Link
              to="/"
              onClick={() => {
                useQueryStore.getState().reset();
              }}
            >
              重新搜索
            </Link>
          </Button>
        </div>
      </main>
    </div>
  );
}

function RestaurantCard({ index, r }: { index: number; r: Restaurant }) {
  const displayName = r.localName?.trim() || r.name;
  const alternateName = r.name && r.name !== displayName ? r.name : null;

  return (
    <article className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
      <div className="p-6 flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">#{index}</div>
          <h3 className="mt-0.5 text-xl font-semibold tracking-tight">
            <a
              href={r.googleMapsUri}
              target="_blank"
              rel="noreferrer"
              className="hover:text-primary transition-colors"
            >
              {displayName}
            </a>
          </h3>
          {r.primaryType && (
            <p className="text-xs text-muted-foreground mt-0.5">{r.primaryType}</p>
          )}
          {r.address && (
            <p className="mt-1 text-sm text-muted-foreground">📍 {r.address}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {r.openNow && (
              <span className="px-2 py-0.5 rounded-full bg-success/15 text-success">
                ✓ 当前营业
              </span>
            )}
            {r.needsReview && (
              <span className="px-2 py-0.5 rounded-full bg-warning/15 text-warning">
                ⚠ 需平台核实
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <span
            className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${TIER_CLASS[r.matchTier]}`}
          >
            {TIER_LABEL[r.matchTier]}
          </span>
          <div className="mt-2 text-2xl font-bold tracking-tight">{r.matchScore}%</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Match Score
          </div>
        </div>
      </div>

      <div className="px-6 pb-2">
        <a
          href={`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(displayName + " " + (r.address || ""))}`}
          target="_blank"
          rel="noreferrer"
          className="block aspect-[16/9] rounded-lg bg-gradient-to-br from-accent to-secondary flex items-center justify-center text-xs text-muted-foreground hover:opacity-80 transition"
        >
          🔍 在 Google 图片中查看「{displayName}」
        </a>
      </div>

      <div className="px-6 py-4 border-t border-border">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          Ratings
        </h4>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          {r.ratings.map((rt) => (
            <div key={rt.platform} className="flex justify-between">
              <span className="text-muted-foreground">{rt.platform}</span>
              <span className="font-medium">{rt.score ?? "无数据"}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="px-6 py-4 border-t border-border bg-muted/30">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          AI 总结
        </h4>
        <p className="text-sm leading-relaxed">{r.aiSummary}</p>
      </div>

      <div className="px-6 py-4 border-t border-border">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          匹配详情
        </h4>
        <ul className="space-y-1 text-sm">
          {r.matchDetails.map((d, i) => (
            <li key={i} className="flex gap-2">
              <span className={d.status === "ok" ? "text-success" : "text-warning"}>
                {d.status === "ok" ? "✓" : "⚠"}
              </span>
              <span>{d.label}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="px-6 py-4 border-t border-border grid sm:grid-cols-2 gap-4">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            高频好评
          </h4>
          <ul className="space-y-1 text-sm">
            {r.pros.map((p, i) => (
              <li key={i} className="text-foreground">
                <span className="text-success mr-1">+</span>
                {p}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            高频差评
          </h4>
          <ul className="space-y-1 text-sm">
            {r.cons.map((c, i) => (
              <li key={i} className="text-foreground">
                <span className="text-destructive mr-1">−</span>
                {c}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {r.links.length > 0 && (
        <div className="px-6 py-4 border-t border-border bg-muted/30 flex flex-wrap gap-2">
          {r.links.map((l, i) => (
            <a
              key={i}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 text-xs rounded-full bg-card border border-border hover:border-primary hover:text-primary transition-colors"
            >
              {l.label} ↗
            </a>
          ))}
        </div>
      )}
    </article>
  );
}
