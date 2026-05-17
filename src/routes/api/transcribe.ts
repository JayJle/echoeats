import { createFileRoute } from "@tanstack/react-router";

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

        const outForm = new FormData();
        outForm.append("file", audio, "audio.webm");
        outForm.append("model_id", "scribe_v2");
        outForm.append("tag_audio_events", "false");
        outForm.append("diarize", "false");

        const upstream = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
          method: "POST",
          headers: { "xi-api-key": apiKey },
          body: outForm,
        });

        if (!upstream.ok) {
          const text = await upstream.text();
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
