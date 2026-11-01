/**
 * Conversation history search — "what did we decide about X last week?"
 *
 * The chat is already in Postgres (`messages`), so this is a read-only query
 * plus a small amount of shaping. Two things matter for the answer quality:
 *
 * 1. **The match is honest.** Postgres `ilike` finds the term; the pure
 *    `rankMessages` step only *orders* what came back. Nothing is invented, and
 *    a search that finds nothing says so instead of guessing.
 *
 * 2. **The snippet is centred.** A hit in the middle of a long reply is useless
 *    if the model only sees the first 200 characters, so each hit is cut around
 *    the match with a little context on both sides.
 *
 * The ranking is a pure function, which is what the tests pin; the Supabase call
 * is a thin wrapper around it.
 */

export const MAX_RESULTS_DEFAULT = 8;
export const MAX_RESULTS_CAP = 30;
export const MAX_QUERY_CHARS = 120;
export const SNIPPET_RADIUS = 160;

export interface HistoryRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface HistoryHit {
  id: string;
  sessionId: string;
  role: string;
  createdAt: string;
  /** A window of the message around the first match. */
  snippet: string;
  /** Whole-message character count, so a snippet is never mistaken for all of it. */
  length: number;
}

/**
 * The words an `ilike` should look for, or null when the query cannot match.
 * PostgREST's filter syntax treats `,` `.` `(` `)` `:` specially, so those are
 * stripped rather than escaped; a search that loses a comma still works, a
 * filter that breaks does not.
 */
export function normalizeHistoryQuery(query: string): string | null {
  const cleaned = query
    .replace(/[,()*:%]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_CHARS);
  return cleaned.length >= 2 ? cleaned : null;
}

/** A window of `content` around the first case-insensitive match. */
export function makeSnippet(content: string, query: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.trim().toLowerCase());
  if (at === -1) {
    return flat.length > SNIPPET_RADIUS * 2 ? `${flat.slice(0, SNIPPET_RADIUS * 2)}…` : flat;
  }
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + query.trim().length + SNIPPET_RADIUS);
  const head = start > 0 ? "…" : "";
  const tail = end < flat.length ? "…" : "";
  return `${head}${flat.slice(start, end)}${tail}`;
}

/**
 * Order hits newest-first, then shape them into snippets. Rows already come
 * back from Postgres newest-first; this re-establishes that after any filtering
 * so a caller can pass rows in any order.
 */
export function rankMessages(rows: HistoryRow[], query: string, limit: number): HistoryHit[] {
  const cap = Math.min(Math.max(limit, 1), MAX_RESULTS_CAP);
  return [...rows]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, cap)
    .map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      createdAt: row.created_at,
      snippet: makeSnippet(row.content ?? "", query),
      length: (row.content ?? "").length,
    }));
}

/** Search the chat history. Read-only; safe to call on every request. */
export async function historySearch(params: {
  query: string;
  limit?: number;
  sessionId?: string;
  role?: "user" | "assistant";
  days?: number;
}): Promise<unknown> {
  const query = normalizeHistoryQuery(params.query ?? "");
  if (!query) {
    return {
      ok: false,
      code: "usage",
      error: "a search needs at least two characters of text",
    };
  }

  const { supabaseAdmin } = await import("./supabase-server");
  let request = supabaseAdmin
    .from("messages")
    .select("id, session_id, role, content, created_at")
    .ilike("content", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(params.limit ?? MAX_RESULTS_DEFAULT, 1), MAX_RESULTS_CAP));

  if (params.sessionId) request = request.eq("session_id", params.sessionId);
  if (params.role) request = request.eq("role", params.role);
  if (typeof params.days === "number" && params.days > 0) {
    const since = new Date(Date.now() - params.days * 86_400_000).toISOString();
    request = request.gte("created_at", since);
  }

  const { data, error } = await request;
  if (error) {
    return { ok: false, code: "history_failed", error: error.message };
  }

  const hits = rankMessages(
    (data ?? []) as HistoryRow[],
    query,
    params.limit ?? MAX_RESULTS_DEFAULT,
  );
  return {
    ok: true,
    tool: "history_search",
    query,
    count: hits.length,
    ...(hits.length === 0
      ? { note: "Nothing in the saved conversation matches that. Do not assume it was discussed." }
      : {}),
    results: hits,
  };
}
