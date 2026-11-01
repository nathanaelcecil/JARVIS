/**
 * Desktop control tools — open/quit/list macOS applications.
 *
 * Everything here runs with an argv array and NO shell. `open -a` and
 * `osascript` are invoked with execFileSync, so an app name can never be
 * interpreted as shell syntax. The app name is additionally restricted to a
 * name or bundle id, or a `.app` bundle inside the standard Applications
 * folders — `open` must never be able to launch an arbitrary executable path.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { validateAppName } from "../validate";

const ALLOWED_APP_ROOTS = [
  "/Applications",
  "/System/Applications",
  join(homedir(), "Applications"),
];

function withinAllowedRoot(candidate: string): boolean {
  return ALLOWED_APP_ROOTS.some(
    (root) => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep),
  );
}

/**
 * Resolve an app name / bundle id / .app path to a value safe to hand to
 * `open -a`. Paths are resolved and required to be a real .app bundle inside
 * one of the standard Applications directories.
 */
export function resolveAppTarget(
  raw: string,
): { ok: true; target: string } | { ok: false; message: string } {
  const nameCheck = validateAppName(raw);
  if (!nameCheck.ok) return { ok: false, message: nameCheck.message };

  if (!raw.includes("/")) return { ok: true, target: raw };

  // Path-like: only an existing .app bundle inside an allowed root.
  if (!raw.endsWith(".app")) {
    return { ok: false, message: "path-like app values must point at a .app bundle" };
  }
  const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
  const absolute = resolve(expanded);
  let real: string;
  try {
    if (!existsSync(absolute)) {
      return { ok: false, message: "app bundle not found" };
    }
    real = realpathSync(absolute);
    if (!statSync(real).isDirectory()) {
      return { ok: false, message: "app bundle is not a directory" };
    }
  } catch {
    return { ok: false, message: "app bundle could not be resolved" };
  }
  if (!withinAllowedRoot(real)) {
    return {
      ok: false,
      message: "app bundle must live in /Applications, /System/Applications, or ~/Applications",
    };
  }
  return { ok: true, target: real };
}

/** Open a macOS application by name or bundle ID */
export function openApp(args: { name: string }): {
  success: boolean;
  app: string;
  error?: string;
} {
  const target = resolveAppTarget(args.name);
  if (!target.ok) {
    return { success: false, app: args.name, error: `Refused to open app: ${target.message}` };
  }
  try {
    execFileSync("open", ["-a", target.target], { timeout: 10000, stdio: "pipe" });
    return { success: true, app: args.name };
  } catch (err) {
    return {
      success: false,
      app: args.name,
      error: `Cannot open "${args.name}": ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Quit a macOS application by name */
export function quitApp(args: { name: string }): {
  success: boolean;
  app: string;
  error?: string;
} {
  const target = resolveAppTarget(args.name);
  if (!target.ok) {
    return { success: false, app: args.name, error: `Refused to quit app: ${target.message}` };
  }
  try {
    // The app name is passed as argv, never interpolated into the script text.
    execFileSync(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        "tell application (item 1 of argv) to quit",
        "-e",
        "end run",
        target.target,
      ],
      { timeout: 10000, stdio: "pipe" },
    );
    return { success: true, app: args.name };
  } catch (err) {
    return {
      success: false,
      app: args.name,
      error: `Cannot quit "${args.name}": ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** System process names to exclude from the running apps list */
const SYSTEM_PROCESSES = new Set([
  "kernel_task",
  "launchd",
  "WindowServer",
  "loginwindow",
  "SystemUIServer",
  "Dock",
  "Finder",
  "Siri",
  "Spotlight",
  "ControlCenter",
  "NotificationCenter",
  // Background helpers
  "helpers",
  "agent",
  "daemon",
  "service",
  "extension",
  "XProtect",
  "XProtectPluginService",
  "XProtectBridgeService",
  "SafariLaunchAgent",
  "SafariNotificationAgent",
  "SafariBookmarksSyncAgent",
  "comle.Safari.BrowserDataImportingService",
  "comle.Safari.SandboxBroker",
  "comle.Safari.History",
  "comle.Safari.SafeBrowsing.Service",
  // System daemons
  "backupd",
  "cloudd",
  "syncdefaultsd",
  "amsaccountsd",
  "amsengagementd",
  "apsd",
  "assetscacheagent",
]);

const LIST_APPS_SCRIPT =
  'tell application "System Events" to get name of every process whose background only is false';

/** List currently running GUI applications (filtered to user-visible apps only) */
export function listRunningApps(): {
  success: boolean;
  apps: Array<{ name: string }>;
  error?: string;
} {
  try {
    const output = execFileSync("osascript", ["-e", LIST_APPS_SCRIPT], {
      timeout: 10000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!output) return { success: true, apps: [] };

    const names = output.split(", ").map((n) => n.trim());
    const apps = names.filter((name) => !SYSTEM_PROCESSES.has(name)).map((name) => ({ name }));

    return { success: true, apps };
  } catch (err) {
    return {
      success: false,
      apps: [],
      error: `Cannot list running apps: ${err instanceof Error ? err.message : err}`,
    };
  }
}
