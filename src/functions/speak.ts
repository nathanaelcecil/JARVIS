import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Optional XTTS tuning parameters, forwarded verbatim (whitelisted keys only)
 * to the local XTTS server. Key names verified against the installed
 * coqui-tts `Xtts.inference` signature in .xtts-venv:
 *   temperature, length_penalty, repetition_penalty, top_k, top_p,
 *   do_sample, num_beams, speed, split_sentences
 */
const ttsParamsSchema = z
  .object({
    temperature: z.number().min(0).max(1),
    length_penalty: z.number().min(0.1).max(5),
    repetition_penalty: z.number().min(1).max(20),
    top_k: z.number().int().min(1).max(200),
    top_p: z.number().min(0).max(1),
    do_sample: z.boolean(),
    num_beams: z.number().int().min(1).max(10),
    speed: z.number().min(0.5).max(2),
    split_sentences: z.boolean(),
  })
  .partial();

const speakInputSchema = z.object({
  text: z.string().min(1),
  params: ttsParamsSchema.optional(),
});

/** Explicit hard limit — chunking guarantees ≤ ~300 chars. Anything larger
 *  is a chunking bug, so we reject loudly instead of silently truncating
 *  (the old behavior dropped the tail of the text without telling anyone). */
const MAX_TTS_CHARS = 500;

export const speak = createServerFn({ method: "POST" })
  .validator(speakInputSchema)
  .handler(async ({ data }) => {
    const xttsUrl = process.env["XTTS_URL"] || "http://127.0.0.1:8080";

    if (data.text.length > MAX_TTS_CHARS) {
      const msg = `TTS input too long: ${data.text.length} chars (limit ${MAX_TTS_CHARS}) — chunking failed`;
      console.error(`[XTTS] ${msg}`);
      return { audioUrl: null, error: msg };
    }

    const started = Date.now();
    try {
      const res = await fetch(`${xttsUrl}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: data.text,
          ...(data.params ? { params: data.params } : {}),
        }),
        signal: AbortSignal.timeout(120000), // 2 minutes — XTTS on CPU can be slow
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`[XTTS] Server error (${res.status}) after ${Date.now() - started}ms`);
        throw new Error(`XTTS error (${res.status}): ${err}`);
      }

      const audioBuffer = await res.arrayBuffer();

      // Use Uint8Array + btoa for web-compatible base64 encoding (no Buffer dependency)
      const bytes = new Uint8Array(audioBuffer);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]!);
      }
      const base64 = btoa(binary);
      const dataUrl = `data:audio/wav;base64,${base64}`;

      // Per-request latency, no message content (privacy).
      console.log(
        `[XTTS] ${data.text.length} chars → ${Date.now() - started}ms, ${audioBuffer.byteLength} bytes`,
      );
      return { audioUrl: dataUrl };
    } catch (err) {
      console.error(`[XTTS] Request failed after ${Date.now() - started}ms:`, err);
      return { audioUrl: null, error: String(err) };
    }
  });
