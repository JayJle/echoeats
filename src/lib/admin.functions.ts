import { createServerFn } from "@tanstack/react-start";
import { useSession } from "@tanstack/react-start/server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type AdminSession = { authed?: boolean; at?: number };

const SESSION_NAME = "echo-admin";

function sessionConfig() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("ADMIN_SESSION_SECRET missing or too short (>=32 chars)");
  }
  return {
    password: secret,
    name: SESSION_NAME,
    maxAge: 60 * 60 * 24 * 7, // 7 days
    cookie: {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: true,
      path: "/",
    },
  };
}

async function requireAdmin() {
  const session = await useSession<AdminSession>(sessionConfig());
  if (!session.data?.authed) {
    throw new Error("Unauthorized");
  }
}

export const adminLogin = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ password: z.string().min(1).max(200) }).parse(input),
  )
  .handler(async ({ data }) => {
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) return { ok: false as const, error: "ADMIN_PASSWORD not set" };
    if (data.password !== expected) {
      // tiny delay to slow brute force
      await new Promise((r) => setTimeout(r, 400));
      return { ok: false as const, error: "密码错误" };
    }
    const session = await useSession<AdminSession>(sessionConfig());
    await session.update({ authed: true, at: Date.now() });
    return { ok: true as const };
  });

export const adminLogout = createServerFn({ method: "POST" }).handler(async () => {
  const session = await useSession<AdminSession>(sessionConfig());
  await session.clear();
  return { ok: true as const };
});

export const adminCheckAuth = createServerFn({ method: "GET" }).handler(async () => {
  const session = await useSession<AdminSession>(sessionConfig());
  return { authed: !!session.data?.authed };
});

export const adminGetStats = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();

  const now = Date.now();
  const d7 = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const d30 = new Date(now - 30 * 24 * 3600 * 1000).toISOString();

  const [sess7, sess30, fb7, fb30, fbAll] = await Promise.all([
    supabaseAdmin.from("search_sessions").select("id", { count: "exact", head: true }).gte("created_at", d7),
    supabaseAdmin.from("search_sessions").select("id", { count: "exact", head: true }).gte("created_at", d30),
    supabaseAdmin.from("search_feedback").select("*", { count: "exact" }).gte("created_at", d7),
    supabaseAdmin.from("search_feedback").select("*", { count: "exact" }).gte("created_at", d30),
    supabaseAdmin.from("search_feedback").select("rating, overall, down_reasons, chosen_external_name, would_recommend"),
  ]);

  const all = (fbAll.data ?? []) as Array<{
    rating: number | null;
    overall: string | null;
    down_reasons: string[] | null;
    chosen_external_name: string | null;
    would_recommend: boolean | null;
  }>;

  const ratings = all.map((f) => f.rating).filter((r): r is number => typeof r === "number");
  const avgRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
  const upCount = all.filter((f) => f.overall === "up").length;
  const downCount = all.filter((f) => f.overall === "down").length;
  const externalCount = all.filter((f) => !!f.chosen_external_name).length;
  const recommendYes = all.filter((f) => f.would_recommend === true).length;
  const recommendNo = all.filter((f) => f.would_recommend === false).length;

  const reasonCount = new Map<string, number>();
  for (const f of all) {
    for (const r of f.down_reasons ?? []) reasonCount.set(r, (reasonCount.get(r) ?? 0) + 1);
  }
  const topDownReasons = Array.from(reasonCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  return {
    sessions7: sess7.count ?? 0,
    sessions30: sess30.count ?? 0,
    feedback7: fb7.count ?? 0,
    feedback30: fb30.count ?? 0,
    feedbackTotal: all.length,
    avgRating: Math.round(avgRating * 100) / 100,
    upCount,
    downCount,
    externalCount,
    externalRate: all.length ? Math.round((externalCount / all.length) * 100) : 0,
    recommendYes,
    recommendNo,
    topDownReasons,
    feedbackRate7:
      (sess7.count ?? 0) > 0
        ? Math.round(((fb7.count ?? 0) / (sess7.count ?? 1)) * 1000) / 10
        : 0,
  };
});

export const adminListFeedback = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        filter: z.enum(["all", "negative", "positive", "external", "withComment"]).default("all"),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await requireAdmin();

    let q = supabaseAdmin
      .from("search_feedback")
      .select(
        "id, created_at, session_id, overall, rating, down_reasons, chosen_reasons, chosen_from_results, chosen_external_name, would_recommend, contact, comment",
      )
      .order("created_at", { ascending: false })
      .range(data.offset, data.offset + data.limit - 1);

    if (data.filter === "negative") q = q.lte("rating", 3);
    if (data.filter === "positive") q = q.gte("rating", 4);
    if (data.filter === "external") q = q.not("chosen_external_name", "is", null);
    if (data.filter === "withComment") q = q.not("comment", "is", null);

    const { data: rows, error } = await q;
    if (error) {
      console.error("[admin] listFeedback failed:", error);
      return { items: [] as never[], error: error.message };
    }

    const sessionIds = Array.from(new Set((rows ?? []).map((r) => r.session_id)));
    const sessionsById = new Map<string, {
      city: string;
      cuisines: string[];
      lang: string | null;
      user_agent: string | null;
      result_count: number | null;
      created_at: string;
      parsed_json: Record<string, unknown> | null;
    }>();

    if (sessionIds.length > 0) {
      const { data: sess } = await supabaseAdmin
        .from("search_sessions")
        .select("id, city, cuisines, lang, user_agent, result_count, created_at, parsed_json")
        .in("id", sessionIds);
      for (const s of sess ?? []) {
        sessionsById.set(s.id, {
          city: s.city,
          cuisines: s.cuisines,
          lang: s.lang,
          user_agent: s.user_agent,
          result_count: s.result_count,
          created_at: s.created_at,
          parsed_json: s.parsed_json,
        });
      }
    }

    return {
      items: (rows ?? []).map((r) => ({
        ...r,
        session: sessionsById.get(r.session_id) ?? null,
      })),
    };
  });

export const adminGetSession = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ sessionId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    await requireAdmin();
    const { data: sess, error } = await supabaseAdmin
      .from("search_sessions")
      .select("*")
      .eq("id", data.sessionId)
      .single();
    if (error || !sess) return { session: null };
    return { session: sess };
  });
