/**
 * Canonical permission tiers for tools that cross the local-agent boundary.
 *
 * Pure data, no imports, so it can be read by the TanStack server, the coding
 * agent, and `local-agent/server.ts` under both Bun and vitest without pulling
 * in either app's dependency graph. `guardrails.ts` remains the authority for
 * the chat/agent decision path; a test asserts the two tables agree for every
 * tool listed here (see src/lib/tool-tiers.test.ts).
 *
 * A tool that is absent from this table is treated as `confirm` by the local
 * agent — unknown never means auto.
 */

export type ToolTier = "auto" | "confirm" | "never";

export const TOOL_TIERS: Record<string, ToolTier> = {
  // Filesystem — reads are auto; opening a path is confirm.
  list_directory: "auto",
  search_files: "auto",
  get_file_metadata: "auto",
  open_in_finder: "confirm",

  // Desktop
  list_running_apps: "auto",
  open_app: "confirm",
  quit_app: "confirm",

  // Hands v1 — read-only screen observation. Nothing here can act on the
  // computer: the helper has no click/type/key/menu capability, so these are
  // auto-tier observations.
  hands_list_windows: "auto",
  hands_read_window: "auto",
  hands_read_focused: "auto",
  hands_status: "auto",
  hands_look: "auto",
  hands_read_screen: "auto",
  hands_crop: "auto",

  // Answers in the chat UI, never touches the Mac: the card IS the approval.
  ask_user: "auto",

  // Hands v2 — computer CONTROL. These act on the user's Mac, so every one is
  // confirm-tier: the bearer secret alone is not enough, a call needs an
  // approval token minted after a real approval. `control_map` and
  // `control_status` only read (addressable controls, permission state) and are
  // auto-tier like the other observation tools.
  control_map: "auto",
  control_wait: "auto",
  control_scroll_to: "confirm",
  open_settings: "confirm",
  control_status: "auto",
  control_click: "confirm",
  control_type: "confirm",
  control_key: "confirm",
  control_scroll: "confirm",
  control_drag: "confirm",
  control_menu: "confirm",
  control_place: "confirm",
  control_focus: "confirm",

  // macOS integrations — reading files/contacts is auto; changing playback is
  // a state change the user hears, so it asks.
  spotlight_search: "auto",
  contacts_search: "auto",
  spotify_status: "auto",
  spotify_control: "confirm",

  // System — reads auto, volume writes confirm.
  get_volume: "auto",
  get_brightness: "auto",
  get_battery: "auto",
  get_ram: "auto",
  get_storage: "auto",
  set_volume: "confirm",

  // Terminal. run_command is always confirm at this boundary regardless of the
  // regex classifier: the classifier is a tripwire, not an authorization.
  run_command: "confirm",
  classify_command: "auto",
  run_background: "confirm",
  get_job: "auto",
  list_jobs: "auto",
  notify: "auto",

  // GitHub — reads auto, writes confirm.
  gh_list_repos: "auto",
  gh_get_file: "auto",
  gh_list_issues: "auto",
  gh_list_prs: "auto",
  gh_list_runs: "auto",
  gh_run_logs: "auto",
  gh_get_diff: "auto",
  gh_create_branch: "confirm",
  gh_create_file: "confirm",
  gh_create_issue: "confirm",
  gh_create_pr: "confirm",
  gh_create_comment: "confirm",

  // Automation (server-side; listed here so both permission tables agree).
  routine_add: "confirm",
  routine_list: "auto",
  routine_remove: "confirm",
  watch_add: "confirm",
  watch_list: "auto",
  watch_remove: "confirm",
  history_search: "auto",
  profile_get: "auto",
  profile_set: "confirm",
  profile_forget: "confirm",
  procedure_learn: "confirm",
  procedure_list: "auto",
  procedure_forget: "confirm",

  // Browser — navigation/read auto, interaction confirm.
  browser_navigate: "auto",
  browser_extract: "auto",
  browser_screenshot: "auto",
  browser_close: "auto",
  browser_click: "confirm",
  browser_type: "confirm",
  browser_fill_form: "confirm",
  browser_download: "confirm",
};

/** Tier for a tool name; unknown tools default to confirm. */
export function tierForTool(tool: string): ToolTier {
  return TOOL_TIERS[tool] ?? "confirm";
}
