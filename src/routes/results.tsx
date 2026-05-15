import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { FeedbackPanel } from "@/components/FeedbackPanel";
import { Restaurant, useQueryStore } from "@/lib/store";
import { searchRestaurants } from "@/lib/echo.functions";

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
  const freeText = useQueryStore((s) => s.freeText);
  const setResults = useQueryStore((s) => s.setResults);

  const searchFn = useServerFn(searchRestaurants);

  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);

  useEffect(() => {
    if (!results || !parsed) navigate({ to: "/" });
  }, [results, parsed, navigate]);

  if (!results || !parsed) return null;

  const isEmpty = results.groups.length === 0;

  const runSearchAgain = async () => {
    setRefineError(null);
    setRefining(true);
    try {
      const response = await searchFn({ data: parsed });
      setResults(response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "搜索失败";
      setRefineError(msg.includes("429") ? "请求过于频繁，请稍后再试" : msg);
    } finally {
      setRefining(false);
    }
  };

  const restartFlow = () => {
    useQueryStore.getState().reset();
    navigate({ to: "/" });
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="px-6 py-5 flex items-center justify-between border-b border-border/60">
        <Link to="/" className="font-semibold tracking-tight">
          Echo <span className="text-primary">Eats</span>
        </Link>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={runSearchAgain}
            disabled={refining}
          >
            ↻ 再次搜索
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/requirements">编辑需求</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={restartFlow}>
            重新开始
          </Button>
        </div>
      </header>

      {refining && (
        <div className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-card border border-border rounded-2xl px-6 py-5 shadow-lg text-sm">
            AI 正在重新搜索餐厅…
          </div>
        </div>
      )}

      <main className="max-w-3xl mx-auto px-4 py-10">
        <div className="mb-6 bg-card border border-border rounded-2xl p-6">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">搜索结果</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {parsed.city} · {parsed.cuisines.join(" / ")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{parsed.dateTime}</p>
          {parsed.hardFilters.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">硬条件</p>
              <div className="flex flex-wrap gap-1.5">
                {parsed.hardFilters.map((f, i) => (
                  <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-primary/15 text-primary border border-primary/30">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}
          {parsed.softPreferences.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">偏好</p>
              <div className="flex flex-wrap gap-1.5">
                {parsed.softPreferences.map((f, i) => (
                  <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-secondary text-secondary-foreground">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}
          {parsed.negativeFilters.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">排除</p>
              <div className="flex flex-wrap gap-1.5">
                {parsed.negativeFilters.map((f, i) => (
                  <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-destructive/10 text-destructive border border-destructive/30">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}
          {parsed.dishPreferences.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">菜品偏好</p>
              <div className="flex flex-wrap gap-1.5">
                {parsed.dishPreferences.map((f, i) => (
                  <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-accent text-accent-foreground">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}
          {freeText && (
            <details className="mt-3">
              <summary className="text-[11px] uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground">原始描述 ▾</summary>
              <p className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">{freeText}</p>
            </details>
          )}
        </div>

        {refineError && (
          <div className="mb-6 text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
            {refineError}
          </div>
        )}

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
              <Link to="/requirements">返回编辑需求</Link>
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

                {group.partialRestaurants && group.partialRestaurants.length > 0 && (
                  <div className="mt-8">
                    <div className="mb-3 border-l-4 border-warning pl-3">
                      <h3 className="text-base font-semibold tracking-tight">
                        ⚠ 信息不足，部分硬条件无法核实
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        以下店其它条件大部分满足，但有硬条件因网评/Google 数据缺失无法确认，请自行到平台核对。
                      </p>
                    </div>
                    <div className="space-y-5">
                      {group.partialRestaurants.map((r, i) => (
                        <RestaurantCard key={r.id} index={i + 1} r={r} />
                      ))}
                    </div>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}

        {!isEmpty && (
          <FeedbackPanel
            city={parsed.city}
            cuisines={parsed.cuisines}
            parsed={parsed}
            restaurants={results.groups.flatMap((g) => [
              ...g.restaurants,
              ...(g.partialRestaurants ?? []),
            ])}
            resultsSnapshot={results}
          />
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
        {r.photoUrls && r.photoUrls.length > 0 ? (
          <div
            className="flex gap-2 overflow-x-auto snap-x snap-mandatory scroll-smooth -mx-1 px-1 pb-1"
            style={{ scrollbarWidth: "thin" }}
          >
            {r.photoUrls.map((url, i) => (
              <a
                key={i}
                href={r.googleMapsUri}
                target="_blank"
                rel="noreferrer"
                className="snap-start shrink-0 w-full aspect-[16/9] rounded-lg overflow-hidden bg-muted"
              >
                <img
                  src={url}
                  alt={`${displayName} 照片 ${i + 1}`}
                  loading="lazy"
                  className="w-full h-full object-cover hover:scale-105 transition-transform duration-500"
                />
              </a>
            ))}
          </div>
        ) : (
          <a
            href={`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(displayName + " " + (r.address || ""))}`}
            target="_blank"
            rel="noreferrer"
            className="block aspect-[16/9] rounded-lg bg-gradient-to-br from-accent to-secondary flex items-center justify-center text-xs text-muted-foreground hover:opacity-80 transition"
          >
            🔍 在 Google 图片中查看「{displayName}」
          </a>
        )}
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

      {r.tabelog && (
        <div className="px-6 py-4 border-t border-border bg-accent/20">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Tabelog 补充信号
            </h4>
            <span className="text-[10px] text-muted-foreground">食べログ</span>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm mb-2">
            {r.tabelog.rating != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">评分</span>
                <span className="font-medium">
                  {r.tabelog.rating}
                  {r.tabelog.reviewCount ? ` (${r.tabelog.reviewCount})` : ""}
                </span>
              </div>
            )}
            {r.tabelog.priceRange && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">价格带</span>
                <span className="font-medium">{r.tabelog.priceRange}</span>
              </div>
            )}
          </div>
          {r.tabelog.summary && (
            <p className="text-sm leading-relaxed text-muted-foreground mb-2">
              "{r.tabelog.summary}"
            </p>
          )}
          {r.tabelog.url && (
            <a
              href={r.tabelog.url}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-xs text-primary hover:underline"
            >
              在 Tabelog 查看 →
            </a>
          )}
        </div>
      )}

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
          {r.pros.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {r.pros.map((p, i) => (
                <li key={i} className="text-foreground">
                  <span className="text-success mr-1">+</span>
                  {p}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground italic">暂无可信网评</p>
          )}
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            高频差评
          </h4>
          {r.cons.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {r.cons.map((c, i) => (
                <li key={i} className="text-foreground">
                  <span className="text-destructive mr-1">−</span>
                  {c}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground italic">暂无明显差评</p>
          )}
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
