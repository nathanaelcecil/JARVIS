/**
 * Automation tests: recurrence parsing, routine claiming, watch transitions,
 * learned-procedure safety, and the tick that ties them together.
 *
 * Everything runs against a temporary root, so `.jarvis/` in the real workspace
 * is never touched. No helper binary, timer or macOS permission is required.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeRecurrence, nextRunAt, parseRecurrence } from "./schedule";
import {
  addRoutine,
  dueRoutines,
  enqueueOutbox,
  listRoutines,
  popOutbox,
  removeRoutine,
} from "./routines";
import { addWatch, describeWatch, evaluateWatch, listWatches, pollWatches, type Watch } from "./watches";
import {
  forgetProcedure,
  isReplaySafe,
  listProcedures,
  markUsed,
  matchProcedure,
  normalizeTrigger,
  recordProcedure,
} from "./procedures";
import { runAutomationTick } from "./tick";
import { describeReplayOutcome, planProcedureReplay } from "./replay";
import { checkPermission, toolPermissionCategory } from "../guardrails";
import { TOOL_TIERS, tierForTool } from "../tool-tiers";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jarvis-automation-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// A Friday, local time. Chosen so weekday/weekend arithmetic is unambiguous.
const FRIDAY_0700 = new Date(2026, 9, 30, 7, 0, 0);
const FRIDAY_0900 = new Date(2026, 9, 30, 9, 0, 0);

// ── Schedules ─────────────────────────────────────────────────────────────

describe("schedule parsing", () => {
  it("reads intervals", () => {
    expect(parseRecurrence("every 30 minutes")).toEqual({
      ok: true,
      recurrence: { kind: "interval", minutes: 30 },
    });
    expect(parseRecurrence("every 2 hours")).toEqual({
      ok: true,
      recurrence: { kind: "interval", minutes: 120 },
    });
    expect(parseRecurrence("every hour")).toEqual({
      ok: true,
      recurrence: { kind: "interval", minutes: 60 },
    });
  });

  it("reads daily and weekday schedules, with am/pm", () => {
    expect(parseRecurrence("every day at 8")).toEqual({
      ok: true,
      recurrence: { kind: "daily", hour: 8, minute: 0, weekdaysOnly: false },
    });
    expect(parseRecurrence("daily at 08:30")).toEqual({
      ok: true,
      recurrence: { kind: "daily", hour: 8, minute: 30, weekdaysOnly: false },
    });
    expect(parseRecurrence("every weekday at 9am")).toEqual({
      ok: true,
      recurrence: { kind: "daily", hour: 9, minute: 0, weekdaysOnly: true },
    });
    expect(parseRecurrence("every day at 6pm")).toEqual({
      ok: true,
      recurrence: { kind: "daily", hour: 18, minute: 0, weekdaysOnly: false },
    });
  });

  it("reads a named weekday", () => {
    expect(parseRecurrence("every monday at 9")).toEqual({
      ok: true,
      recurrence: { kind: "weekly", weekday: 1, hour: 9, minute: 0 },
    });
  });

  it("refuses anything it cannot predict, with the accepted forms", () => {
    for (const bad of ["whenever", "at some point", ""]) {
      const parsed = parseRecurrence(bad);
      expect(parsed.ok, bad).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("every 30 minutes");
    }
    // Recognisable but out of range: say the bound, not the grammar.
    const tooShort = parseRecurrence("every 1 minute");
    expect(tooShort.ok).toBe(false);
    if (!tooShort.ok) expect(tooShort.error).toContain("shortest interval");

    const tooLong = parseRecurrence("every 25 hours");
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error).toContain("longest interval");
  });

  it("computes the next run in local time", () => {
    const daily = { kind: "daily", hour: 8, minute: 0, weekdaysOnly: false } as const;
    expect(nextRunAt(daily, FRIDAY_0700).getHours()).toBe(8);
    expect(nextRunAt(daily, FRIDAY_0700).getDate()).toBe(30);
    // Already past 08:00 → tomorrow.
    expect(nextRunAt(daily, FRIDAY_0900).getDate()).toBe(31);

    const weekdays = { kind: "daily", hour: 8, minute: 0, weekdaysOnly: true } as const;
    // Friday after the time → Monday the 2nd, not Saturday.
    const monday = nextRunAt(weekdays, FRIDAY_0900);
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(2);

    const weekly = { kind: "weekly", weekday: 1, hour: 9, minute: 0 } as const;
    const nextMonday = nextRunAt(weekly, FRIDAY_0900);
    expect(nextMonday.getDay()).toBe(1);
    expect(nextMonday.getHours()).toBe(9);

    const interval = { kind: "interval", minutes: 30 } as const;
    expect(nextRunAt(interval, FRIDAY_0900).getTime() - FRIDAY_0900.getTime()).toBe(30 * 60_000);
  });

  it("describes itself in words", () => {
    expect(describeRecurrence({ kind: "interval", minutes: 30 })).toBe("every 30 minutes");
    expect(describeRecurrence({ kind: "interval", minutes: 120 })).toBe("every 2 hours");
    expect(
      describeRecurrence({ kind: "daily", hour: 8, minute: 5, weekdaysOnly: true }),
    ).toBe("every weekday at 08:05");
    expect(describeRecurrence({ kind: "weekly", weekday: 3, hour: 17, minute: 0 })).toBe(
      "every wednesday at 17:00",
    );
  });
});

// ── Routines ──────────────────────────────────────────────────────────────

describe("routines", () => {
  it("stores a routine with the next run already computed", async () => {
    const routine = await addRoutine({
      root,
      prompt: "check my inbox and tell me what matters",
      when: "every 30 minutes",
      label: "Inbox sweep",
      now: FRIDAY_0900,
    });
    expect(routine.id).toMatch(/^rt_/);
    expect(routine.label).toBe("Inbox sweep");
    expect(routine.nextRunAt).toBe(FRIDAY_0900.getTime() + 30 * 60_000);
    expect(routine.runs).toBe(0);
    expect(routine.lastRunAt).toBeNull();

    const listed = await listRoutines(root);
    expect(listed.map((entry) => entry.id)).toContain(routine.id);
  });

  it("refuses an unknown schedule or an empty prompt", async () => {
    await expect(
      addRoutine({ root, prompt: "do something", when: "whenever I feel like it" }),
    ).rejects.toThrow(/every 30 minutes/);
    await expect(addRoutine({ root, prompt: "   ", when: "every 30 minutes" })).rejects.toThrow(
      /needs a prompt/,
    );
  });

  it("claims a due routine exactly once and advances it", async () => {
    // Isolated root: otherwise earlier routines in the shared store are due too.
    const claimRoot = mkdtempSync(join(tmpdir(), "jarvis-claim-"));
    try {
      const routine = await addRoutine({
        root: claimRoot,
        prompt: "summarise the day",
        when: "every 30 minutes",
        now: FRIDAY_0900,
      });
      const dueAt = new Date(routine.nextRunAt + 1000);

      // Not due yet.
      expect(await dueRoutines(claimRoot, FRIDAY_0900)).toHaveLength(0);

      const first = await dueRoutines(claimRoot, dueAt);
      expect(first.map((entry) => entry.id)).toEqual([routine.id]);

      // A second tick in the same second must not fire it again.
      expect(await dueRoutines(claimRoot, dueAt)).toHaveLength(0);

      const listed = (await listRoutines(claimRoot)).find((entry) => entry.id === routine.id)!;
      expect(listed.runs).toBe(1);
      expect(listed.lastRunAt).toBe(dueAt.getTime());
      expect(listed.nextRunAt).toBeGreaterThan(dueAt.getTime());
    } finally {
      rmSync(claimRoot, { recursive: true, force: true });
    }
  });

  it("hands claimed prompts to the UI through the outbox, once", async () => {
    const claimed = await dueRoutines(root, new Date(Date.now() + 10 * 60 * 60_000));
    // Nothing overdue for an interval routine 10h out, but the daily/weekly
    // ones added above (if any) may claim; either way the outbox contract holds.
    await enqueueOutbox(root, claimed, 1);
    const drained = await popOutbox(root);
    expect(drained).toHaveLength(claimed.length);
    expect(await popOutbox(root)).toHaveLength(0);
  });

  it("removes a routine", async () => {
    const routine = await addRoutine({
      root,
      prompt: "temporary",
      when: "every 2 hours",
      now: FRIDAY_0900,
    });
    expect(await removeRoutine(root, routine.id)).toBe(true);
    expect(await removeRoutine(root, routine.id)).toBe(false);
    expect((await listRoutines(root)).some((entry) => entry.id === routine.id)).toBe(false);
  });
});

// ── Watches ───────────────────────────────────────────────────────────────

function watch(spec: Watch["spec"], state: Watch["state"] = "unknown", confirmed = false): Watch {
  return {
    id: "wt_test",
    spec,
    createdAt: 0,
    state,
    confirmed,
    fires: 0,
    enabled: true,
  };
}

describe("watch evaluation", () => {
  const windows = (titles: string[], app = "Safari") =>
    ({ kind: "window", windows: titles.map((title) => ({ app, title })) }) as const;

  it("fires when a window appears, and not again while it stays", () => {
    const spec = { kind: "window", title: "export", event: "shows" } as const;
    const first = evaluateWatch(watch(spec), windows(["Export — 40%"]));
    expect(first.fire).toBe(true);
    expect(first.state).toBe("present");

    const second = evaluateWatch(watch(spec, "present"), windows(["Export — 80%"]));
    expect(second.fire).toBe(false);
  });

  it("fires when it goes away, only after it was seen", () => {
    const spec = { kind: "window", title: "export", event: "gone" } as const;
    expect(evaluateWatch(watch(spec), windows(["Notes"])).fire).toBe(false);
    expect(evaluateWatch(watch(spec, "present"), windows(["Notes"])).fire).toBe(true);
  });

  it("fires once when a window has settled for two polls", () => {
    const spec = { kind: "window", title: "invoice", event: "settled" } as const;
    expect(evaluateWatch(watch(spec), windows(["Invoice 123"])).fire).toBe(false); // first sighting
    const settled = evaluateWatch(watch(spec, "present"), windows(["Invoice 123"]));
    expect(settled.fire).toBe(true);
    expect(settled.confirmed).toBe(true);
    // Already reported: no repeat until it disappears and returns.
    expect(evaluateWatch(watch(spec, "present", true), windows(["Invoice 123"])).fire).toBe(false);
  });

  it("matches the app when one is given", () => {
    const spec = { kind: "window", title: "build", event: "shows", app: "Terminal" } as const;
    expect(evaluateWatch(watch(spec), windows(["build failed"], "Xcode")).fire).toBe(false);
    expect(evaluateWatch(watch(spec), windows(["build failed"], "Terminal")).fire).toBe(true);
  });

  it("treats a command watch as firing on the transition to success", () => {
    const spec = { kind: "command", command: "test -f /tmp/done" } as const;
    expect(evaluateWatch(watch(spec), { kind: "command", exitCode: 1 }).fire).toBe(false);
    expect(evaluateWatch(watch(spec), { kind: "command", exitCode: 0 }).fire).toBe(true);
    expect(evaluateWatch(watch(spec, "present"), { kind: "command", exitCode: 0 }).fire).toBe(false);
    expect(evaluateWatch(watch(spec), { kind: "command", exitCode: null }).fire).toBe(false);
  });

  it("survives a mismatched observation instead of guessing", () => {
    const spec = { kind: "window", title: "x", event: "shows" } as const;
    const result = evaluateWatch(watch(spec), { kind: "command", exitCode: 0 });
    expect(result.fire).toBe(false);
    expect(result.skip).toBeTruthy();
  });
});

describe("watch store and polling", () => {
  it("stores, describes and polls a watch, persisting its state", async () => {
    const created = await addWatch({
      root,
      spec: { kind: "window", title: "Deploy", event: "shows", app: "Terminal" },
      then: "tell me the deployment finished",
    });
    expect(describeWatch(created)).toBe('when Terminal window "Deploy" appears');

    const fired = await pollWatches(root, async () => ({
      kind: "window",
      windows: [{ app: "Terminal", title: "Deploy finished" }],
    }));
    expect(fired.map((entry) => entry.id)).toEqual([created.id]);

    // State persisted as present, so the next poll does not fire again.
    const stored = (await listWatches(root)).find((entry) => entry.id === created.id)!;
    expect(stored.state).toBe("present");
    const again = await pollWatches(root, async () => ({
      kind: "window",
      windows: [{ app: "Terminal", title: "Deploy finished" }],
    }));
    expect(again).toHaveLength(0);
  });

  it("refuses an empty watch", async () => {
    await expect(
      addWatch({ root, spec: { kind: "window", title: "  ", event: "shows" } }),
    ).rejects.toThrow(/words from the window title/);
    await expect(addWatch({ root, spec: { kind: "command", command: "" } })).rejects.toThrow(
      /shell test/,
    );
  });

  it("does not wedge when an observation throws", async () => {
    const created = await addWatch({ root, spec: { kind: "command", command: "true" } });
    const fired = await pollWatches(root, async () => {
      throw new Error("helper missing");
    });
    expect(fired).toHaveLength(0);
    // Still listed and still disabled from firing spuriously.
    expect((await listWatches(root)).some((entry) => entry.id === created.id)).toBe(true);
  });
});

// ── Procedures ────────────────────────────────────────────────────────────

describe("learned procedures", () => {
  const tier = (tool: string): "auto" | "confirm" | "never" =>
    tool === "system.shutdown" ? "never" : tool.startsWith("gh_create") ? "confirm" : "auto";

  it("normalises a trigger phrase", () => {
    expect(normalizeTrigger("Hey Jarvis, Focus Mode.")).toBe("focus mode");
    expect(normalizeTrigger("  open   my   notes  ")).toBe("open my notes");
    expect(normalizeTrigger("Open Chrome!")).toBe("open chrome");
  });

  it("records and matches only the exact phrase", async () => {
    await recordProcedure({
      root,
      trigger: "focus mode",
      steps: [
        { tool: "open_app", args: { name: "Notes" } },
        { tool: "set_volume", args: { level: 20 } },
      ],
      tierOf: tier,
    });

    const match = await matchProcedure(root, "Hey Jarvis, focus mode!");
    expect(match?.steps).toHaveLength(2);
    expect(await matchProcedure(root, "focus")).toBeNull();
    expect(await matchProcedure(root, "focus mode please")).toBeNull();
  });

  it("refuses blocked or destructive steps", () => {
    expect(isReplaySafe([{ tool: "system.shutdown", args: {} }], tier)).toEqual({
      safe: false,
      reason: expect.stringContaining("blocked"),
      stepIndex: 0,
    });
    expect(
      isReplaySafe([{ tool: "run_command", args: { command: "rm -rf ~/Desktop" } }], tier).safe,
    ).toBe(false);
    expect(isReplaySafe([{ tool: "git.push", args: {} }], tier).safe).toBe(false);
    expect(isReplaySafe([], tier).safe).toBe(false);
    // A confirm-tier step is allowed: it keeps asking when it replays.
    expect(isReplaySafe([{ tool: "gh_create_issue", args: { title: "x" } }], tier).safe).toBe(true);
  });

  it("will not store a procedure whose steps are unsafe", async () => {
    await expect(
      recordProcedure({
        root,
        trigger: "shut it all down",
        steps: [{ tool: "system.shutdown", args: {} }],
        tierOf: tier,
      }),
    ).rejects.toThrow(/blocked/);
    expect(await matchProcedure(root, "shut it all down")).toBeNull();
  });

  it("counts uses and can be forgotten", async () => {
    const recorded = await recordProcedure({
      root,
      trigger: "morning setup",
      steps: [{ tool: "open_app", args: { name: "Calendar" } }],
      tierOf: tier,
    });
    await markUsed(root, recorded.key);
    await markUsed(root, recorded.key);
    const listed = (await listProcedures(root)).find((entry) => entry.key === recorded.key)!;
    expect(listed.uses).toBe(2);

    expect(await forgetProcedure(root, "Morning Setup")).toBe(true);
    expect(await forgetProcedure(root, "Morning Setup")).toBe(false);
  });
});

// ── Replay planning ───────────────────────────────────────────────────────

describe("procedure replay", () => {
  it("replays a phrase whose steps are all automatic", async () => {
    const replayRoot = mkdtempSync(join(tmpdir(), "jarvis-replay-"));
    try {
      await recordProcedure({
        root: replayRoot,
        trigger: "status check",
        steps: [
          { tool: "get_volume", args: {} },
          { tool: "list_running_apps", args: {} },
        ],
        tierOf: tierForTool,
      });

      const plan = await planProcedureReplay(replayRoot, "Status check!");
      expect(plan?.procedure.key).toBe("status check");
      expect(plan?.steps).toHaveLength(2);
    } finally {
      rmSync(replayRoot, { recursive: true, force: true });
    }
  });

  it("refuses to replay anything containing an approval-worthy step", async () => {
    const replayRoot = mkdtempSync(join(tmpdir(), "jarvis-replay-confirm-"));
    try {
      await recordProcedure({
        root: replayRoot,
        trigger: "open my notes",
        steps: [{ tool: "open_app", args: { name: "Notes" } }],
        tierOf: tierForTool,
      });
      // open_app is confirm tier, so the model path handles it (with a card).
      expect(await planProcedureReplay(replayRoot, "open my notes")).toBeNull();
      expect(await planProcedureReplay(replayRoot, "something never taught")).toBeNull();
    } finally {
      rmSync(replayRoot, { recursive: true, force: true });
    }
  });

  it("describes the outcome without claiming more than it did", () => {
    expect(describeReplayOutcome("focus mode", 2)).toContain("2 steps");
    expect(describeReplayOutcome("focus mode", 1)).toContain("1 step");
    expect(describeReplayOutcome("focus mode", 1)).toContain("focus mode");
  });
});

// ── Tool wiring ───────────────────────────────────────────────────────────

describe("automation tool permissions", () => {
  it("gates anything that creates or deletes automation", () => {
    // Creating a routine or watch, teaching a procedure and forgetting one are
    // durable changes to how JARVIS behaves: confirm tier in both tables.
    const gated = [
      "routine_add",
      "routine_remove",
      "watch_add",
      "watch_remove",
      "procedure_learn",
      "procedure_forget",
    ];
    for (const tool of gated) {
      expect(TOOL_TIERS[tool], `${tool} tier`).toBe("confirm");
      const category = toolPermissionCategory(tool);
      // A tool missing from the mapping silently fails closed to the tool name
      // as its category; assert the mapping really exists.
      expect(category).not.toBe(tool);
      expect(checkPermission(category).permission).toBe("confirm");
    }
  });

  it("leaves the listings open", () => {
    for (const tool of ["routine_list", "watch_list", "procedure_list"]) {
      expect(TOOL_TIERS[tool]).toBe("auto");
      expect(checkPermission(toolPermissionCategory(tool))).toEqual({
        allowed: true,
        permission: "auto",
      });
    }
  });
});

// ── The tick ──────────────────────────────────────────────────────────────

describe("automation tick", () => {
  it("claims a due routine and puts it in the outbox", async () => {
    const tickRoot = mkdtempSync(join(tmpdir(), "jarvis-tick-"));
    try {
      const now = new Date(2026, 9, 30, 9, 0, 0);
      const routine = await addRoutine({
        root: tickRoot,
        prompt: "water the plants",
        when: "every 5 minutes",
        now,
      });

      const result = await runAutomationTick(tickRoot, new Date(routine.nextRunAt + 1000));
      expect(result.routines, "tick result").toBe(1);

      const drained = await popOutbox(tickRoot);
      expect(drained).toHaveLength(1);
      expect(drained[0]!.prompt).toBe("water the plants");
      expect(drained[0]!.id).toBe(routine.id);

      // The next tick is idle: nothing due, nothing queued.
      const idle = await runAutomationTick(tickRoot, new Date(routine.nextRunAt + 2000));
      expect(idle.routines).toBe(0);
      expect(await popOutbox(tickRoot)).toHaveLength(0);
    } finally {
      rmSync(tickRoot, { recursive: true, force: true });
    }
  });

  it("queues a fired watch's follow-up request through the outbox", async () => {
    const watchRoot = mkdtempSync(join(tmpdir(), "jarvis-watch-then-"));
    try {
      const watch = await addWatch({
        root: watchRoot,
        spec: { kind: "command", command: "true" },
        then: "tell me the deployment finished",
      });
      const result = await runAutomationTick(watchRoot, new Date());
      expect(result.watches).toBe(1);

      const drained = await popOutbox(watchRoot);
      expect(drained).toHaveLength(1);
      expect(drained[0]!.id).toBe(`watch:${watch.id}`);
      expect(drained[0]!.prompt).toBe("tell me the deployment finished");

      // And it does not queue the same follow-up again on the next tick.
      await runAutomationTick(watchRoot, new Date());
      expect(await popOutbox(watchRoot)).toHaveLength(0);
    } finally {
      rmSync(watchRoot, { recursive: true, force: true });
    }
  });

  it("does nothing at all when no automation is configured", async () => {
    const quietRoot = mkdtempSync(join(tmpdir(), "jarvis-quiet-"));
    try {
      const result = await runAutomationTick(quietRoot, new Date());
      expect(result).toEqual({ routines: 0, watches: 0 });
      // An idle tick must not conjure empty stores into existence: it runs
      // every 15 seconds, and writing nothing should touch nothing.
      expect(existsSync(join(quietRoot, ".jarvis", "routines.json"))).toBe(false);
      expect(existsSync(join(quietRoot, ".jarvis", "watches.json"))).toBe(false);
    } finally {
      rmSync(quietRoot, { recursive: true, force: true });
    }
  });

  it("does not rewrite an unchanged store on an idle tick", async () => {
    const idleRoot = mkdtempSync(join(tmpdir(), "jarvis-idle-"));
    try {
      const now = new Date(2026, 9, 30, 9, 0, 0);
      await addRoutine({ root: idleRoot, prompt: "nothing due", when: "every day at 23:59", now });
      const file = join(idleRoot, ".jarvis", "routines.json");
      const before = statSync(file).mtimeMs;

      // Not due: several ticks in the same period must leave the file alone.
      await dueRoutines(idleRoot, now);
      await dueRoutines(idleRoot, now);
      expect(statSync(file).mtimeMs).toBe(before);
    } finally {
      rmSync(idleRoot, { recursive: true, force: true });
    }
  });
});
