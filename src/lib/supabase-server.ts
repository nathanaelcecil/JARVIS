import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

// Server-only: uses service role key, never exposed to browser.
//
// Supabase is OPTIONAL. createClient() throws on an empty URL/key, and this
// module used to call it at import time — so a first run without .env.local
// crashed /api/stream (which statically imports this file) before any request
// was served. Initialization is therefore lazy, and every unconfigured query
// resolves to an explicit `supabase_not_configured` error rather than throwing
// or silently pretending to persist.

export const SUPABASE_NOT_CONFIGURED_MESSAGE =
  "Supabase is not configured — persistence is disabled. Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.";

/** True when both server-side Supabase credentials are present. */
export function isSupabaseConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env["VITE_SUPABASE_URL"] && env["SUPABASE_SERVICE_ROLE_KEY"]);
}

let cachedClient: SupabaseClient | null = null;

/**
 * Shared admin client, or null when unconfigured.
 * Re-checks env on every call (cheap) so an unconfigured process can never
 * hand back a client built from missing credentials.
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (cachedClient) return cachedClient;

  const supabaseUrl = process.env["VITE_SUPABASE_URL"] as string;
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"] as string;

  // Pass ws as the realtime transport so the RealtimeClient can initialize
  // without a native WebSocket global. We don't use realtime features,
  // but supabase-js always creates a RealtimeClient internally.
  cachedClient = createClient(supabaseUrl, serviceRoleKey, {
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
  return cachedClient;
}

let warnedUnconfigured = false;

/**
 * Query builder used when Supabase is unavailable. Every chained method
 * returns the same thenable, which resolves to `{ data: null, error }` — so
 * call sites that inspect `r.error` report the real failure, reads fall back
 * to empty results, and nothing throws.
 */
function createNullBuilder(): unknown {
  const result = {
    data: null,
    count: null,
    error: {
      message: SUPABASE_NOT_CONFIGURED_MESSAGE,
      code: "supabase_not_configured",
      details: null,
      hint: null,
    },
  };
  const promise = Promise.resolve(result);
  const target: Record<string, unknown> = {};
  const proxy: Record<string, unknown> = new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") return promise.then.bind(promise);
      if (prop === "catch") return promise.catch.bind(promise);
      if (prop === "finally") return promise.finally.bind(promise);
      return () => proxy;
    },
  });
  if (!warnedUnconfigured) {
    warnedUnconfigured = true;
    console.warn(`[Supabase] ${SUPABASE_NOT_CONFIGURED_MESSAGE}`);
  }
  return proxy;
}

/**
 * Drop-in admin client. Delegates to the real client when configured; yields
 * the null builder when not, so existing `supabaseAdmin.from(...)` call sites
 * keep working without a module-scope crash.
 */
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    if (prop === "from") {
      return (table: string) => {
        const client = getSupabaseAdmin();
        if (client) return client.from(table);
        return createNullBuilder();
      };
    }
    const client = getSupabaseAdmin();
    if (!client) return undefined;
    return Reflect.get(client, prop, client);
  },
});
