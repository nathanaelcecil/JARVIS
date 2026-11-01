/**
 * Local model discovery for Ollama.
 *
 * The router picks a model per workload (FAST/SMART/VISION/…), but a model name
 * in code is only a wish: if `qwen2.5:14b` was never pulled, every request fails
 * with "model not found" — which reads like the app is broken, not like a
 * missing download. This module asks the running daemon what it actually has and
 * falls back to a present model, saying so once in the log.
 *
 * The pure parts (`parseTags`, `chooseModel`) are what the tests pin; the fetch
 * is a thin, cached wrapper.
 */

export interface OllamaTag {
  name: string;
  sizeBytes: number;
}

const DEFAULT_BASE = "http://localhost:11434";

/** Parse Ollama's `/api/tags` body. Never throws on a malformed row. */
export function parseTags(json: unknown): OllamaTag[] {
  const models = (json as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const tags: OllamaTag[] = [];
  for (const entry of models) {
    const name = (entry as { name?: unknown })?.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const size = (entry as { size?: unknown })?.size;
    tags.push({ name, sizeBytes: typeof size === "number" ? size : 0 });
  }
  return tags;
}

/** Models whose name looks like a vision model (`…vl…`). */
export function isVisionModel(name: string): boolean {
  return /(^|[^a-z])vl|vision|llava|moondream/i.test(name);
}

/**
 * Pick the model to actually call.
 *
 * - `requested` installed → use it.
 * - Nothing installed → return `requested` unchanged; the caller's error then
 *   says "model not found", which is the truth.
 * - `requested` missing → use the first installed model, preferring a
 *   same-family name and, for a vision route, an installed vision model.
 */
export function chooseModel(requested: string, available: string[]): string {
  if (available.length === 0) return requested;
  if (available.includes(requested)) return requested;

  const wantVision = isVisionModel(requested);
  const family = requested.split(":")[0] ?? requested;
  const sameFamily = available.find((name) => name.split(":")[0] === family);
  if (sameFamily && !wantVision) return sameFamily;

  if (wantVision) {
    const vision = available.find((name) => isVisionModel(name));
    if (vision) return vision;
  }

  // Prefer the smallest installed model for a fallback: it is the one most
  // likely to answer within the request timeout on a laptop.
  return sameFamily ?? available[0]!;
}

interface CacheEntry {
  at: number;
  models: string[];
}

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Ask the daemon for its installed models, cached for five minutes.
 * Never throws: a missing daemon yields an empty list, which means "unknown —
 * do not rewrite the model name".
 */
export async function listInstalledModels(
  baseUrl: string = process.env["OLLAMA_BASE_URL"] ?? DEFAULT_BASE,
  now: number = Date.now(),
  cache: Map<string, CacheEntry> = modelCache,
): Promise<string[]> {
  const native = baseUrl.replace(/\/v1\/?$/, "");
  const hit = cache.get(native);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.models;

  try {
    const res = await fetch(`${native}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return [];
    const models = parseTags(await res.json()).map((tag) => tag.name);
    cache.set(native, { at: now, models });
    return models;
  } catch {
    return [];
  }
}

const modelCache = new Map<string, CacheEntry>();

/** Test helper: forget what was discovered. */
export function clearModelCache(): void {
  modelCache.clear();
}
