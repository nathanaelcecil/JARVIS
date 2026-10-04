/**
 * Proactive JARVIS scheduler.
 *
 * A single server-side interval (15s) that:
 *  1. Finds due schedules (reminders, daily check-in, task-completion reports)
 *  2. Produces a proactive message for the frontend to render + speak
 *  3. Appends it to `messages` history so the LLM has context of what it said
 *  4. Fires a macOS banner (osascript notification)
 *  5. Marks the schedule fired (daily check-in re-arms for tomorrow)
 *
 * Started lazily from /api/stream (ensureProactiveScheduler) and from
 * /api/proactive — idempotent per server process.
 */

import { execFile } from "node:child_process";
import {
  claimSchedule,
  getDueSchedules,
  produceMessage,
  type ProactiveSchedule,
} from "../../functions/proactive";

const TICK_MS = 15_000;
const DEFAULT_SESSION = "jarvis-default";

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** Start the scheduler interval if it isn't already running. Safe to call often. */
export function ensureProactiveScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    runProactiveTick().catch((err) =>
      console.error("[Proactive] tick failed:", err)
    );
  }, TICK_MS);
  console.log(`[Proactive] scheduler started (tick ${TICK_MS}ms)`);
  runProactiveTick().catch((err) =>
    console.error("[Proactive] initial tick failed:", err)
  );
}

/** Stop the scheduler (used by tests / shutdown). */
export function stopProactiveScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Run one tick. Returns how many schedules fired. */
export async function runProactiveTick(): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  try {
    // Kill switch: JARVIS is halted — do not initiate contact
    try {
      const { isKillSwitchActive } = await import("../../lib/guardrails");
      if (isKillSwitchActive()) return 0;
    } catch {
      // guardrails unavailable — continue
    }

    const now = new Date();
    const due = await getDueSchedules(now);

    for (const schedule of due) {
      try {
        // Claim first — atomic, so racing ticks can't double-deliver
        const claimed = await claimSchedule(schedule);
        if (!claimed) continue;
        await deliverSchedule(schedule);
        console.log(
          `[Proactive] fired ${schedule.kind} schedule ${schedule.id.slice(0, 8)}`
        );
      } catch (err) {
        console.error(
          `[Proactive] failed to fire schedule ${schedule.id}:`,
          err
        );
      }
    }
    return due.length;
  } finally {
    ticking = false;
  }
}

async function deliverSchedule(schedule: ProactiveSchedule): Promise<void> {
  const sessionId = schedule.session_id ?? DEFAULT_SESSION;

  // 1. Queue for frontend (chat + voice delivery via /api/proactive poll)
  await produceMessage({
    scheduleId: schedule.id,
    kind: schedule.kind,
    content: schedule.message,
    sessionId,
  });

  // 2. Append to chat history so the LLM knows it said this
  try {
    const { supabaseAdmin } = await import("../../lib/supabase-server");
    await supabaseAdmin.from("messages").insert({
      session_id: sessionId,
      role: "assistant",
      content: schedule.message,
    });
  } catch (err) {
    console.error("[Proactive] history insert failed:", err);
  }

  // 3. macOS banner
  fireBanner(schedule.message);
}

/** Fire a macOS notification banner. Best-effort — never throws. */
function fireBanner(message: string): void {
  try {
    const safe = message
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .slice(0, 200);
    execFile(
      "osascript",
      ["-e", `display notification "${safe}" with title "JARVIS" sound name "Glass"`],
      { timeout: 5000 },
      (err) => {
        if (err) console.warn("[Proactive] banner failed:", err.message);
      }
    );
  } catch (err) {
    console.warn("[Proactive] banner spawn failed:", err);
  }
}
