import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const CreateSessionInput = z.object({
  anonId: z.string().min(1).max(64),
  city: z.string().min(1).max(120),
  cuisines: z.array(z.string().min(1).max(60)).min(1).max(20),
  parsed: z.unknown().optional(),
  results: z.unknown().optional(),
});

export const createSearchSession = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CreateSessionInput.parse(input))
  .handler(async ({ data }) => {
    const { data: row, error } = await supabaseAdmin
      .from("search_sessions")
      .insert({
        anon_id: data.anonId,
        city: data.city,
        cuisines: data.cuisines,
        parsed_json: (data.parsed ?? null) as never,
        results_snapshot: (data.results ?? null) as never,
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
  overall: z.enum(["up", "down"]),
  downReasons: z.array(z.string().min(1).max(80)).max(10).default([]),
  comment: z.string().max(500).nullable().optional(),
});

export const submitSearchFeedback = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => SubmitFeedbackInput.parse(input))
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin.from("search_feedback").insert({
      session_id: data.sessionId,
      chosen_from_results: data.chosenFromResults ?? null,
      chosen_external_name: data.chosenExternalName ?? null,
      overall: data.overall,
      down_reasons: data.downReasons ?? [],
      comment: data.comment ?? null,
    });
    if (error) {
      console.error("[feedback] submitSearchFeedback failed:", error);
      return { ok: false as const, error: error.message };
    }
    return { ok: true as const };
  });
