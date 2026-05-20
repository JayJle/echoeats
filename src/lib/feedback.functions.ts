import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getRequestHeader } from "@tanstack/react-start/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const CreateSessionInput = z.object({
  anonId: z.string().min(1).max(64),
  city: z.string().min(1).max(120),
  cuisines: z.array(z.string().min(1).max(60)).min(1).max(20),
  lang: z.enum(["zh", "en"]).optional(),
  resultCount: z.number().int().min(0).max(200).optional(),
  hadError: z.boolean().optional(),
  errorStage: z.string().max(60).nullable().optional(),
  parsed: z.unknown().optional(),
  results: z.unknown().optional(),
});

export const createSearchSession = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CreateSessionInput.parse(input))
  .handler(async ({ data }) => {
    let userAgent: string | null = null;
    try {
      userAgent = getRequestHeader("user-agent") ?? null;
      if (userAgent && userAgent.length > 500) userAgent = userAgent.slice(0, 500);
    } catch {
      userAgent = null;
    }

    const { data: row, error } = await supabaseAdmin
      .from("search_sessions")
      .insert({
        anon_id: data.anonId,
        city: data.city,
        cuisines: data.cuisines,
        parsed_json: (data.parsed ?? null) as never,
        results_snapshot: (data.results ?? null) as never,
        user_agent: userAgent,
        lang: data.lang ?? null,
        result_count: data.resultCount ?? null,
        had_error: data.hadError ?? false,
        error_stage: data.errorStage ?? null,
      })
      .select("id")
      .single();
    if (error || !row) {
      console.error("[feedback] createSearchSession failed:", error);
      return { sessionId: null as string | null };
    }
    return { sessionId: row.id };
  });

const SubmitFeedbackInput = z.object({
  sessionId: z.string().uuid(),
  chosenFromResults: z.string().max(120).nullable().optional(),
  chosenExternalName: z.string().max(200).nullable().optional(),
  rating: z.number().int().min(1).max(5),
  chosenReasons: z.array(z.string().min(1).max(80)).max(10).default([]),
  downReasons: z.array(z.string().min(1).max(80)).max(10).default([]),
  wouldRecommend: z.boolean().nullable().optional(),
  contact: z.string().email().max(200).nullable().optional(),
  comment: z.string().max(500).nullable().optional(),
});

export const submitSearchFeedback = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => SubmitFeedbackInput.parse(input))
  .handler(async ({ data }) => {
    const overall = data.rating >= 4 ? "up" : "down";
    const { error } = await supabaseAdmin.from("search_feedback").insert({
      session_id: data.sessionId,
      chosen_from_results: data.chosenFromResults ?? null,
      chosen_external_name: data.chosenExternalName ?? null,
      overall,
      rating: data.rating,
      down_reasons: data.downReasons ?? [],
      chosen_reasons: data.chosenReasons ?? [],
      would_recommend: data.wouldRecommend ?? null,
      contact: data.contact ?? null,
      comment: data.comment ?? null,
    });
    if (error) {
      console.error("[feedback] submitSearchFeedback failed:", error);
      return { ok: false as const, error: error.message };
    }
    return { ok: true as const };
  });
