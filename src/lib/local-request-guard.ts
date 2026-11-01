/**
 * Host / Origin guard for JARVIS's unauthenticated local API routes.
 *
 * WHAT THIS DOES
 * - Rejects a request whose Host header is not a loopback host on one of the
 *   app's own ports. That blocks DNS rebinding: an attacker page pointed at
 *   evil.example (which resolves to 127.0.0.1) still sends Host: evil.example.
 * - Requires the Origin header, when present, to be exactly one of this app's
 *   origins. That blocks a cross-site page from POSTing to the local server.
 *
 * WHAT THIS DOES NOT DO
 * These are not authentication. Any process on this machine can forge Host and
 * Origin and call the routes directly. They only mitigate browser-driven
 * cross-site requests and DNS rebinding.
 *
 * ORIGIN-ABSENT TABLE
 *   GET/HEAD                       → allow (no state change)
 *   POST with no Sec-Fetch-Site    → allow (non-browser client; the local
 *                                    agent's server-to-server callback)
 *   POST with Sec-Fetch-Site none  → allow (address-bar navigation / extension)
 *   POST with same-origin          → allow
 *   POST with cross-site/same-site → reject (403)
 *
 * Applied to /api/stream, /api/confirm, /api/proactive and /api/transcribe.
 * Deliberately NOT applied to /api/agent (bearer auth, VS Code extension) or
 * /api/auth/google* (cross-site OAuth redirects).
 */

export const DEFAULT_LOCAL_PORTS = ["3000", "4173"] as const;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AllowedOriginConfig {
  origins: string[];
  ports: string[];
}

function splitHost(host: string): { hostname: string; port: string } | null {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return null;
    const hostname = trimmed.slice(0, end + 1);
    const rest = trimmed.slice(end + 1);
    if (rest === "") return { hostname, port: "" };
    if (!rest.startsWith(":")) return null;
    return { hostname, port: rest.slice(1) };
  }
  const idx = trimmed.lastIndexOf(":");
  if (idx === -1) return { hostname: trimmed, port: "" };
  return { hostname: trimmed.slice(0, idx), port: trimmed.slice(idx + 1) };
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Build the allowed origin/port sets. `JARVIS_ALLOWED_ORIGINS` adds exact
 * origins (comma separated) and their ports — the escape hatch for a dev
 * server on another port.
 */
export function allowedOriginConfig(
  env: Record<string, string | undefined> = process.env,
): AllowedOriginConfig {
  const ports = new Set<string>(DEFAULT_LOCAL_PORTS);
  const origins = new Set<string>();

  for (const host of LOOPBACK_HOSTNAMES) {
    for (const port of ports) origins.add(`http://${host}:${port}`);
  }

  const extra = env["JARVIS_ALLOWED_ORIGINS"] ?? "";
  for (const raw of extra.split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = normalizeOrigin(trimmed);
    if (!normalized) continue;
    const parsed = new URL(normalized);
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) continue;
    origins.add(normalized);
    if (parsed.port) ports.add(parsed.port);
    // Accept both loopback spellings on an explicitly allowed port.
    for (const host of LOOPBACK_HOSTNAMES) {
      origins.add(`http://${host}:${parsed.port}`);
    }
  }

  return { origins: [...origins], ports: [...ports] };
}

export interface LocalRequestFacts {
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  method: string;
}

export type GuardDecision =
  { ok: true } | { ok: false; status: 403; error: "forbidden_origin"; message: string };

export function evaluateLocalRequest(
  facts: LocalRequestFacts,
  config: AllowedOriginConfig = allowedOriginConfig(),
): GuardDecision {
  const method = facts.method.toUpperCase();

  // ── Host: must be loopback on an allowed port (blocks DNS rebinding) ──
  const host = facts.host ? splitHost(facts.host) : null;
  if (!host || !LOOPBACK_HOSTNAMES.has(host.hostname)) {
    return {
      ok: false,
      status: 403,
      error: "forbidden_origin",
      message: "Request host is not allowed.",
    };
  }
  if (!host.port || !config.ports.includes(host.port)) {
    return {
      ok: false,
      status: 403,
      error: "forbidden_origin",
      message: "Request host is not allowed.",
    };
  }

  // ── Origin present: must match exactly ──
  if (facts.origin !== null && facts.origin !== "") {
    const normalized = normalizeOrigin(facts.origin);
    if (!normalized || !config.origins.includes(normalized)) {
      return {
        ok: false,
        status: 403,
        error: "forbidden_origin",
        message: "Request origin is not allowed.",
      };
    }
    return { ok: true };
  }

  // ── Origin absent: deliberate table (see file header) ──
  if (!STATE_CHANGING_METHODS.has(method)) return { ok: true };

  const site = (facts.secFetchSite ?? "").toLowerCase();
  if (site === "") return { ok: true };
  if (site === "none" || site === "same-origin") return { ok: true };
  return {
    ok: false,
    status: 403,
    error: "forbidden_origin",
    message: "Cross-site request is not allowed.",
  };
}

/**
 * Route-handler helper: returns a 403 Response when the request must be
 * rejected, or null when it may proceed untouched (streaming included).
 */
export function guardLocalRequest(request: Request): Response | null {
  const decision = evaluateLocalRequest({
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    method: request.method,
  });
  if (decision.ok) return null;
  return Response.json(
    { error: decision.error, message: decision.message },
    { status: decision.status, headers: { "Cache-Control": "no-store" } },
  );
}

/** Exposed for tests and documentation. */
export const LOCAL_GUARD_RULES = {
  loopbackHostnames: [...LOOPBACK_HOSTNAMES],
  defaultPorts: [...DEFAULT_LOCAL_PORTS],
  stateChangingMethods: [...STATE_CHANGING_METHODS],
} as const;
