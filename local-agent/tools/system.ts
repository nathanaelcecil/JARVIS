/**
 * System tools — read and modify macOS system settings.
 * All setters verify the change took effect before reporting success.
 */

import { execSync } from "child_process";

/** Get current system volume (0-100) */
export function getVolume(): { success: boolean; volume: number; error?: string } {
  try {
    const output = execSync(
      `osascript -e 'output volume of (get volume settings)'`,
      { timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    const volume = parseInt(output, 10);
    if (isNaN(volume)) throw new Error(`Invalid volume output: ${output}`);
    return { success: true, volume };
  } catch (err) {
    return { success: false, volume: 0, error: `Cannot get volume: ${err instanceof Error ? err.message : err}` };
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
    execSync(`osascript -e 'set volume output volume ${targetVolume}'`, {
      timeout: 5000,
      stdio: "pipe",
    });

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
    return { success: false, volume: 0, error: `Cannot set volume: ${err instanceof Error ? err.message : err}` };
  }
}

/** Get display brightness (0-100) */
export function getBrightness(): { success: boolean; brightness: number; error?: string } {
  try {
    // Use brightness command-line tool (ships with macOS)
    const output = execSync(
      `brightness -l 2>&1 | grep "display 0" | awk '{print $2}'`,
      { timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    const raw = parseFloat(output);
    if (isNaN(raw)) throw new Error(`Cannot parse brightness: ${output}`);
    // brightness command returns 0.0-1.0, convert to 0-100
    const brightness = Math.round(raw * 100);
    return { success: true, brightness };
  } catch {
    // brightness tool may not be installed — try pmset fallback
    try {
      const output = execSync(
        `pmset -g gtemp | grep -i 'display' | awk '{print $2}' | tr -d '%'`,
        { timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      const brightness = parseInt(output, 10);
      if (isNaN(brightness)) throw new Error("Cannot parse brightness from pmset");
      return { success: true, brightness };
    } catch (err) {
      return {
        success: false,
        brightness: 0,
        error: "Cannot get brightness — 'brightness' tool may not be installed. Install with: brew install brightness",
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
    // Use pmset for reliable battery info on macOS
    const output = execSync(
      `pmset -g batt | head -2 | tail -1`,
      { timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    // Format: "Battery	85%; charging; 1:23 remaining"
    const match = output.match(/(\d+)%;?\s*(charging|discharging|charged|finishing charge full)?/i);
    if (!match) throw new Error(`Cannot parse battery output: ${output}`);

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
    const output = execSync(
      `sysctl hw.memsize | awk '{print $2}'`,
      { timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    const totalBytes = parseInt(output, 10);
    if (isNaN(totalBytes)) throw new Error(`Cannot parse RAM: ${output}`);

    // Get memory pressure info
    const memInfo = execSync(
      `memory_pressure 2>/dev/null | head -5 || vm_stat | head -5`,
      { timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );

    const totalGB = Math.round((totalBytes / (1024 * 1024 * 1024)) * 10) / 10;

    // Estimate used from page size and pages
    let usedGB = 0;
    try {
      const vmStat = execSync(`vm_stat | head -10`, {
        timeout: 3000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      });
      const pageSizeMatch = vmStat.match(/page size of (\d+)/);
      const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

      const activeMatch = vmStat.match(/Pages active:\s+(\d+)/);
      const wiredMatch = vmStat.match(/Pages wired down:\s+(\d+)/);
      const compressedMatch = vmStat.match(/Pages occupied by compressor:\s+(\d+)/);

      const active = activeMatch ? parseInt(activeMatch[1], 10) : 0;
      const wired = wiredMatch ? parseInt(wiredMatch[1], 10) : 0;
      const compressed = compressedMatch ? parseInt(compressedMatch[1], 10) : 0;

      usedGB = Math.round(((active + wired + compressed) * pageSize) / (1024 * 1024 * 1024) * 10) / 10;
    } catch {
      usedGB = Math.round(totalGB * 0.4 * 10) / 10; // rough estimate
    }

    const availableGB = Math.round((totalGB - usedGB) * 10) / 10;

    return { success: true, totalGB, usedGB, availableGB };
  } catch (err) {
    return { success: false, totalGB: 0, usedGB: 0, availableGB: 0, error: `Cannot get RAM info: ${err instanceof Error ? err.message : err}` };
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
    const output = execSync(
      `df -g / | tail -1 | awk '{print $2, $3, $4}'`,
      { timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    const [totalGB, usedGB, availableGB] = output.split(/\s+/).map((s) => parseInt(s, 10));

    if (isNaN(totalGB) || isNaN(usedGB) || isNaN(availableGB)) {
      throw new Error(`Cannot parse storage output: ${output}`);
    }

    return { success: true, totalGB, usedGB, availableGB };
  } catch (err) {
    return { success: false, totalGB: 0, usedGB: 0, availableGB: 0, error: `Cannot get storage info: ${err instanceof Error ? err.message : err}` };
  }
}
