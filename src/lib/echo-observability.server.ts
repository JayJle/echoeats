// ============================================================================
// Echo Observability — 统一节点日志
// ----------------------------------------------------------------------------
// 每个 agent / skill / stage 调用都使用这里的 helper，日志前缀统一为
// [Echo/<stage>]，方便 grep 与后续聚合分析。
//
// 三种状态：start / ok / fail，另有 partial 与 fallback 变体。
// 所有节点失败都必须记录（不允许静默 fallback）。
// ============================================================================

function fmt(extra?: Record<string, unknown>): string {
  if (!extra) return "";
  return Object.entries(extra)
    .map(([k, v]) => {
      if (v === null || v === undefined) return `${k}=null`;
      if (typeof v === "string") return `${k}="${v}"`;
      if (typeof v === "number" || typeof v === "boolean") return `${k}=${v}`;
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(" ");
}

export const echoLog = {
  start: (stage: string, extra?: Record<string, unknown>) => {
    console.log(`[Echo/${stage}] start ${fmt(extra)}`.trim());
  },
  ok: (stage: string, ms: number, extra?: Record<string, unknown>) => {
    console.log(`[Echo/${stage}] ok in ${ms}ms ${fmt(extra)}`.trim());
  },
  partial: (stage: string, ms: number, extra?: Record<string, unknown>) => {
    console.warn(`[Echo/${stage}] PARTIAL in ${ms}ms ${fmt(extra)}`.trim());
  },
  fallback: (stage: string, extra?: Record<string, unknown>) => {
    console.warn(`[Echo/${stage}] fallback ${fmt(extra)}`.trim());
  },
  fail: (stage: string, ms: number, err: unknown, extra?: Record<string, unknown>) => {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[Echo/${stage}] failed in ${ms}ms reason="${m}" ${fmt(extra)}`.trim());
  },
  info: (stage: string, extra?: Record<string, unknown>) => {
    console.log(`[Echo/${stage}] ${fmt(extra)}`.trim());
  },
};

// 计时器：await stage(...); 结束时自动打点。
export function startStage(stage: string, extra?: Record<string, unknown>) {
  const t0 = Date.now();
  echoLog.start(stage, extra);
  return {
    ok: (endExtra?: Record<string, unknown>) => echoLog.ok(stage, Date.now() - t0, endExtra),
    partial: (endExtra?: Record<string, unknown>) =>
      echoLog.partial(stage, Date.now() - t0, endExtra),
    fail: (err: unknown, endExtra?: Record<string, unknown>) =>
      echoLog.fail(stage, Date.now() - t0, err, endExtra),
    ms: () => Date.now() - t0,
  };
}
