import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import {
  adminCheckAuth,
  adminLogin,
  adminLogout,
  adminGetStats,
  adminListFeedback,
  adminGetSession,
} from "@/lib/admin.functions";

export const Route = createFileRoute("/admin/feedback")({
  head: () => ({
    meta: [
      { title: "Echo Eats — Feedback Admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AdminFeedbackPage,
});

type FeedbackItem = {
  id: string;
  created_at: string;
  session_id: string;
  overall: string | null;
  rating: number | null;
  down_reasons: string[] | null;
  chosen_reasons: string[] | null;
  chosen_from_results: string | null;
  chosen_external_name: string | null;
  would_recommend: boolean | null;
  contact: string | null;
  comment: string | null;
  session: {
    city: string;
    cuisines: string[];
    lang: string | null;
    user_agent: string | null;
    result_count: number | null;
    created_at: string;
    parsedSummary: string | null;
  } | null;
};

type Stats = {
  sessions7: number;
  sessions30: number;
  feedback7: number;
  feedback30: number;
  feedbackTotal: number;
  avgRating: number;
  upCount: number;
  downCount: number;
  externalCount: number;
  externalRate: number;
  recommendYes: number;
  recommendNo: number;
  topDownReasons: { reason: string; count: number }[];
  feedbackRate7: number;
};

function AdminFeedbackPage() {
  const check = useServerFn(adminCheckAuth);
  const login = useServerFn(adminLogin);
  const logout = useServerFn(adminLogout);
  const getStats = useServerFn(adminGetStats);
  const listFeedback = useServerFn(adminListFeedback);
  const getSession = useServerFn(adminGetSession);

  const [loading, setLoading] = useState(true);
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [loginErr, setLoginErr] = useState<string | null>(null);

  const [stats, setStats] = useState<Stats | null>(null);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [filter, setFilter] = useState<"all" | "negative" | "positive" | "external" | "withComment">("all");
  const [openSession, setOpenSession] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<Awaited<ReturnType<typeof adminGetSession>>["session"] | null>(null);

  useEffect(() => {
    (async () => {
      const r = await check();
      setAuthed(r.authed);
      setLoading(false);
    })();
  }, [check]);

  useEffect(() => {
    if (!authed) return;
    (async () => {
      const [s, l] = await Promise.all([
        getStats(),
        listFeedback({ data: { filter, limit: 50, offset: 0 } }),
      ]);
      setStats(s);
      setItems((l.items as FeedbackItem[]) ?? []);
    })();
  }, [authed, filter, getStats, listFeedback]);

  useEffect(() => {
    if (!openSession) {
      setSessionDetail(null);
      return;
    }
    (async () => {
      const r = await getSession({ data: { sessionId: openSession } });
      setSessionDetail(r.session);
    })();
  }, [openSession, getSession]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginErr(null);
    const r = await login({ data: { password } });
    if (r.ok) {
      setAuthed(true);
      setPassword("");
    } else {
      setLoginErr(r.error || "登录失败");
    }
  };

  const handleLogout = async () => {
    await logout();
    setAuthed(false);
    setStats(null);
    setItems([]);
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">加载中…</div>;
  }

  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <form onSubmit={handleLogin} className="w-full max-w-sm bg-card border border-border rounded-2xl p-6 space-y-4">
          <h1 className="text-lg font-semibold">反馈后台</h1>
          <p className="text-xs text-muted-foreground">请输入管理员密码</p>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg bg-background border border-border focus:outline-none focus:border-primary"
            placeholder="密码"
          />
          {loginErr && <p className="text-xs text-destructive">{loginErr}</p>}
          <Button type="submit" className="w-full" disabled={!password}>登录</Button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold tracking-tight">反馈后台</h1>
          <Button variant="outline" size="sm" onClick={handleLogout}>登出</Button>
        </div>

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <StatCard label="近7天搜索" value={stats.sessions7} sub={`30天 ${stats.sessions30}`} />
            <StatCard label="近7天反馈" value={stats.feedback7} sub={`反馈率 ${stats.feedbackRate7}%`} />
            <StatCard label="平均星级" value={stats.avgRating.toFixed(2)} sub={`👍${stats.upCount} 👎${stats.downCount}`} />
            <StatCard label="选了站外" value={`${stats.externalRate}%`} sub={`${stats.externalCount} 次`} />
          </div>
        )}

        {stats && stats.topDownReasons.length > 0 && (
          <div className="mb-6 bg-card border border-border rounded-xl p-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Top 负面原因</div>
            <div className="flex flex-wrap gap-2">
              {stats.topDownReasons.map((r) => (
                <span key={r.reason} className="px-2.5 py-1 text-xs rounded-full bg-destructive/10 text-destructive border border-destructive/20">
                  {r.reason} · {r.count}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-4">
          {([
            ["all", "全部"],
            ["negative", "负面 (≤3⭐)"],
            ["positive", "好评 (≥4⭐)"],
            ["external", "选了站外"],
            ["withComment", "有评论"],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`px-3 py-1.5 text-xs rounded-full border transition ${
                filter === k
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background border-border hover:border-primary"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          {items.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-12">暂无反馈</div>
          )}
          {items.map((it) => (
            <FeedbackCard key={it.id} item={it} onOpenSession={() => setOpenSession(it.session_id)} />
          ))}
        </div>
      </div>

      {openSession && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4"
          onClick={() => setOpenSession(null)}
        >
          <div
            className="bg-card border border-border rounded-2xl max-w-3xl w-full max-h-[85vh] overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Session 详情</h2>
              <button onClick={() => setOpenSession(null)} className="text-muted-foreground hover:text-foreground">✕</button>
            </div>
            {!sessionDetail ? (
              <div className="text-sm text-muted-foreground">加载中…</div>
            ) : (
              <div className="space-y-4 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">城市 / 品类 / 语言</div>
                  <div>{sessionDetail.city} · {sessionDetail.cuisines.join(", ")} · {sessionDetail.lang ?? "?"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">设备</div>
                  <div className="break-all text-xs">{sessionDetail.userAgent ?? "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">结果数 / 错误</div>
                  <div>{sessionDetail.resultCount ?? 0} · {sessionDetail.hadError ? `出错 (${sessionDetail.errorStage ?? "?"})` : "正常"}</div>
                </div>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">原始 parsed_json</summary>
                  <pre className="mt-2 p-3 rounded-lg bg-muted text-xs overflow-x-auto whitespace-pre-wrap">{sessionDetail.parsedJsonText ?? "—"}</pre>
                </details>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">结果快照</summary>
                  <pre className="mt-2 p-3 rounded-lg bg-muted text-xs overflow-x-auto whitespace-pre-wrap max-h-96">{sessionDetail.resultsSnapshotText ?? "—"}</pre>
                </details>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tracking-tight mt-1">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

function FeedbackCard({ item, onOpenSession }: { item: FeedbackItem; onOpenSession: () => void }) {
  const rating = item.rating ?? 0;
  const chosenLabel = item.chosen_external_name
    ? `站外 · ${item.chosen_external_name}`
    : item.chosen_from_results
    ? `站内 · ${item.chosen_from_results}`
    : "未选";
  const isMobile = (item.session?.user_agent ?? "").toLowerCase().includes("mobi");
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground mb-2">
        <span className="text-amber-400 text-sm">{"★".repeat(rating)}<span className="text-muted-foreground/30">{"★".repeat(5 - rating)}</span></span>
        <span>·</span>
        <span>{item.session?.city ?? "?"}</span>
        <span>·</span>
        <span>{(item.session?.cuisines ?? []).join("/") || "?"}</span>
        <span>·</span>
        <span>{item.session?.lang ?? "?"}</span>
        <span>·</span>
        <span>{isMobile ? "移动" : "桌面"}</span>
        <span>·</span>
        <span>{new Date(item.created_at).toLocaleString("zh-CN")}</span>
      </div>

      {item.session?.parsedSummary && (
        <div className="text-sm mb-2">
          <span className="text-xs text-muted-foreground">原始需求：</span>
          <span>"{item.session.parsedSummary}"</span>
        </div>
      )}

      <div className="text-sm mb-2">
        <span className="text-xs text-muted-foreground">用户选择：</span>
        <span>{chosenLabel}</span>
        {item.session?.result_count != null && (
          <span className="text-xs text-muted-foreground"> （共返回 {item.session.result_count} 家）</span>
        )}
      </div>

      {(item.down_reasons?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {item.down_reasons!.map((r) => (
            <span key={r} className="px-2 py-0.5 text-xs rounded-full bg-destructive/10 text-destructive">{r}</span>
          ))}
        </div>
      )}

      {(item.chosen_reasons?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {item.chosen_reasons!.map((r) => (
            <span key={r} className="px-2 py-0.5 text-xs rounded-full bg-success/15 text-success">{r}</span>
          ))}
        </div>
      )}

      {item.comment && (
        <div className="text-sm mb-2 italic text-foreground/90">"{item.comment}"</div>
      )}

      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-3">
        {item.would_recommend === true && <span className="text-success">会推荐</span>}
        {item.would_recommend === false && <span className="text-destructive">不会推荐</span>}
        {item.contact && <span>📧 {item.contact}</span>}
        <button onClick={onOpenSession} className="ml-auto underline hover:text-foreground">
          查看 session
        </button>
      </div>
    </div>
  );
}
