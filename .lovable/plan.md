# Fix audio transcription not adding text

## Findings from your latest test

- The browser sent `POST /api/transcribe`.
- The backend returned **500** at `2026-05-20T11:06:40Z`.
- The `ELEVENLABS_API_KEY` secret is configured, so this is not simply a missing key.
- The current client code shows a generic transcription failure and does not log enough detail to identify whether the uploaded audio format or the upstream speech-to-text response caused the 500.

## Plan

### 1. Add precise server-side diagnostics in `/api/transcribe`

Update `src/routes/api/transcribe.ts` to log safe, non-secret details:

- incoming audio `size` and `type`
- chosen filename/extension
- upstream status code
- a short upstream error preview when ElevenLabs rejects the audio

This will make future failures visible in server logs without exposing secrets or full audio content.

### 2. Fix likely audio-format mismatch

The client currently always forwards the uploaded blob to ElevenLabs as `audio.webm`, even when the browser recorded `audio/mp4`, `audio/aac`, or another format.

Change the API route to preserve the uploaded filename/type when forwarding to ElevenLabs instead of forcing `audio.webm`. This is a likely cause of 500s from the transcription provider.

### 3. Make the recorder more reliable on mobile/Safari

Update `src/routes/requirements.tsx`:

- start `MediaRecorder` with a small timeslice, e.g. `recorder.start(500)`, so `dataavailable` fires reliably before stop
- add guarded logs for recorder lifecycle: start, data chunks, stop, upload response
- replace swallowed `catch { ... }` with `catch (err) { console.error(...) }`
- keep existing UX and translations unchanged unless an existing error key already fits

### 4. Improve client error parsing

If `/api/transcribe` returns a JSON error, surface it consistently in the toast. If it returns non-JSON text, show a generic message but log the raw response to the console.

## Files to change

- `src/routes/api/transcribe.ts`
- `src/routes/requirements.tsx`

## Expected result

- Voice input should append transcribed text after recording.
- If the provider still rejects the audio, the exact safe reason will appear in logs so we can fix the remaining issue quickly.