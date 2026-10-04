/**
 * MCP (Model Context Protocol) Server Registry
 *
 * Config-driven list of connected MCP servers.
 * Add a server here to make its tools available to JARVIS.
 *
 * The local agent (local-agent/server.ts) handles filesystem, desktop-control,
 * and system tools on the Mac. Started alongside the web app by start-jarvis.command.
 */

export interface MCPTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface MCPServer {
  name: string;
  url: string;
  tools: MCPTool[];
  enabled: boolean;
}

export const MCP_REGISTRY: MCPServer[] = [
  // ── Local Agent (filesystem, desktop control, system) ──
  {
    name: "local-agent",
    url: "http://127.0.0.1:3008",
    tools: [
      // Filesystem
      { name: "list_directory", description: "List files and folders in a directory path", parameters: { path: { type: "string", description: "Absolute path or ~ for home" } } },
      { name: "search_files", description: "Search for files by name pattern within a directory tree", parameters: { path: { type: "string" }, pattern: { type: "string", description: "Filename substring to match (case-insensitive)" }, maxResults: { type: "number" } } },
      { name: "open_in_finder", description: "Open a file or folder in Finder", parameters: { path: { type: "string" } } },
      { name: "get_file_metadata", description: "Get size, dates, type, permissions for a file or folder", parameters: { path: { type: "string" } } },

      // Desktop control
      { name: "open_app", description: "Open a macOS application by name (e.g. Chrome, Spotify, Terminal)", parameters: { name: { type: "string", description: "App name or bundle ID" } } },
      { name: "quit_app", description: "Gracefully quit a running macOS application", parameters: { name: { type: "string", description: "App name" } } },
      { name: "list_running_apps", description: "List all currently running user-facing applications (excludes system processes)", parameters: {} },

      // System
      { name: "get_volume", description: "Get current system volume (0-100)", parameters: {} },
      { name: "set_volume", description: "Set system volume to a specific level (0-100). Verifies the change took effect.", parameters: { level: { type: "number", description: "Volume level 0-100" } } },
      { name: "get_brightness", description: "Get display brightness (0-100)", parameters: {} },
      { name: "get_battery", description: "Get battery percentage and charging status", parameters: {} },
      { name: "get_ram", description: "Get RAM total, used, and available in GB", parameters: {} },
      { name: "get_storage", description: "Get storage total, used, and available in GB", parameters: {} },

      // Terminal
      { name: "run_command", description: "Run a shell command (bash). Classifies as auto/confirm/never before execution. Destructive commands (rm -rf, sudo, git push --force) are blocked automatically.", parameters: { command: { type: "string", description: "The bash command to execute" }, cwd: { type: "string", description: "Working directory (defaults to project root)" }, timeout: { type: "number", description: "Timeout in ms (default 30000, max 300000)" } } },
      { name: "classify_command", description: "Check whether a command would be auto-approved, require confirmation, or be blocked. Does NOT execute it.", parameters: { command: { type: "string", description: "The command to classify" } } },

      // Background tasks (proactive completion reporting)
      { name: "run_background", description: "Start a long-running shell command in the background. Returns a job id immediately — JARVIS proactively reports the real exit code and output when it finishes. Confirm-tier.", parameters: { command: { type: "string", description: "The bash command to run" }, cwd: { type: "string", description: "Working directory (defaults to project root)" }, label: { type: "string", description: "Human-readable name used when reporting completion" } } },
      { name: "get_job", description: "Check a background job's status, exit code, and captured output", parameters: { jobId: { type: "string", description: "Job id returned by run_background" } } },
      { name: "list_jobs", description: "List all tracked background jobs", parameters: {} },
      { name: "notify", description: "Show a macOS notification banner immediately", parameters: { message: { type: "string", description: "Notification text" }, title: { type: "string", description: "Notification title (default JARVIS)" } } },

      // GitHub (read-only = auto, write = confirm, destructive = confirm+diff)
      { name: "gh_list_repos", description: "List repositories for a user or the authenticated user", parameters: { owner: { type: "string" }, type: { type: "string" }, sort: { type: "string" }, per_page: { type: "number" } } },
      { name: "gh_get_file", description: "Read a file's contents from a GitHub repo", parameters: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" } } },
      { name: "gh_list_issues", description: "List issues in a repo", parameters: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" }, per_page: { type: "number" } } },
      { name: "gh_list_prs", description: "List pull requests in a repo", parameters: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" }, per_page: { type: "number" } } },
      { name: "gh_list_runs", description: "List recent GitHub Actions workflow runs", parameters: { owner: { type: "string" }, repo: { type: "string" }, per_page: { type: "number" } } },
      { name: "gh_run_logs", description: "Get logs for a specific workflow run", parameters: { owner: { type: "string" }, repo: { type: "string" }, run_id: { type: "number" } } },
      { name: "gh_get_diff", description: "Get the diff between two branches or commits", parameters: { owner: { type: "string" }, repo: { type: "string" }, base: { type: "string" }, head: { type: "string" } } },
      { name: "gh_create_branch", description: "Create a new branch from a source branch", parameters: { owner: { type: "string" }, repo: { type: "string" }, branch: { type: "string" }, from: { type: "string" } } },
      { name: "gh_create_file", description: "Create or update a file in a repo (commits the change)", parameters: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, message: { type: "string" }, content: { type: "string" }, branch: { type: "string" } } },
      { name: "gh_create_issue", description: "Create a new issue in a repo", parameters: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, labels: { type: "array" } } },
      { name: "gh_create_pr", description: "Create a pull request", parameters: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, head: { type: "string" }, base: { type: "string" } } },
      { name: "gh_create_comment", description: "Add a comment to an issue or PR", parameters: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" }, body: { type: "string" } } },
      // Browser automation
      { name: "browser_navigate", description: "Navigate to a URL in a headless browser. Returns page title and final URL.", parameters: { url: { type: "string", description: "URL to navigate to" }, waitFor: { type: "number", description: "Timeout in ms (default 5000)" } } },
      { name: "browser_extract", description: "Extract readable text content from a web page. Removes navigation, scripts, styles.", parameters: { url: { type: "string", description: "URL to extract from (uses current page if omitted)" } } },
      { name: "browser_screenshot", description: "Take a screenshot of the current browser page.", parameters: { path: { type: "string", description: "Output file path (auto-generated if omitted)" }, fullPage: { type: "boolean", description: "Capture full scrollable page" } } },
      { name: "browser_click", description: "Click an element by CSS selector. Confirm-tier: shows what will be clicked.", parameters: { selector: { type: "string", description: "CSS selector for the element to click" }, timeout: { type: "number", description: "Timeout in ms (default 5000)" } } },
      { name: "browser_type", description: "Type text into an input field. Confirm-tier: shows target field and content.", parameters: { selector: { type: "string", description: "CSS selector for the input element" }, text: { type: "string", description: "Text to type" }, clear: { type: "boolean", description: "Clear field first (default true)" }, pressEnter: { type: "boolean", description: "Press Enter after typing" } } },
      { name: "browser_fill_form", description: "Fill multiple form fields at once. Confirm-tier: shows all fields before submission.", parameters: { fields: { type: "array", description: "Array of {selector, value} pairs" }, submitSelector: { type: "string", description: "CSS selector for submit button (optional)" } } },
      { name: "browser_download", description: "Download a file from a URL. Confirm-tier: shows URL and destination.", parameters: { url: { type: "string", description: "URL to download" }, destination: { type: "string", description: "Local path to save to" } } },
      { name: "browser_close", description: "Close the browser and release resources.", parameters: {} },
    ],
    enabled: true,
  },

  // ── Gmail (read-only: gmail.readonly scope) ──
  {
    name: "gmail",
    url: "server-side",
    tools: [
      { name: "gmail_search", description: "Search Gmail messages by query. Returns subject, from, date, snippet.", parameters: { query: { type: "string", description: "Gmail search query (same syntax as Gmail search bar)" }, maxResults: { type: "number", description: "Max results (default 10)" } } },
      { name: "gmail_read", description: "Read a specific email by message ID. Returns full subject, from, to, date, and body.", parameters: { messageId: { type: "string", description: "Gmail message ID" } } },
      { name: "gmail_list_recent", description: "List recent emails from inbox. Optionally filter by query.", parameters: { maxResults: { type: "number", description: "Max results (default 10)" }, query: { type: "string", description: "Optional Gmail query filter" } } },
    ],
    enabled: true,
  },

  // ── Google Calendar (read-only: calendar.readonly scope) ──
  {
    name: "google-calendar",
    url: "server-side",
    tools: [
      { name: "calendar_list_events", description: "List calendar events for a time range. Defaults to today.", parameters: { timeMin: { type: "string", description: "ISO 8601 start time (default: today midnight)" }, timeMax: { type: "string", description: "ISO 8601 end time (default: tomorrow midnight)" }, maxResults: { type: "number", description: "Max events (default 20)" } } },
      { name: "calendar_search_events", description: "Search calendar events by text query.", parameters: { query: { type: "string", description: "Search text" }, timeMin: { type: "string" }, timeMax: { type: "string" } } },
    ],
    enabled: true,
  },

  // ── Proactive JARVIS (server-side: schedules/initiatives live in Supabase) ──
  {
    name: "proactive",
    url: "server-side",
    tools: [
      { name: "schedule_reminder", description: "Schedule a proactive message from JARVIS (one-time or daily recurring). Delivered in-chat, by voice, and as a macOS banner at the fire time.", parameters: { message: { type: "string", description: "What JARVIS should say when it fires" }, fireAt: { type: "string", description: "ISO 8601 time to fire (mutually exclusive with delayMinutes)" }, delayMinutes: { type: "number", description: "Minutes from now to fire" }, recurring: { type: "string", description: "\"daily\" to repeat every day at this time" } } },
      { name: "cancel_reminder", description: "Cancel a scheduled proactive message by id", parameters: { id: { type: "string", description: "Schedule id (from schedule_reminder or list_reminders)" } } },
      { name: "set_checkin_time", description: "Change the daily check-in time (default 09:00). The user can change this by voice at any time.", parameters: { time: { type: "string", description: "24h local time as HH:MM (e.g. \"09:00\")" } } },
      { name: "list_reminders", description: "List all active scheduled proactive messages", parameters: {} },
    ],
    enabled: true,
  },

  // ── Notion ──
  {
    name: "notion",
    url: "server-side",
    tools: [
      { name: "notion_search", description: "Search across all Notion pages/databases shared with the JARVIS integration.", parameters: { query: { type: "string", description: "Search query" }, pageSize: { type: "number", description: "Max results (default 10)" } } },
      { name: "notion_read_page", description: "Read a Notion page's content as text.", parameters: { pageId: { type: "string", description: "Notion page ID" } } },
      { name: "notion_query_database", description: "Query a Notion database with optional filters.", parameters: { databaseId: { type: "string", description: "Database ID" }, filter: { type: "object", description: "Optional Notion filter object" }, pageSize: { type: "number" } } },
      { name: "notion_create_page", description: "Create a new page in a Notion database or as child of a page. Confirm-tier.", parameters: { parent: { type: "object", description: "{ database_id } or { page_id }" }, properties: { type: "object", description: "Page properties" }, children: { type: "array", description: "Optional initial content blocks" } } },
      { name: "notion_update_page", description: "Update an existing Notion page's properties. Confirm-tier.", parameters: { pageId: { type: "string" }, properties: { type: "object", description: "Properties to update" } } },
      { name: "notion_archive_page", description: "Archive (soft-delete) a Notion page. Confirm-tier. Recoverable via Notion UI.", parameters: { pageId: { type: "string" } } },
    ],
    enabled: true,
  },
];

/** Get all enabled tools across all connected MCP servers */
export function getEnabledTools(): MCPTool[] {
  return MCP_REGISTRY.filter((s) => s.enabled).flatMap((s) => s.tools);
}

/**
 * Server-side tool dispatch for tools whose MCP server has `url: "server-side"`.
 *
 * Gmail / Calendar / Notion tools run inside this app's own server process
 * (they need OAuth tokens from the DB), so there is no HTTP endpoint to call.
 * Dynamic imports keep this out of the client bundle and avoid cycles.
 */
const SERVER_DISPATCH: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  // Gmail (read-only scope)
  gmail_search: async (a) => {
    const { gmailSearch } = await import("../../functions/gmail");
    return gmailSearch(a as { query: string; maxResults?: number });
  },
  gmail_read: async (a) => {
    const { gmailRead } = await import("../../functions/gmail");
    return gmailRead(a as { messageId: string });
  },
  gmail_list_recent: async (a) => {
    const { gmailListRecent } = await import("../../functions/gmail");
    return gmailListRecent(a as { maxResults?: number; query?: string });
  },

  // Google Calendar
  calendar_list_events: async (a) => {
    const { calendarListEvents } = await import("../../functions/google-calendar");
    return calendarListEvents(
      a as { timeMin?: string; timeMax?: string; maxResults?: number }
    );
  },
  calendar_search_events: async (a) => {
    const { calendarSearchEvents } = await import("../../functions/google-calendar");
    return calendarSearchEvents(
      a as { query: string; timeMin?: string; timeMax?: string }
    );
  },

  // Notion
  notion_search: async (a) => {
    const { notionSearch } = await import("../../functions/notion");
    return notionSearch(a as { query: string; pageSize?: number });
  },
  notion_read_page: async (a) => {
    const { notionReadPage } = await import("../../functions/notion");
    return notionReadPage(a as { pageId: string });
  },
  notion_query_database: async (a) => {
    const { notionQueryDatabase } = await import("../../functions/notion");
    return notionQueryDatabase(
      a as { databaseId: string; filter?: Record<string, unknown>; pageSize?: number }
    );
  },
  notion_create_page: async (a) => {
    const { notionCreatePage } = await import("../../functions/notion");
    return notionCreatePage(
      a as {
        parent: Record<string, string>;
        properties: Record<string, unknown>;
        children?: Array<Record<string, unknown>>;
      }
    );
  },
  notion_update_page: async (a) => {
    const { notionUpdatePage } = await import("../../functions/notion");
    return notionUpdatePage(
      a as { pageId: string; properties: Record<string, unknown> }
    );
  },
  notion_archive_page: async (a) => {
    const { notionArchivePage } = await import("../../functions/notion");
    return notionArchivePage(a as { pageId: string });
  },

  // Proactive scheduling
  schedule_reminder: async (a) => {
    const { scheduleReminder } = await import("../../functions/proactive");
    return scheduleReminder(
      a as {
        message: string;
        fireAt?: string;
        delayMinutes?: number;
        recurring?: string;
      }
    );
  },
  cancel_reminder: async (a) => {
    const { cancelReminder } = await import("../../functions/proactive");
    return cancelReminder(a as { id: string });
  },
  set_checkin_time: async (a) => {
    const { setCheckinTime } = await import("../../functions/proactive");
    return setCheckinTime(a as { time: string });
  },
  list_reminders: async () => {
    const { listReminders } = await import("../../functions/proactive");
    return listReminders();
  },
};

/** Route a tool call to the appropriate MCP server */
export async function routeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  for (const server of MCP_REGISTRY) {
    if (!server.enabled) continue;
    const tool = server.tools.find((t) => t.name === toolName);
    if (tool) {
      // Server-side tools run in-process (Gmail/Calendar/Notion need OAuth
      // tokens from the DB — there is no HTTP endpoint to hit).
      if (server.url === "server-side") {
        const handler = SERVER_DISPATCH[toolName];
        if (!handler) {
          throw new Error(
            `No server-side handler registered for tool: ${toolName}`
          );
        }
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return handler(args);
      }

      // Get the shared secret from the local agent
      let authHeader = "";
      try {
        // This runs server-side only (Nitro), so Node.js fs is available
        const fs = await import("fs");
        const path = await import("path");
        const secretFile = fs.readFileSync(
          path.join(process.cwd(), "local-agent", ".agent-secret"),
          "utf-8"
        ).trim();
        authHeader = `Bearer ${secretFile}`;
      } catch {
        // Secret file not found — request will fail with 401
      }

      const fetchOpts: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify({ tool: toolName, args }),
      };
      if (signal) fetchOpts.signal = signal;

      const res = await fetch(`${server.url}/call`, fetchOpts);
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Local agent error (${res.status}): ${errBody}`);
      }
      return res.json();
    }
  }
  throw new Error(`No MCP server found for tool: ${toolName}`);
}
