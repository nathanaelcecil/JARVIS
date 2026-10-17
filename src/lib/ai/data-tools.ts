/**
 * Data-tool pre-pass for Gmail / Calendar / Notion.
 *
 * Problem this solves: the main reply is generated BEFORE any tool runs, so for
 * tools that return data the model could only guess (and invented emails).
 * Here the data tools run FIRST; their real results are handed to the model
 * as context, and only then does it write its answer.
 *
 * Two ways a tool call is decided:
 *   1. deterministicPlan() — plain rules for the common cases ("latest mail",
 *      "what's on my calendar today"). No model involved, so it cannot fail.
 *   2. planTools() — a short, strict-JSON model call for everything else
 *      (search a sender, read a Notion page, create a page, ...).
 */

import type { AIProvider } from "./provider";

export interface PlannedTool {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolRun extends PlannedTool {
  result: unknown;
}

/** Tools handled by the pre-pass (everything that touches Google or Notion). */
export const DATA_TOOLS = new Set([
  "gmail_search",
  "gmail_read",
  "gmail_list_recent",
  "gmail_send_email",
  "gmail_reply_email",
  "gmail_forward_email",
  "calendar_list_events",
  "calendar_search_events",
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
  "notion_search",
  "notion_read_page",
  "notion_query_database",
  "notion_create_page",
  "notion_append_blocks",
  "notion_update_page",
  "notion_archive_page",
]);

const DATA_INTENT =
  /\b(e-?mails?|inbox|gmail|calendar|agenda|meetings?|appointments?|notion)\b|\bmy schedule\b|\bwhat'?s on (today|tomorrow)\b/i;

/**
 * Cheap check: does this message plausibly need Gmail / Calendar / Notion?
 * `context` (recent conversation) is also scanned so follow-ups like "add an
 * intro below these lines on the same page" still reach the pre-pass even
 * though they never repeat the keyword.
 */
export function looksLikeDataRequest(message: string, context = ""): boolean {
  return DATA_INTENT.test(message) || (!!context && DATA_INTENT.test(context));
}

// ─── Deterministic rules ─────────────────────────────────────

const WRITE_WORDS =
  /\b(send|compose|draft|write|reply|forward|delete|archive|create|add|book|cancel|reschedule|remind|save|update)\b/;
const MAIL_WORDS = /\b(e-?mails?|mails?|inbox|gmail)\b/;
const CAL_WORDS = /\b(calendar|agenda|meetings?|appointments?|schedule|events?)\b/;
const NEEDS_QUERY = /\b(from|about|regarding|subject|containing|called|named|titled|with)\b/;
const OTHER_TIME =
  /\b(next|last|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}(st|nd|rd|th)?)\b/;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * Plain-rule plan for the simplest read requests. Returns [] whenever the
 * request is anything other than a plain "show me the latest" — those go to
 * the planner instead, which can build a search query.
 */
export function deterministicPlan(
  message: string,
  now: Date = new Date()
): PlannedTool[] {
  const msg = message.toLowerCase();
  if (WRITE_WORDS.test(msg)) return [];

  const plan: PlannedTool[] = [];

  // Independent per service: a message naming several services gets a plan
  // for each. Previously two+ services returned [] and whatever the model
  // planner skipped was silently dropped (Oct 4: Gmail + Calendar + Notion
  // in one message ran Gmail only).
  if (MAIL_WORDS.test(msg) && !NEEDS_QUERY.test(msg)) {
    const unread = /\bunread\b/.test(msg);
    plan.push({
      tool: "gmail_list_recent",
      args: unread
        ? { query: "in:inbox is:unread", maxResults: 5 }
        : { maxResults: 5 },
    });
  }

  if (CAL_WORDS.test(msg) && !NEEDS_QUERY.test(msg)) {
    const today = startOfDay(now);
    if (/\btomorrow\b/.test(msg)) {
      plan.push({
        tool: "calendar_list_events",
        args: {
          timeMin: addDays(today, 1).toISOString(),
          timeMax: addDays(today, 2).toISOString(),
        },
      });
    } else if (/\bthis week\b/.test(msg)) {
      plan.push({
        tool: "calendar_list_events",
        args: {
          timeMin: today.toISOString(),
          timeMax: addDays(today, 7).toISOString(),
          maxResults: 30,
        },
      });
    } else if (!OTHER_TIME.test(msg)) {
      plan.push({ tool: "calendar_list_events", args: {} }); // defaults to today
    }
  }

  return plan;
}

const NOTION_WORDS = /\bnotion\b/i;

const MAIL_TOOLS = ["gmail_search", "gmail_read", "gmail_list_recent"];
const CAL_TOOLS = ["calendar_list_events", "calendar_search_events"];
const NOTION_TOOLS = [
  "notion_search",
  "notion_read_page",
  "notion_query_database",
  "notion_create_page",
  "notion_append_blocks",
  "notion_update_page",
  "notion_archive_page",
];

/**
 * True when the message names a data service that the executed plan does not
 * cover yet. The pre-pass uses this to keep planning instead of trusting the
 * deterministic rules — multi-service messages used to lose every tail service.
 */
export function hasUnplannedServices(
  message: string,
  executed: PlannedTool[]
): boolean {
  const msg = message.toLowerCase();
  const planned = new Set(executed.map((p) => p.tool));
  const covered = (tools: string[]) => tools.some((t) => planned.has(t));
  if (MAIL_WORDS.test(msg) && !covered(MAIL_TOOLS)) return true;
  if (CAL_WORDS.test(msg) && !covered(CAL_TOOLS)) return true;
  if (NOTION_WORDS.test(msg) && !covered(NOTION_TOOLS)) return true;
  return false;
}

// ─── Model planner ───────────────────────────────────────────

export function plannerSystemPrompt(now: Date): string {
  return `You are a tool planner. Decide which tools, if any, are needed to satisfy the user's latest message. Output ONLY one JSON object, no prose, no code fences:
{"tools":[{"tool":"<name>","args":{...}}]}
If no tool is needed, or the results below already contain everything needed, output {"tools":[]}.

Now: ${now.toString()} (ISO ${now.toISOString()}). Use ISO 8601 for any time argument.

Tools:
- gmail_list_recent {maxResults?: number, query?: string}  latest inbox mail
- gmail_search {query: string, maxResults?: number}  Gmail search syntax, e.g. "from:alice subject:invoice"
- gmail_read {messageId: string}  full body; the id must come from earlier results
- calendar_list_events {timeMin?: string, timeMax?: string, maxResults?: number}  defaults to today
- calendar_search_events {query: string, timeMin?: string, timeMax?: string}
- notion_search {query: string, pageSize?: number}  find pages/databases by title
- notion_read_page {pageId: string}  id must come from a notion_search result
- notion_query_database {databaseId: string, pageSize?: number}
- notion_create_page {title: string, content?: string, parentPageId?: string, databaseId?: string}  content is plain text, one block per line ("# " heading, "- " bullet). parentPageId comes from a notion_search result; omit it to use the default parent page
- notion_append_blocks {pageId: string, content: string}  add content to the BOTTOM of an EXISTING page ("add to", "below these lines", "extend the page"); pageId must come from a notion_search/read result in this conversation; content is plain text, one block per line
- notion_update_page {pageId: string, properties: object}
- notion_archive_page {pageId: string}
- gmail_send_email {to: string, subject: string, body: string}  to MUST be a full email address (bob@example.com) — a name alone is not valid
- gmail_reply_email {messageId: string, body: string, to?: string}  messageId from a results block; replies in-thread to the sender; to (when given) must be a full email address
- gmail_forward_email {messageId: string, to: string, note?: string}  messageId from a results block; to MUST be a full email address
- calendar_create_event {summary: string, start: string, end?: string, description?: string, location?: string, timeZone?: string}  start/end ISO 8601 (end defaults to start+30min). Plan-and-enter: turn natural-language plans ("sync tomorrow 4pm") into events
- calendar_update_event {eventId: string, summary?, start?, end?, description?, location?, timeZone?}  eventId from a results block; include only the fields to change
- calendar_delete_event {eventId: string}  eventId from a results block

Rules: pick the fewest tools. Never invent ids — messageId/eventId/pageId/databaseId must come from the results below. Never repeat a tool+args that already ran. Multi-step is fine: list/search first, then write with the returned id.`;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + " …[truncated]";
}

function formatRuns(runs: ToolRun[], perToolLimit: number): string {
  return runs
    .map(
      (r) =>
        `### ${r.tool} ${JSON.stringify(r.args)}\n${truncate(
          JSON.stringify(r.result ?? null),
          perToolLimit
        )}`
    )
    .join("\n\n");
}

/** Tolerant parser: finds the first JSON object and keeps only known tools. */
export function parsePlan(raw: string): PlannedTool[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      tools?: Array<{ tool?: unknown; args?: unknown }>;
    };
    if (!Array.isArray(parsed.tools)) return [];
    const plan: PlannedTool[] = [];
    for (const t of parsed.tools) {
      if (typeof t?.tool !== "string" || !DATA_TOOLS.has(t.tool)) continue;
    const args =
      t.args && typeof t.args === "object" && !Array.isArray(t.args)
        ? (t.args as Record<string, unknown>)
        : {};
    // Drop plans with unresolved template placeholders (e.g. the model
    // echoing "{{notion_search.0.id}}" instead of the real id) — they can
    // only produce a 400 from the API.
    const hasTemplate = Object.values(args).some(
      (v) => typeof v === "string" && v.includes("{{")
    );
    if (hasTemplate) continue;
    plan.push({ tool: t.tool, args });
    }
    return plan.slice(0, 3);
  } catch {
    return [];
  }
}

export async function planTools(opts: {
  provider: AIProvider;
  model: string;
  message: string;
  recentHistory: string;
  runs: ToolRun[];
  signal: AbortSignal;
  now?: Date;
}): Promise<PlannedTool[]> {
  const { provider, model, message, recentHistory, runs, signal } = opts;
  const user =
    (recentHistory ? `Recent conversation:\n${recentHistory}\n\n` : "") +
    `Latest user message:\n${message}` +
    (runs.length
      ? `\n\nTool results so far:\n${formatRuns(runs, 3000)}\n\nIf these already answer the request, or a tool returned an error, output {"tools":[]}. Otherwise output only the additional tools still needed.`
      : "");

  const reply = await provider.chat({
    messages: [
      { role: "system", content: plannerSystemPrompt(opts.now ?? new Date()) },
      { role: "user", content: user },
    ],
    model,
    signal,
    temperature: 0,
  });

  const already = new Set(runs.map((r) => r.tool + JSON.stringify(r.args)));
  return parsePlan(reply.content).filter(
    (p) => !already.has(p.tool + JSON.stringify(p.args))
  );
}

// ─── Context handed to the answering model ───────────────────

/** Appended to the user's message so the model answers from real data only. */
export function buildToolContext(runs: ToolRun[]): string {
  if (runs.length === 0) return "";
  return (
    "\n\n[LIVE TOOL RESULTS — fetched just now for the message above. They are the only source of truth: " +
    "report senders, subjects, dates, events and pages exactly as given; never invent or pad. " +
    'If a result contains "error", state that error plainly and stop. ' +
    "For created or updated Notion pages, quote the returned url. " +
    "Do not request these tools again in the metadata block, and do not claim any change that is not in these results.]\n" +
    truncate(formatRuns(runs, 6000), 14000)
  );
}

/** Used when a data request was detected but no tool produced a result. */
export const NO_DATA_NOTE =
  "\n\n[NOTE: No account data was fetched for this message. Do not describe the user's emails, calendar or Notion contents. " +
  "If they wanted such data, say plainly that nothing was fetched and ask them to rephrase.]";
