/**
 * One automation tick — called from the existing 15 s proactive scheduler.
 *
 * Ordering matters: routines are claimed and queued first (the UI drains them),
 * then watches are polled. Both are cheap when nothing is due: a routine tick is
 * one small JSON read, and a watch tick is one window list at most.
 *
 * Failures are contained per item. A broken watch or an unbuilt helper must not
 * stop the tick, because the same tick also delivers reminders and check-ins.
 */

import { execFile } from "node:child_process";

import { dueRoutines, enqueueOutbox } from "./routines";
import { pollWatches, runWatchCommand, type Observation, type Watch } from "./watches";

export interface AutomationTickResult {
  routines: number;
  watches: number;
}

/** macOS banner. Best effort: never throws, never blocks the tick. */
function notify(message: string): void {
  try {
    const safe = message
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\r\n]+/g, " ")
      .slice(0, 200);
    execFile(
      "osascript",
      ["-e", `display notification "${safe}" with title "JARVIS" sound name "Glass"`],
      { timeout: 5000 },
      () => undefined,
    );
  } catch {
    // A missing notification daemon is not an error worth reporting.
  }
}

/** Read the Mac's on-screen windows through the read-only helper. */
async function observeWindows(): Promise<{ app: string; title: string }[]> {
  try {
    const { handsListWindows } = await import("../../../local-agent/tools/hands");
    const result = (await handsListWindows()) as Record<string, unknown>;
    if (result["ok"] !== true || !Array.isArray(result["windows"])) return [];
    const windows: { app: string; title: string }[] = [];
    for (const entry of result["windows"] as Array<Record<string, unknown>>) {
      const app = typeof entry["app"] === "string" ? entry["app"] : "";
      const title = typeof entry["title"] === "string" ? entry["title"] : "";
      if (app || title) windows.push({ app, title });
    }
    return windows;
  } catch {
    return [];
  }
}

async function observe(watch: Watch): Promise<Observation> {
  if (watch.spec.kind === "command") {
    return { kind: "command", exitCode: await runWatchCommand(watch.spec.command) };
  }
  return { kind: "window", windows: await observeWindows() };
}

/**
 * Run one automation pass. Returns how many routines and watches fired.
 * Safe to call when automation is unused: it then does one tiny file read.
 */
export async function runAutomationTick(
  root: string = process.cwd(),
  now: Date = new Date(),
): Promise<AutomationTickResult> {
  let routines = 0;
  let watches = 0;

  try {
    const claimed = await dueRoutines(root, now);
    if (claimed.length > 0) {
      await enqueueOutbox(root, claimed, now.getTime());
      for (const routine of claimed) {
        notify(`${routine.label} — ${routine.prompt}`.slice(0, 180));
      }
      routines = claimed.length;
    }
  } catch (err) {
    console.error("[Automation] routines failed:", err);
  }

  try {
    const fired = await pollWatches(root, observe, now);
    if (fired.length > 0) {
      // A watch can carry a follow-up request. It goes through the same outbox
      // as a routine, so the UI runs it as a normal turn; a watch without one
      // is just a banner.
      const prompts = fired
        .filter((watch) => (watch.then ?? "").trim().length > 0)
        .map((watch) => ({
          id: `watch:${watch.id}`,
          label: watch.then!.trim().slice(0, 60),
          prompt: watch.then!.trim(),
        }));
      await enqueueOutbox(root, prompts, now.getTime());
      for (const watch of fired) {
        notify(`Watch: ${watch.then?.trim() || "something you were waiting for"}`.slice(0, 180));
      }
    }
    watches = fired.length;
  } catch (err) {
    console.error("[Automation] watches failed:", err);
  }

  return { routines, watches };
}
