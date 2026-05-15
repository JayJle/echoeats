import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Restaurant } from "@/lib/store";
import {
  createSearchSession,
  submitSearchFeedback,
} from "@/lib/feedback.functions";

const ANON_KEY = "echo-eats-anon-id";

function getAnonId(): string {
  if (typeof window === "undefined") return "ssr";
  let id = localStorage.getItem(ANON_KEY);
  if (!id) {
    id =
      (crypto.randomUUID?.() as string | undefined) ??
      `anon-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(ANON_KEY, id);
  }
  return id;
}

const DOWN_REASONS = [
  "推荐的店不符合我的硬条件",
  "推荐的店不是我想要的料理",
  "评分/评价信息不靠谱",
  "漏掉了我知道的好店",
  "排序不合理",
];

type Props = {
  city: string;
  cuisines: string[];
  parsed: unknown;
  restaurants: Restaurant[];
  resultsSnapshot: unknown;
};

export function FeedbackPanel({
  city,
  cuisines,
  parsed,
  restaurants,
  resultsSnapshot,
}: Props) {
  const create = useServerFn(createSearchSession);
  const submit = useServerFn(submitSearchFeedback);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [externalName, setExternalName] = useState("");
  const [showExternal, setShowExternal] = useState(false);
  const [overall, setOverall] = useState<"up" | "down" | null>(null);
  const [downReasons, setDownReasons] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 第一次渲染时落 session
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await create({
          data: {
            anonId: getAnonId(),
            city,
            cuisines,
            parsed,
            results: resultsSnapshot,
          },
        });
        if (!cancelled) setSessionId(res.sessionId);
      } catch (e) {
        console.warn("[feedback] create session failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restaurantOptions = useMemo(() => {
    return restaurants.map((r) => ({
      id: r.id,
      label: r.localName?.trim() || r.name,
    }));
  }, [restaurants]);

  if (submitted) {
    return (
      <div className="mt-10 bg-card border border-border rounded-2xl p-6 text-center text-sm text-muted-foreground">
        感谢反馈 ✓ 你的意见会用来改进我们的搜索质量。
      </div>
    );
  }

  const canSubmit = overall !== null && !!sessionId;

  const handleSubmit = async () => {
    if (!canSubmit || !sessionId) return;
    setError(null);
    try {
      const res = await submit({
        data: {
          sessionId,
          chosenFromResults: chosenId,
          chosenExternalName:
            showExternal && externalName.trim() ? externalName.trim() : null,
          overall: overall!,
          downReasons: overall === "down" ? downReasons : [],
          comment: comment.trim() ? comment.trim() : null,
        },
      });
      if (res.ok) setSubmitted(true);
      else setError(res.error || "提交失败，请稍后重试");
    } catch (e) {
      console.error(e);
      setError("提交失败，请稍后重试");
    }
  };

  const toggleReason = (r: string) => {
    setDownReasons((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r],
    );
  };

  return (
    <section className="mt-10 bg-card border border-border rounded-2xl p-6">
      <h3 className="text-base font-semibold tracking-tight">
        帮我们改进搜索质量
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        反馈仅用于评估搜索系统是否准确，不会影响任何具体店铺以后是否出现。
      </p>

      {/* 最后选了哪家 */}
      <div className="mt-5">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          最后我去了哪家？（可选）
        </div>
        <div className="flex flex-wrap gap-1.5">
          {restaurantOptions.map((r) => {
            const active = chosenId === r.id;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setChosenId(active ? null : r.id);
                  if (!active) setShowExternal(false);
                }}
                className={`px-2.5 py-1 text-xs rounded-full border transition ${
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background border-border hover:border-primary"
                }`}
              >
                {active ? "✓ " : ""}
                {r.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              setShowExternal((v) => !v);
              if (!showExternal) setChosenId(null);
            }}
            className={`px-2.5 py-1 text-xs rounded-full border transition ${
              showExternal
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background border-border hover:border-primary"
            }`}
          >
            去了别的店
          </button>
        </div>
        {showExternal && (
          <input
            type="text"
            value={externalName}
            onChange={(e) => setExternalName(e.target.value.slice(0, 200))}
            placeholder="店名（可选）"
            className="mt-2 w-full px-3 py-2 text-sm rounded-lg bg-background border border-border focus:outline-none focus:border-primary"
          />
        )}
      </div>

      {/* 推荐准吗 */}
      <div className="mt-5">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          这次推荐准吗？
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setOverall("up")}
            className={`flex-1 py-2.5 text-sm rounded-lg border transition ${
              overall === "up"
                ? "bg-success/15 border-success text-success font-medium"
                : "bg-background border-border hover:border-success"
            }`}
          >
            👍 准
          </button>
          <button
            type="button"
            onClick={() => setOverall("down")}
            className={`flex-1 py-2.5 text-sm rounded-lg border transition ${
              overall === "down"
                ? "bg-destructive/10 border-destructive text-destructive font-medium"
                : "bg-background border-border hover:border-destructive"
            }`}
          >
            👎 不准
          </button>
        </div>
      </div>

      {/* 不准的原因 */}
      {overall === "down" && (
        <div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            不准在哪？（多选）
          </div>
          <div className="flex flex-wrap gap-1.5">
            {DOWN_REASONS.map((r) => {
              const active = downReasons.includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => toggleReason(r)}
                  className={`px-2.5 py-1 text-xs rounded-full border transition ${
                    active
                      ? "bg-destructive/10 text-destructive border-destructive"
                      : "bg-background border-border hover:border-destructive/50"
                  }`}
                >
                  {active ? "✓ " : ""}
                  {r}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 评论 */}
      {overall !== null && (
        <div className="mt-4">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, 500))}
            placeholder="可选：说两句（最多 500 字）"
            rows={2}
            className="w-full px-3 py-2 text-sm rounded-lg bg-background border border-border focus:outline-none focus:border-primary resize-none"
          />
        </div>
      )}

      {error && (
        <p className="mt-3 text-xs text-destructive">{error}</p>
      )}

      <div className="mt-5 flex justify-end">
        <Button onClick={handleSubmit} disabled={!canSubmit} size="sm">
          提交反馈
        </Button>
      </div>
    </section>
  );
}
