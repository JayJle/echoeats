// TEMPORARY local benchmark route for before/after evidence comparison. Delete after the test.
import { createFileRoute } from "@tanstack/react-router";
import { parseRequirements, searchRestaurants, consumeSearchStream } from "@/lib/echo.functions";

type Usage = {
  pplxChat: number;
  pplxSearch: number;
  pplxCostUsd: number;
  pplxInTok: number;
  pplxOutTok: number;
  qwen: Record<string, { calls: number; inTok: number; outTok: number }>;
};

export const Route = createFileRoute("/api/bench")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const host = new URL(request.url).hostname;
        if (host !== "localhost" && host !== "127.0.0.1") return new Response("no", { status: 404 });
        const body = (await request.json()) as { city: string; text: string; lang?: "zh" | "en"; parsed?: Record<string, unknown> };
        const usage: Usage = { pplxChat: 0, pplxSearch: 0, pplxCostUsd: 0, pplxInTok: 0, pplxOutTok: 0, qwen: {} };
        const orig = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const res = await orig(input, init);
          try {
            if (url.includes("api.perplexity.ai/search")) {
              usage.pplxSearch++;
              usage.pplxCostUsd += 0.005;
            } else if (url.includes("api.perplexity.ai/chat")) {
              usage.pplxChat++;
              const j = (await res.clone().json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: { total_cost?: number } } };
              usage.pplxInTok += j.usage?.prompt_tokens ?? 0;
              usage.pplxOutTok += j.usage?.completion_tokens ?? 0;
              usage.pplxCostUsd += j.usage?.cost?.total_cost ?? 0;
            } else if (url.includes("dashscope")) {
              let model = "?";
              try { model = JSON.parse(String(init?.body)).model; } catch { /* */ }
              const j = (await res.clone().json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
              const q = (usage.qwen[model] ??= { calls: 0, inTok: 0, outTok: 0 });
              q.calls++;
              q.inTok += j.usage?.prompt_tokens ?? 0;
              q.outTok += j.usage?.completion_tokens ?? 0;
            }
          } catch { /* ignore metering errors */ }
          return res;
        }) as typeof fetch;
        const t0 = Date.now();
        try {
          const lang = body.lang ?? "zh";
          const parsed = body.parsed ?? await (parseRequirements as unknown as (a: unknown) => Promise<Record<string, unknown>>)({
            data: { city: body.city, cuisines: [], autoInferCuisines: true, date: "", freeText: body.text, uiLanguage: lang },
          });
          const iter = await (searchRestaurants as unknown as (a: unknown) => Promise<AsyncIterable<never>>)({
            data: { ...parsed, mode: "deep", uiLanguage: lang },
          });
          const result = await consumeSearchStream(iter);
          return Response.json({ ms: Date.now() - t0, usage, parsed, result });
        } catch (e) {
          return Response.json({ ms: Date.now() - t0, usage, error: String(e) }, { status: 500 });
        } finally {
          globalThis.fetch = orig;
        }
      },
    },
  },
});
