/**
 * AI Provider abstraction layer.
 * Swap providers by changing the class + config — not rewriting callers.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ResponseMetadata {
  correction?: { behavior: string };
  inferredPattern?: { description: string; question: string };
  memory?: { fact: string; category?: string }[];
}

export interface AIProvider {
  chat(params: {
    messages: ChatMessage[];
    model: string;
    signal?: AbortSignal;
  }): Promise<{ content: string; metadata?: ResponseMetadata }>;

  chatStream?(params: {
    messages: ChatMessage[];
    model: string;
    signal?: AbortSignal;
  }): AsyncGenerator<string, void, unknown>;
}

// ─── Local Ollama Provider (OpenAI-compatible) ──────────────
// Active path: local Ollama server at localhost:11434, model qwen2.5:14b.
// No API key required — a placeholder is sent for OpenAI-compat clients.

/**
 * Model keep-alive: -1 = never unload (pin the model in RAM, no reload
 * stalls after idle). Configurable via OLLAMA_KEEP_ALIVE env var (default
 * '-1') so behavior can change without code edits. Shared by chat() and
 * chatStream() so both paths pin the model identically.
 */
function ollamaKeepAlive(): string | number {
  const keepAliveRaw = process.env["OLLAMA_KEEP_ALIVE"] ?? "-1";
  const trimmed = keepAliveRaw.trim();
  return trimmed === ""
    ? "-1"
    : /^-?\d+$/.test(trimmed)
      ? Number(trimmed)
      : trimmed;
}

/**
 * When each model was last re-pinned. Pinning happens at most once per
 * PIN_INTERVAL_MS — NOT on every request: a preload request carries an
 * empty prompt that competes for Ollama's KV-cache slots and evicts the
 * app's cached prompt prefix, which we measured as intermittent 3–8s
 * first-token delays. Once pinned with keep_alive=-1 the model stays
 * loaded anyway; the periodic refresh only re-establishes the pin if the
 * Ollama daemon restarted in between.
 */
const pinnedAt = new Map<string, number>();
const PIN_INTERVAL_MS = 10 * 60 * 1000;

export class OllamaProvider implements AIProvider {
  private baseUrl = process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434/v1";
  private apiKey = process.env["OLLAMA_API_KEY"] ?? "ollama";

  /**
   * Pin the model in memory via Ollama's native /api/generate preload
   * request ({model, keep_alive}, no prompt = load, don't generate).
   *
   * Why this exists: Ollama's OpenAI-compatible /v1/chat/completions
   * endpoint silently IGNORES the keep_alive field (verified live: the
   * native /api/chat honors it, /v1 does not). Without this pin the
   * daemon's 5-minute default applies and the model unloads on idle,
   * costing a ~15s reload after every idle gap.
   *
   * Fire-and-forget: when the model is already loaded this returns in
   * ~1ms; when unloaded it runs concurrently with the actual chat request
   * (Ollama serializes loads), so it never adds latency.
   */
  private pinModelKeepAlive(model: string): void {
    const now = Date.now();
    const last = pinnedAt.get(model);
    if (last !== undefined && now - last < PIN_INTERVAL_MS) return;
    pinnedAt.set(model, now);
    const nativeBase = this.baseUrl.replace(/\/v1\/?$/, "");
    fetch(`${nativeBase}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: ollamaKeepAlive() }),
    }).catch(() => {
      /* non-fatal — the chat request itself still loads the model */
    });
  }

  async chat(params: {
    messages: ChatMessage[];
    model: string;
    signal?: AbortSignal;
  }): Promise<{ content: string; metadata?: ResponseMetadata }> {
    const { messages, model, signal } = params;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);
    if (signal) {
      if (signal.aborted) controller.abort();
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    this.pinModelKeepAlive(model);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
          // No max_tokens cap — let the local model finish its reply.
          // (keep_alive is set via pinModelKeepAlive(); /v1 ignores it.)
        }),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      throw new Error(
        `Ollama unreachable (${this.baseUrl}): ${fetchErr instanceof Error ? fetchErr.message : fetchErr} — is \`ollama serve\` running?`
      );
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      throw new Error(`Ollama API error (${response.status}): ${err}`);
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
    };

    const raw = data.choices[0]?.message?.content ?? "";
    const { text, metadata } = parseMetadataBlock(raw, "Ollama");
    const result: { content: string; metadata?: ResponseMetadata } = { content: text };
    if (metadata) result.metadata = metadata;
    return result;
  }

  async *chatStream(params: {
    messages: ChatMessage[];
    model: string;
    signal?: AbortSignal;
  }): AsyncGenerator<string, void, unknown> {
    const { messages, model, signal } = params;

    this.pinModelKeepAlive(model);

    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
          stream: true,
        }),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      throw new Error(
        `Ollama unreachable: ${fetchErr instanceof Error ? fetchErr.message : fetchErr} — is \`ollama serve\` running?`
      );
    }

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      throw new Error(`Ollama API error (${response.status}): ${err}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data) as {
              choices: { delta: { content?: string } }[];
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse the ---METADATA--- block from a full (streamed) response.
   * stream.ts calls this after streaming completes — without it, tool calls
   * in the metadata block are never executed on the streaming path.
   */
  parseMetadata(raw: string): { text: string; metadata?: ResponseMetadata } {
    return parseMetadataBlock(raw, "Ollama");
  }
}

// ─── Shared metadata parser ─────────────────────────────────

function parseMetadataBlock(
  raw: string,
  tag = "Metadata"
): { text: string; metadata?: ResponseMetadata } {
  const separator = "---METADATA---";
  const idx = raw.indexOf(separator);
  if (idx === -1) {
    console.log(`[${tag}] No ---METADATA--- block found in response`);
    return { text: raw.trim() };
  }
  const text = raw.slice(0, idx).trim();
  const metaStr = raw.slice(idx + separator.length).trim();
  console.log(`[${tag}] Raw metadata:`, metaStr.substring(0, 200));
  try {
    const parsed = JSON.parse(metaStr) as ResponseMetadata;
    console.log(`[${tag}] Parsed:`, JSON.stringify(parsed));
    return { text, metadata: parsed };
  } catch (parseErr) {
    console.error(`[${tag}] JSON parse FAILED:`, parseErr);
    return { text: raw.trim() };
  }
}

// ─── Z.ai (GLM) Provider [DISABLED — restore by re-enabling in createProvider] ───

export class ZAIProvider implements AIProvider {
  private baseUrl = "https://api.z.ai/api/paas/v4";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async chat(params: {
    messages: ChatMessage[];
    model: string;
    signal?: AbortSignal;
  }): Promise<{ content: string; metadata?: ResponseMetadata }> {
    const { messages, model, signal } = params;

    const MAX_RETRIES = 5;
    const RETRY_DELAYS_MS = [2000, 4000, 8000, 12000, 15000];
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? 12000;
        console.log(`[ZAI] Retrying (${attempt}/${MAX_RETRIES}) after ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }

      let response: Response;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);
        // Chain external signal if provided
        if (signal) {
          if (signal.aborted) controller.abort();
          signal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.7,
            max_tokens: 2048,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch (fetchErr) {
        lastError = new Error(`Z.ai network error: ${fetchErr instanceof Error ? fetchErr.message : fetchErr}`);
        console.warn(`[ZAI] ${lastError.message}`);
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        const errBody = await response.text().catch(() => "");
        lastError = new Error(`Z.ai API error (${response.status}): ${errBody || "transient overload"}`);
        console.warn(`[ZAI] ${lastError.message}`);
        continue;
      }

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Z.ai API error (${response.status}): ${err}`);
      }

      const data = (await response.json()) as {
        choices: { message: { content: string } }[];
      };

      const raw = data.choices[0]?.message?.content ?? "";
      const { text, metadata } = this.parseMetadata(raw);
      const result: { content: string; metadata?: ResponseMetadata } = { content: text };
      if (metadata) {
        result.metadata = metadata;
      }
      return result;
    }

    throw lastError ?? new Error("Z.ai API: all retries exhausted");
  }

  async *chatStream(params: {
    messages: ChatMessage[];
    model: string;
    signal?: AbortSignal;
  }): AsyncGenerator<string, void, unknown> {
    const { messages, model, signal } = params;

    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
          max_tokens: 2048,
          stream: true,
        }),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      throw new Error(`Z.ai network error: ${fetchErr instanceof Error ? fetchErr.message : fetchErr}`);
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Z.ai API error (${response.status}): ${err}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data) as {
              choices: { delta: { content?: string } }[];
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Shared metadata parser — works on accumulated full text */
  parseMetadata(raw: string): { text: string; metadata?: ResponseMetadata } {
    const separator = "---METADATA---";
    const idx = raw.indexOf(separator);
    if (idx === -1) {
      console.log("[Metadata] No ---METADATA--- block found in response");
      return { text: raw.trim() };
    }
    const text = raw.slice(0, idx).trim();
    const metaStr = raw.slice(idx + separator.length).trim();
    console.log("[Metadata] Raw metadata:", metaStr.substring(0, 200));
    try {
      const parsed = JSON.parse(metaStr) as ResponseMetadata;
      console.log("[Metadata] Parsed:", JSON.stringify(parsed));
      return { text, metadata: parsed };
    } catch (parseErr) {
      console.error("[Metadata] JSON parse FAILED:", parseErr);
      console.error("[Metadata] Raw was:", metaStr);
      return { text: raw.trim() };
    }
  }
}

// ─── Google Gemini Fallback Provider ────────────────────────

export class GeminiProvider implements AIProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async chat(params: {
    messages: ChatMessage[];
    model: string;
    signal?: AbortSignal;
  }): Promise<{ content: string; metadata?: ResponseMetadata }> {
    const { messages, signal } = params;

    // Convert to Gemini format
    const systemMsg = messages.find((m) => m.role === "system");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [
          {
            text:
              typeof m.content === "string"
                ? m.content
                : m.content
                    .filter((p) => p.type === "text")
                    .map((p) => ("text" in p ? p.text : ""))
                    .join(""),
          },
        ],
      }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
      },
    };

    if (systemMsg) {
      const sysText =
        typeof systemMsg.content === "string"
          ? systemMsg.content
          : systemMsg.content
              .filter((p) => p.type === "text")
              .map((p) => ("text" in p ? p.text : ""))
              .join("");
      body["systemInstruction"] = { parts: [{ text: sysText }] };
    }

    const geminiModel = "gemini-3.6-flash";

    const fetchOpts: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    if (signal) fetchOpts.signal = signal;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${this.apiKey}`,
      fetchOpts
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${err}`);
    }

    const data = (await response.json()) as {
      candidates: { content: { parts: { text: string }[] } }[];
    };

    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const { text, metadata } = this.parseMetadata(raw);
    const result: { content: string; metadata?: ResponseMetadata } = {
      content: text,
    };
    if (metadata) result.metadata = metadata;
    return result;
  }

  private parseMetadata(raw: string): { text: string; metadata?: ResponseMetadata } {
    const separator = "---METADATA---";
    const idx = raw.indexOf(separator);
    if (idx === -1) {
      console.log("[Metadata:Gemini] No ---METADATA--- block found");
      return { text: raw.trim() };
    }
    const text = raw.slice(0, idx).trim();
    const metaStr = raw.slice(idx + separator.length).trim();
    console.log("[Metadata:Gemini] Raw metadata:", metaStr.substring(0, 200));
    try {
      const parsed = JSON.parse(metaStr) as ResponseMetadata;
      console.log("[Metadata:Gemini] Parsed:", JSON.stringify(parsed));
      return { text, metadata: parsed };
    } catch (parseErr) {
      console.error("[Metadata:Gemini] JSON parse FAILED:", parseErr);
      return { text: raw.trim() };
    }
  }
}

// ─── Fallback Wrapper — tries primary, falls back on failure ─

export class FallbackProvider implements AIProvider {
  private primary: AIProvider;
  private fallback: AIProvider | null;

  constructor(primary: AIProvider, fallback: AIProvider | null = null) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async chat(params: {
    messages: ChatMessage[];
    model: string;
    signal?: AbortSignal;
  }): Promise<{ content: string; metadata?: ResponseMetadata }> {
    try {
      return await this.primary.chat(params);
    } catch (primaryErr) {
      if (params.signal?.aborted) throw primaryErr; // Don't fallback if user cancelled
      console.warn(
        `[Provider] Primary failed: ${primaryErr instanceof Error ? primaryErr.message : primaryErr}`
      );

      if (!this.fallback) {
        throw primaryErr;
      }

      console.log("[Provider] Falling back to secondary provider...");
      try {
        return await this.fallback.chat(params);
      } catch (fallbackErr) {
        console.error(`[Provider] Fallback also failed: ${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`);
        throw primaryErr; // throw original error since that's the one the user hit first
      }
    }
  }
}

// ─── Provider Factory ───────────────────────────────────────

export function createProvider(): AIProvider {
  // ── Active path: local Ollama (qwen2.5:14b) ──
  console.log("[Provider] Using local Ollama (localhost:11434, qwen2.5:14b)");
  return new OllamaProvider();

  // ── DISABLED (2026-09): Z.ai primary + Gemini fallback ──
  // Restore by deleting the two lines above and uncommenting below.
  //
  // const apiKey = process.env["ZAI_API_KEY"];
  // if (!apiKey) {
  //   throw new Error("ZAI_API_KEY environment variable is not set");
  // }
  //
  // const primary = new ZAIProvider(apiKey);
  //
  // // Optional fallback: Google Gemini (free tier)
  // const fallbackKey = process.env["GEMINI_API_KEY"];
  // if (fallbackKey) {
  //   console.log("[Provider] Gemini fallback configured");
  //   return new FallbackProvider(primary, new GeminiProvider(fallbackKey));
  // }
  //
  // return primary;
}
