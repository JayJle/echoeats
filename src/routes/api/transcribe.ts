import { createFileRoute } from "@tanstack/react-router";
import { withRetry } from "@/lib/retry.server";


export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
          return new Response(
            JSON.stringify({ error: "ELEVENLABS_API_KEY is not configured" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        let inForm: FormData;
        try {
          inForm = await request.formData();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid form data" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const audio = inForm.get("audio");
        if (!(audio instanceof Blob)) {
          return new Response(JSON.stringify({ error: "Missing audio file" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (audio.size === 0) {
          return new Response(JSON.stringify({ error: "Empty audio file" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (audio.size > 25 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: "Audio file too large (max 25MB)" }), {
            status: 413,
            headers: { "Content-Type": "application/json" },
          });
        }

        const incomingName = (audio as File).name || "";
        const incomingType = audio.type || "";
        const ext = incomingName.includes(".")
          ? incomingName.split(".").pop()!.toLowerCase()
          : incomingType.includes("mp4") || incomingType.includes("aac") || incomingType.includes("m4a")
            ? "mp4"
            : incomingType.includes("ogg")
              ? "ogg"
              : incomingType.includes("wav")
                ? "wav"
                : incomingType.includes("mpeg") || incomingType.includes("mp3")
                  ? "mp3"
                  : "webm";
        const filename = `audio.${ext}`;
        const upstreamType = incomingType || (ext === "mp4" ? "audio/mp4" : ext === "ogg" ? "audio/ogg" : ext === "wav" ? "audio/wav" : ext === "mp3" ? "audio/mpeg" : "audio/webm");
        console.log(`[transcribe] in size=${audio.size} type=${incomingType || "?"} name=${incomingName || "?"} -> filename=${filename} upstreamType=${upstreamType}`);

        const audioBlob = audio.type === upstreamType ? audio : new Blob([await audio.arrayBuffer()], { type: upstreamType });
        const outForm = new FormData();
        outForm.append("file", audioBlob, filename);
        outForm.append("model_id", "scribe_v2");
        outForm.append("tag_audio_events", "false");
        outForm.append("diarize", "false");

        let upstream: Response;
        try {
          upstream = await withRetry(
            (signal) =>
              fetch("https://api.elevenlabs.io/v1/speech-to-text", {
                method: "POST",
                headers: { "xi-api-key": apiKey },
                body: outForm,
                signal,
              }).then((r) => {
                // 5xx/网络层抛错触发重试；429/4xx 不重试，直接返回让下游处理
                if (!r.ok && r.status >= 500) throw new Error(`ElevenLabs ${r.status}`);
                return r;
              }),
            { label: "transcribe", retries: 1, timeoutMs: 20_000 },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[transcribe] retry exhausted: ${msg}`);
          return new Response(
            JSON.stringify({ error: "Transcription service unavailable, please try again" }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
        }

        if (!upstream.ok) {
          const text = await upstream.text();
          console.error(`[transcribe] upstream ${upstream.status}: ${text.slice(0, 500)}`);
          const status = upstream.status === 429 || upstream.status === 402
            ? upstream.status
            : 500;
          return new Response(
            JSON.stringify({ error: text || `Transcription failed: ${upstream.status}` }),
            { status, headers: { "Content-Type": "application/json" } },
          );
        }

        const data = (await upstream.json()) as { text?: string; language_code?: string };
        return Response.json({
          text: data.text ?? "",
          language: data.language_code,
        });
      },
    },
  },
});
