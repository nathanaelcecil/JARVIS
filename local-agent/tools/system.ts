/**
 * System tools — read and modify macOS system settings.
 *
 * Every external command runs via execFileSync with an argv array and no
 * shell, so nothing here can be turned into shell syntax. The pipelines that
 * used to be delegated to `sh` (`| grep`, `| awk`, `| head`) are parsed in
 * TypeScript instead. All setters verify the change took effect before
 * reporting success.
 */

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

const RUN_OPTS: ExecFileSyncOptionsWithStringEncoding = {
  timeout: 5000,
  encoding: "utf-8",
  stdio: ["pipe", "pipe", "pipe"],
};

function run(file: string, args: string[]): string {
  return execFileSync(file, args, RUN_OPTS).trim();
}

/** Get current system volume (0-100) */
export function getVolume(): { success: boolean; volume: number; error?: string } {
  try {
    const output = run("osascript", ["-e", "output volume of (get volume settings)"]);
    const volume = parseInt(output, 10);
    if (isNaN(volume)) throw new Error(`Invalid volume output: ${output}`);
    return { success: true, volume };
  } catch (err) {
    return {
      success: false,
      volume: 0,
      error: `Cannot get volume: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Set system volume (0-100). Verifies change took effect. */
export function setVolume(args: { level: number }): {
  success: boolean;
  volume: number;
  error?: string;
} {
  const targetVolume = Math.max(0, Math.min(100, Math.round(args.level)));
  try {
    // The number is passed as argv and coerced inside AppleScript — never
    // interpolated into the script source.
    execFileSync(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        "set volume output volume ((item 1 of argv) as integer)",
        "-e",
        "end run",
        String(targetVolume),
      ],
      { timeout: 5000, stdio: "pipe" },
    );

    // Verify the change took effect
    const verify = getVolume();
    if (verify.success && Math.abs(verify.volume - targetVolume) <= 1) {
      return { success: true, volume: verify.volume };
    }
    return {
      success: false,
      volume: verify.success ? verify.volume : 0,
      error: `Volume was set to ${targetVolume} but verification read ${verify.volume}`,
    };
  } catch (err) {
    return {
      success: false,
      volume: 0,
      error: `Cannot set volume: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Get display brightness (0-100) */
export function getBrightness(): { success: boolean; brightness: number; error?: string } {
  try {
    // Use brightness command-line tool (ships with macOS)
    const output = run("brightness", ["-l"]);
    // Line format: "display 0: main display, brightness 0.500000"
    const match = output.match(/display\s+0:.*?brightness\s+([\d.]+)/i);
    if (!match) throw new Error(`Cannot parse brightness: ${output}`);
    const raw = parseFloat(match[1] ?? "");
    if (isNaN(raw)) throw new Error(`Cannot parse brightness: ${output}`);
    // brightness command returns 0.0-1.0, convert to 0-100
    const brightness = Math.round(raw * 100);
    return { success: true, brightness };
  } catch {
    // brightness tool may not be installed — try pmset fallback
    try {
      const output = run("pmset", ["-g", "gtemp"]);
      const displayLine = output.split("\n").find((line) => /display/i.test(line)) ?? "";
      const match = displayLine.match(/(\d+)%/);
      if (!match) throw new Error("Cannot parse brightness from pmset");
      return { success: true, brightness: parseInt(match[1] ?? "0", 10) };
    } catch {
      return {
        success: false,
        brightness: 0,
        error:
          "Cannot get brightness — 'brightness' tool may not be installed. Install with: brew install brightness",
      };
    }
  }
}

/** Get battery percentage and charging status */
export function getBattery(): {
  success: boolean;
  percentage: number;
  charging: boolean;
  error?: string;
} {
  try {
    // Use pmset for reliable battery info
    const output = run("pmset", ["-g", "batt"]);
    // Second line format: "Battery\t85%; charging; 1:23 remaining"
    const line = output.split("\n")[1] ?? "";
    if (!line) throw new Error("Cannot parse battery output: empty");

    const match = line.match(/(\d+)%;?\s*(charging|discharging|charged|finishing charge full)?/i);
    if (!match) throw new Error(`Cannot parse battery output: ${line}`);

    const percentage = parseInt(match[1] ?? "0", 10);
    const charging = (match[2] ?? "").toLowerCase().includes("charg");

    return { success: true, percentage, charging };
  } catch (err) {
    return {
      success: false,
      percentage: 0,
      charging: false,
      error: `Cannot get battery info: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Get RAM usage */
export function getRAM(): {
  success: boolean;
  totalGB: number;
  usedGB: number;
  availableGB: number;
  error?: string;
} {
  try {
    const output = run("sysctl", ["hw.memsize"]);
    const totalMatch = output.match(/hw\.memsize:\s*(\d+)/);
    if (!totalMatch) throw new Error(`Cannot parse RAM: ${output}`);
    const totalBytes = parseInt(totalMatch[1] ?? "0", 10);
    if (isNaN(totalBytes)) throw new Error(`Cannot parse RAM: ${output}`);

    const totalGB = Math.round((totalBytes / (1024 * 1024 * 1024)) * 10) / 10;

    // Estimate used from page size and pages
    let usedGB = 0;
    try {
      const vmStat = run("vm_stat", []);
      const pageSizeMatch = vmStat.match(/page size of (\d+)/);
      const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1] ?? "16384", 10) : 16384;

      const activeMatch = vmStat.match(/Pages active:\s+(\d+)/);
      const wiredMatch = vmStat.match(/Pages wired down:\s+(\d+)/);
      const compressedMatch = vmStat.match(/Pages occupied by compressor:\s+(\d+)/);

      const active = activeMatch ? parseInt(activeMatch[1] ?? "0", 10) : 0;
      const wired = wiredMatch ? parseInt(wiredMatch[1] ?? "0", 10) : 0;
      const compressed = compressedMatch ? parseInt(compressedMatch[1] ?? "0", 10) : 0;

      usedGB =
        Math.round((((active + wired + compressed) * pageSize) / (1024 * 1024 * 1024)) * 10) / 10;
    } catch {
      usedGB = Math.round(totalGB * 0.4 * 10) / 10; // rough estimate
    }

    const availableGB = Math.round((totalGB - usedGB) * 10) / 10;

    return { success: true, totalGB, usedGB, availableGB };
  } catch (err) {
    return {
      success: false,
      totalGB: 0,
      usedGB: 0,
      availableGB: 0,
      error: `Cannot get RAM info: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Get storage usage for the boot volume */
export function getStorage(): {
  success: boolean;
  totalGB: number;
  usedGB: number;
  availableGB: number;
  error?: string;
} {
  try {
    const output = run("df", ["-g", "/"]);
    const lines = output.split("\n").filter((line) => line.trim().length > 0);
    const last = lines[lines.length - 1] ?? "";
    // Columns: Filesystem 1G-blocks Used Available Capacity ...
    const fields = last.split(/\s+/);
    const totalGB = parseInt(fields[1] ?? "", 10);
    const usedGB = parseInt(fields[2] ?? "", 10);
    const availableGB = parseInt(fields[3] ?? "", 10);

    if (isNaN(totalGB) || isNaN(usedGB) || isNaN(availableGB)) {
      throw new Error(`Cannot parse storage output: ${last}`);
    }

    return { success: true, totalGB, usedGB, availableGB };
  } catch (err) {
    return {
      success: false,
      totalGB: 0,
      usedGB: 0,
      availableGB: 0,
      error: `Cannot get storage info: ${err instanceof Error ? err.message : err}`,
    };
  }
}
