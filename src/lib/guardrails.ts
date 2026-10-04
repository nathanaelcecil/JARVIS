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
  "terminal.run_command": "confirm",       // classified per-command; default confirm
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

  // External state modification: CONFIRM
  // Gmail — read-only (gmail.readonly scope)
  "gmail.gmail_search": "auto",
  "gmail.gmail_read": "auto",
  "gmail.gmail_list_recent": "auto",

  // Google Calendar — read-only (calendar.readonly scope)
  "calendar.calendar_list_events": "auto",
  "calendar.calendar_search_events": "auto",

  // Notion — read-only = auto, write = confirm
  "notion.notion_search": "auto",
  "notion.notion_read_page": "auto",
  "notion.notion_query_database": "auto",
  "notion.notion_create_page": "confirm",
  "notion.notion_update_page": "confirm",
  "notion.notion_archive_page": "confirm",

  // External state modification: CONFIRM
  "email.send": "confirm",
  "calendar.create": "confirm",
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
};

/** Check if a tool action is permitted */


// ── Trust Settings ──────────────────────────────────────────
// Tools promoted from confirm to auto via user trust.
// Never-tier tools CANNOT be promoted — hardcoded.
let trustedTools: Set<string> = new Set();

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

export function checkPermission(
  toolCategory: string
): { allowed: boolean; permission: Permission } {
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

/** Log a tool execution to the activity table */
export async function logActivity(params: {
  toolName: string;
  input: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  approvalStatus?: string;
}): Promise<void> {
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
