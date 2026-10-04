/**
 * Desktop control tools — open/quit/list macOS applications.
 * Uses `open -a` and `osascript` for proper API access, not raw AppleScript UI scripting.
 */

import { execSync } from "child_process";

/** Open a macOS application by name or bundle ID */
export function openApp(args: { name: string }): {
  success: boolean;
  app: string;
  error?: string;
} {
  try {
    // `open -a` handles both app names and bundle IDs
    execSync(`open -a "${args.name}"`, { timeout: 10000, stdio: "pipe" });
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
  try {
    // Use osascript to quit gracefully
    execSync(
      `osascript -e 'tell application "${args.name}" to quit'`,
      { timeout: 10000, stdio: "pipe" }
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
  "kernel_task", "launchd", "WindowServer", "loginwindow",
  "SystemUIServer", "Dock", "Finder", "Siri", "Spotlight",
  "ControlCenter", "NotificationCenter",
  // Background helpers
  "helpers", "agent", "daemon", "service", "extension",
  "XProtect", "XProtectPluginService", "XProtectBridgeService",
  "SafariLaunchAgent", "SafariNotificationAgent", "SafariBookmarksSyncAgent",
  "comle.Safari.BrowserDataImportingService", "comle.Safari.SandboxBroker",
  "comle.Safari.History", "comle.Safari.SafeBrowsing.Service",
  // System daemons
  "backupd", "cloudd", "syncdefaultsd", "amsaccountsd",
  "amsengagementd", "apsd", "assetscacheagent",
]);

/** List currently running GUI applications (filtered to user-visible apps only) */
export function listRunningApps(): {
  success: boolean;
  apps: Array<{ name: string } >;
  error?: string;
} {
  try {
    // Use osascript to get foreground apps — most reliable for GUI apps
    const output = execSync(
      `osascript -e 'tell application "System Events" to get name of every process whose background only is false'`,
      { timeout: 10000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    if (!output) return { success: true, apps: [] };

    const names = output.split(", ").map((n) => n.trim());
    const apps = names
      .filter((name) => !SYSTEM_PROCESSES.has(name))
      .map((name) => ({ name }));

    return { success: true, apps };
  } catch (err) {
    return {
      success: false,
      apps: [],
      error: `Cannot list running apps: ${err instanceof Error ? err.message : err}`,
    };
  }
}
