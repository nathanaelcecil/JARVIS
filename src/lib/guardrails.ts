/**
 * Guardrails: permissions, activity logging, kill switch.
 */

import { cancelAllTasks } from "./ai/task-registry";

export type Permission = "auto" | "confirm" | "never";

/** Per-tool-category permissions. Default: read-only = AUTO, modify = CONFIRM, destructive = NEVER */
const PERMISSIONS: Record<string, Permission> = {
  // Read-only: AUTO
  "memory.read": "auto",
  "messages.read": "auto",
  "chat.respond": "auto",
  "voice.speak": "auto",

  // Filesystem — read-only
  "filesystem.list_directory": "auto",
  "filesystem.search_files": "auto",
  "filesystem.get_metadata": "auto",
  // Filesystem — modifies user state (opens in Finder)
  "filesystem.open_in_finder": "confirm",

  // Desktop control — read-only
  "desktop.list_running_apps": "auto",
  // Desktop control — modifies user state
  "desktop.open_app": "confirm",
  "desktop.quit_app": "confirm",

  // Hands v1 — read-only observation of the screen. There is no mutating
  // hands tool to tier: the helper cannot click, type or activate anything.
  "hands.list_windows": "auto",
  "hands.read_window": "auto",
  "hands.read_focused": "auto",
  "hands.status": "auto",
  "hands.look": "auto",
  "hands.read_screen": "auto",

  // Hands v2 — computer control. Reading the control map or the permission
  // state changes nothing, so those are auto; every action that clicks, types,
  // presses keys, scrolls, drags, opens a menu, moves a window or raises an app
  // requires an explicit user approval.
  "control.map": "auto",
  "control.wait": "auto",
  "control.scroll_to": "confirm",
  "settings.open": "confirm",
  "control.status": "auto",
  "control.click": "confirm",
  "control.type": "confirm",
  "control.key": "confirm",
  "control.scroll": "confirm",
  "control.drag": "confirm",
  "control.menu": "confirm",
  "control.place": "confirm",
  "control.focus": "confirm",

  // macOS integrations
  "spotlight.search": "auto",
  "contacts.search": "auto",
  "history.search": "auto",
  "spotify.status": "auto",
  "spotify.play": "confirm",

  // System — read-only
  "system.get_volume": "auto",
  "system.get_brightness": "auto",
  "system.get_battery": "auto",
  "system.get_ram": "auto",
  "system.get_storage": "auto",
  // System — modifies user state
  "system.set_volume": "confirm",
  "system.set_brightness": "confirm",

  // Terminal — read-only (auto)
  "terminal.run_command": "confirm", // classified per-command; default confirm
  "terminal.classify_command": "auto",
  // Background tasks — start = confirm, status = auto
  "terminal.run_background": "confirm",
  "terminal.get_job": "auto",
  "terminal.list_jobs": "auto",

  // GitHub — read-only (auto)
  "github.list_repos": "auto",
  "github.get_file": "auto",
  "github.list_issues": "auto",
  "github.list_prs": "auto",
  "github.list_runs": "auto",
  "github.run_logs": "auto",
  "github.get_diff": "auto",
  // GitHub — write (confirm)
  "github.create_branch": "confirm",
  "github.create_file": "confirm",
  "github.create_issue": "confirm",
  "github.create_pr": "confirm",
  "github.create_comment": "confirm",

  // Automation — listing is a read; creating or deleting a routine/watch is a
  // durable change to how JARVIS behaves, so it needs an approval.
  "routine.add": "confirm",
  "routine.list": "auto",
  "routine.remove": "confirm",
  "watch.add": "confirm",
  "watch.list": "auto",
  "watch.remove": "confirm",
  "profile.get": "auto",
  "profile.set": "confirm",
  "profile.forget": "confirm",
  "procedure.learn": "confirm",
  "procedure.list": "auto",
  "procedure.forget": "confirm",

  // External state modification: CONFIRM
  // Gmail — reads auto, writes confirm
  "gmail.gmail_search": "auto",
  "gmail.gmail_read": "auto",
  "gmail.gmail_list_recent": "auto",
  "gmail.gmail_send_email": "confirm",
  "gmail.gmail_reply_email": "confirm",
  "gmail.gmail_forward_email": "confirm",

  // Google Calendar — reads auto, writes confirm
  "calendar.calendar_list_events": "auto",
  "calendar.calendar_search_events": "auto",
  "calendar.calendar_create_event": "confirm",
  "calendar.calendar_update_event": "confirm",
  "calendar.calendar_delete_event": "confirm",

  // Notion — read-only = auto, write = confirm
  "notion.notion_search": "auto",
  "notion.notion_read_page": "auto",
  "notion.notion_query_database": "auto",
  "notion.notion_create_page": "confirm",
  "notion.notion_append_blocks": "confirm",
  "notion.notion_update_page": "confirm",
  "notion.notion_archive_page": "confirm",

  // External state modification: CONFIRM
  "slack.post": "confirm",
  "notion.create": "confirm",
  "memory.write": "confirm",
  "behavior.write": "confirm",

  // Browser — read-only (auto)
  "browser.navigate": "auto",
  "browser.extract": "auto",
  "browser.screenshot": "auto",
  "browser.close": "auto",
  // Browser — modifies web state (confirm)
  "browser.click": "confirm",
  "browser.type": "confirm",
  "browser.fill_form": "confirm",
  "browser.download": "confirm",

  // Proactive JARVIS — scheduling only (writes a row, no external side effects)
  "proactive.schedule_reminder": "auto",
  "proactive.cancel_reminder": "auto",
  "proactive.set_checkin_time": "auto",
  "proactive.list_reminders": "auto",
  // Local agent notification (macOS banner — informational only)
  "notify.banner": "auto",

  // Destructive: NEVER
  "system.shutdown": "never",
  "system.factory_reset": "never",

  // ── Coding agent ──
  // Repository intelligence — read-only exploration
  "agent.overview": "auto",
  "agent.read_file": "auto",
  "agent.list_tree": "auto",
  "agent.search": "auto",
  "agent.find_symbol": "auto",
  "agent.git_status": "auto",
  "agent.git_diff": "auto",
  "agent.git_log": "auto",
  // Modify tier — recoverable edits with reviewable diffs
  "agent.write_file": "confirm",
  "agent.edit_file": "confirm",
  // Execute tier — allowlisted project scripts only (declared in package.json)
  "agent.run_script": "confirm",
  // Workspace-local memory: no external side effects, secret-screened at
  // write time, inspectable/correctable via /api/agent/memory → auto.
  "agent.remember": "auto",
  // Agent lifecycle / git specifics (chat-path tool)
  "agent.start": "auto",
  "agent.status": "auto",
  "git.commit": "confirm",
  "git.push": "confirm",
};

/**
 * Map a tool name to its permission category in PERMISSIONS above.
 * Shared by the chat stream (stream.ts) and the coding-agent engine so both
 * enforce identical tiers for identical tools.
 */
export function toolPermissionCategory(toolName: string): string {
  const map: Record<string, string> = {
    list_directory: "filesystem.list_directory",
    search_files: "filesystem.search_files",
    open_in_finder: "filesystem.open_in_finder",
    get_file_metadata: "filesystem.get_metadata",
    open_app: "desktop.open_app",
    quit_app: "desktop.quit_app",
    list_running_apps: "desktop.list_running_apps",
    hands_list_windows: "hands.list_windows",
    hands_read_window: "hands.read_window",
    hands_read_focused: "hands.read_focused",
    hands_status: "hands.status",
    hands_look: "hands.look",
    hands_read_screen: "hands.read_screen",
    control_map: "control.map",
    control_wait: "control.wait",
    control_scroll_to: "control.scroll_to",
    open_settings: "settings.open",
    control_status: "control.status",
    control_click: "control.click",
    control_type: "control.type",
    control_key: "control.key",
    control_scroll: "control.scroll",
    control_drag: "control.drag",
    control_menu: "control.menu",
    control_place: "control.place",
    control_focus: "control.focus",
    spotlight_search: "spotlight.search",
    contacts_search: "contacts.search",
    spotify_status: "spotify.status",
    spotify_control: "spotify.play",
    get_volume: "system.get_volume",
    set_volume: "system.set_volume",
    get_brightness: "system.get_brightness",
    get_battery: "system.get_battery",
    get_ram: "system.get_ram",
    get_storage: "system.get_storage",
    run_command: "terminal.run_command",
    classify_command: "terminal.classify_command",
    run_background: "terminal.run_background",
    get_job: "terminal.get_job",
    list_jobs: "terminal.list_jobs",
    gh_list_repos: "github.list_repos",
    gh_get_file: "github.get_file",
    gh_list_issues: "github.list_issues",
    gh_list_prs: "github.list_prs",
    gh_list_runs: "github.list_runs",
    gh_run_logs: "github.run_logs",
    gh_get_diff: "github.get_diff",
    gh_create_branch: "github.create_branch",
    gh_create_file: "github.create_file",
    gh_create_issue: "github.create_issue",
    gh_create_pr: "github.create_pr",
    gh_create_comment: "github.create_comment",
    routine_add: "routine.add",
    routine_list: "routine.list",
    routine_remove: "routine.remove",
    watch_add: "watch.add",
    watch_list: "watch.list",
    watch_remove: "watch.remove",
    history_search: "history.search",
    profile_get: "profile.get",
    profile_set: "profile.set",
    profile_forget: "profile.forget",
    procedure_learn: "procedure.learn",
    procedure_list: "procedure.list",
    procedure_forget: "procedure.forget",
    browser_navigate: "browser.navigate",
    browser_extract: "browser.extract",
    browser_screenshot: "browser.screenshot",
    browser_click: "browser.click",
    browser_type: "browser.type",
    browser_fill_form: "browser.fill_form",
    browser_download: "browser.download",
    // Gmail
    gmail_search: "gmail.gmail_search",
    gmail_read: "gmail.gmail_read",
    gmail_list_recent: "gmail.gmail_list_recent",
    gmail_send_email: "gmail.gmail_send_email",
    gmail_reply_email: "gmail.gmail_reply_email",
    gmail_forward_email: "gmail.gmail_forward_email",
    // Calendar
    calendar_list_events: "calendar.calendar_list_events",
    calendar_search_events: "calendar.calendar_search_events",
    calendar_create_event: "calendar.calendar_create_event",
    calendar_update_event: "calendar.calendar_update_event",
    calendar_delete_event: "calendar.calendar_delete_event",
    // Notion
    notion_search: "notion.notion_search",
    notion_read_page: "notion.notion_read_page",
    notion_query_database: "notion.notion_query_database",
    notion_create_page: "notion.notion_create_page",
    notion_append_blocks: "notion.notion_append_blocks",
    notion_update_page: "notion.notion_update_page",
    notion_archive_page: "notion.notion_archive_page",
    // Proactive JARVIS
    schedule_reminder: "proactive.schedule_reminder",
    cancel_reminder: "proactive.cancel_reminder",
    set_checkin_time: "proactive.set_checkin_time",
    list_reminders: "proactive.list_reminders",
    // Local agent notification
    notify: "notify.banner",
    // Coding agent — repository intelligence
    overview: "agent.overview",
    read_file: "agent.read_file",
    list_tree: "agent.list_tree",
    search: "agent.search",
    find_symbol: "agent.find_symbol",
    git_status: "agent.git_status",
    git_diff: "agent.git_diff",
    git_log: "agent.git_log",
    write_file: "agent.write_file",
    edit_file: "agent.edit_file",
    run_script: "agent.run_script",
    remember: "agent.remember",
    start_coding_agent: "agent.start",
    coding_task_status: "agent.status",
  };
  return map[toolName] ?? toolName;
}

/** Check if a tool action is permitted */

// ── Trust Settings ──────────────────────────────────────────
// Tools promoted from confirm to auto via user trust.
// Never-tier tools CANNOT be promoted — hardcoded.
const trustedTools: Set<string> = new Set();

/** Promote a tool from confirm to auto tier. Returns true if promotion succeeded. */
export function promoteTool(toolCategory: string): boolean {
  const currentPermission = PERMISSIONS[toolCategory];
  // Hard-exclude never tier and already-auto tools
  if (currentPermission === "never") {
    console.warn(`[Trust] Cannot promote ${toolCategory} — it is in the NEVER tier`);
    return false;
  }
  if (currentPermission === "auto") {
    return true; // Already auto
  }
  // Only confirm-tier tools can be promoted
  if (currentPermission !== "confirm") {
    console.warn(`[Trust] Cannot promote ${toolCategory} — unknown tier: ${currentPermission}`);
    return false;
  }
  trustedTools.add(toolCategory);
  console.log(`[Trust] Promoted ${toolCategory} from confirm → auto`);
  return true;
}

/** Demote a tool back to its default tier */
export function demoteTool(toolCategory: string): void {
  trustedTools.delete(toolCategory);
}

/** Check if a tool has been promoted via trust */
export function isTrusted(toolCategory: string): boolean {
  return trustedTools.has(toolCategory);
}

/** Get all currently trusted tools */
export function getTrustedTools(): string[] {
  return Array.from(trustedTools);
}

export function checkPermission(toolCategory: string): {
  allowed: boolean;
  permission: Permission;
} {
  // Check trust promotion first
  if (trustedTools.has(toolCategory)) {
    return { allowed: true, permission: "auto" };
  }
  const permission = PERMISSIONS[toolCategory] ?? "confirm";
  return {
    allowed: permission !== "never",
    permission,
  };
}

/** Kill switch state (in-memory, server-side) */
let killSwitchActive = false;

export function activateKillSwitch(): void {
  killSwitchActive = true;
  const cancelled = cancelAllTasks();
  console.log(`[KillSwitch] Activated — cancelled ${cancelled} running task(s)`);
}

export function resetKillSwitch(): void {
  killSwitchActive = false;
}

export function isKillSwitchActive(): boolean {
  return killSwitchActive;
}

/**
 * Activity logging is optional: it needs the Supabase server credentials.
 * Without them (tests, a first local run, a voice-only setup) it must be a
 * silent no-op — a missing analytics backend must never fail a tool call or
 * spam "supabaseKey is required" on every execution.
 */
export function activityLoggingConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env["VITE_SUPABASE_URL"] && env["SUPABASE_SERVICE_ROLE_KEY"]);
}

/** Log a tool execution to the activity table (no-op when unconfigured). */
export async function logActivity(params: {
  toolName: string;
  input: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  approvalStatus?: string;
}): Promise<void> {
  if (!activityLoggingConfigured()) return;
  try {
    const { supabaseAdmin } = await import("./supabase-server");
    await supabaseAdmin.from("activity_log").insert({
      tool_name: params.toolName,
      input: params.input,
      result: params.result,
      approval_status: params.approvalStatus ?? "auto",
    });
  } catch (err) {
    console.error("Failed to log activity:", err);
  }
}
