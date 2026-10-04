import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const speakInputSchema = z.object({
  text: z.string().min(1),
});

export const speak = createServerFn({ method: "POST" })
  .validator(speakInputSchema)
  .handler(async ({ data }) => {
    const xttsUrl = process.env["XTTS_URL"] || "http://127.0.0.1:8080";

    // Truncate text to first 500 chars — XTTS on CPU is slow with long text
    const truncatedText = data.text.length > 500 ? data.text.slice(0, 500) + "..." : data.text;

    try {
      console.log(`[XTTS] Speaking: "${truncatedText.slice(0, 80)}..."`);
      
      const res = await fetch(`${xttsUrl}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: truncatedText }),
        signal: AbortSignal.timeout(120000), // 2 minutes — XTTS on CPU can be slow
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`[XTTS] Server error (${res.status}): ${err}`);
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

      console.log(`[XTTS] Audio ready: ${audioBuffer.byteLength} bytes`);
      return { audioUrl: dataUrl };
    } catch (err) {
      console.error("[XTTS] Request failed:", err);
      return { audioUrl: null, error: String(err) };
    }
  });
