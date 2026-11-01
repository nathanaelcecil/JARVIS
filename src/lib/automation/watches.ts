/**
 * Watches — "tell me when <window> appears / goes away / settles", with no
 * model in the loop.
 *
 * Atticus polls a few times a second and fires a notification (plus an optional
 * follow-up request). This is the same idea on JARVIS's seam: the 15-second
 * scheduler tick calls `pollWatches`, which evaluates each watch against a
 * cheap observation and only fires on a *transition*. Nothing here calls a
 * model, so a watch costs nothing while it waits.
 *
 * Two kinds:
 *   window  — a window whose title (and optionally app) contains some words
 *             appeared, disappeared, or stayed put for two consecutive polls
 *   command — a shell test; fires when it starts succeeding
 *
 * All evaluation is a pure function of (watch, observation), so the interesting
 * behaviour is tested without timers, macOS or permissions.
 */

import { execFile } from "node:child_process";
import { mutateJson, newId, readJson } from "./store";

export const WATCHES_FILE = "watches.json";
export const MAX_WATCHES = 20;
export const MAX_TITLE_CHARS = 120;

export type WatchEvent = "shows" | "gone" | "settled";

export type WatchSpec =
  | { kind: "window"; title: string; app?: string; event: WatchEvent }
  | { kind: "command"; command: string };

export interface Watch {
  id: string;
  spec: WatchSpec;
  /** What JARVIS should do when it fires, e.g. a prompt to run. */
  then?: string;
  createdAt: number;
  /** Previous observation, for transition detection. */
  state: "unknown" | "present" | "absent";
  /** A "settled" watch fires once per appearance. */
  confirmed: boolean;
  fires: number;
  enabled: boolean;
}

export interface WindowObservation {
  app: string;
  title: string;
}

export type Observation =
  | { kind: "window"; windows: WindowObservation[] }
  | { kind: "command"; exitCode: number | null };

interface WatchesFile {
  version: 1;
  watches: Watch[];
}

const EMPTY: WatchesFile = { version: 1, watches: [] };

export interface WatchEvaluation {
  /** True when this poll should produce a notification. */
  fire: boolean;
  state: Watch["state"];
  confirmed: boolean;
  /** Set when the watch cannot be evaluated at all this tick. */
  skip?: string;
}

/**
 * Evaluate one alarm against one observation. Pure: no clock, no I/O.
 */
export function evaluateWatch(watch: Watch, observation: Observation): WatchEvaluation {
  if (watch.spec.kind === "window") {
    if (observation.kind !== "window") {
      return { fire: false, state: watch.state, confirmed: watch.confirmed, skip: "wrong observation" };
    }
    const spec = watch.spec;
    const title = spec.title.toLowerCase();
    const app = spec.app?.toLowerCase();
    const present = observation.windows.some(
      (window) =>
        window.title.toLowerCase().includes(title) &&
        (app === undefined || window.app.toLowerCase().includes(app)),
    );

    switch (spec.event) {
      case "shows":
        return {
          fire: present && watch.state !== "present",
          state: present ? "present" : "absent",
          confirmed: false,
        };
      case "gone":
        return {
          fire: !present && watch.state === "present",
          state: present ? "present" : "absent",
          confirmed: false,
        };
      case "settled": {
        // Present for two consecutive polls and not yet reported.
        const fire = present && watch.state === "present" && !watch.confirmed;
        return { fire, state: present ? "present" : "absent", confirmed: present ? true : false };
      }
      default:
        return { fire: false, state: watch.state, confirmed: watch.confirmed, skip: "unknown event" };
    }
  }

  if (observation.kind !== "command") {
    return { fire: false, state: watch.state, confirmed: watch.confirmed, skip: "wrong observation" };
  }
  if (observation.exitCode === null) {
    return { fire: false, state: watch.state, confirmed: watch.confirmed, skip: "command did not run" };
  }
  const passing = observation.exitCode === 0;
  // Fire on the transition into success, not on every tick while it holds.
  return {
    fire: passing && watch.state !== "present",
    state: passing ? "present" : "absent",
    confirmed: false,
  };
}

/** Create a watch. Throws with an actionable message on bad input. */
export async function addWatch(params: {
  root: string;
  spec: WatchSpec;
  then?: string;
  now?: Date;
}): Promise<Watch> {
  const spec = params.spec;
  if (spec.kind === "window") {
    if (!spec.title.trim()) throw new Error("a window watch needs some words from the window title");
    if (spec.title.length > MAX_TITLE_CHARS) {
      throw new Error(`the title words are too long (max ${MAX_TITLE_CHARS} characters)`);
    }
    if (!["shows", "gone", "settled"].includes(spec.event)) {
      throw new Error('event must be "shows", "gone" or "settled"');
    }
  } else if (spec.kind === "command") {
    if (!spec.command.trim()) throw new Error("a command watch needs a shell test");
    if (spec.command.includes("\u0000")) throw new Error("the command contains a NUL byte");
  } else {
    throw new Error('a watch must be either a window watch or a command watch');
  }

  const watch: Watch = {
    id: newId("wt"),
    spec,
    ...(params.then ? { then: params.then } : {}),
    createdAt: (params.now ?? new Date()).getTime(),
    state: "unknown",
    confirmed: false,
    fires: 0,
    enabled: true,
  };

  await mutateJson<WatchesFile>(params.root, WATCHES_FILE, EMPTY, (file) => {
    const watches = file.version === 1 && Array.isArray(file.watches) ? file.watches : [];
    if (watches.length >= MAX_WATCHES) {
      throw new Error(`there are already ${MAX_WATCHES} watches; remove one first`);
    }
    return { version: 1, watches: [...watches, watch] };
  });

  return watch;
}

export async function listWatches(root: string): Promise<Watch[]> {
  const file = await readJson<WatchesFile>(root, WATCHES_FILE, EMPTY);
  return file.version === 1 && Array.isArray(file.watches) ? file.watches : [];
}

export async function removeWatch(root: string, id: string): Promise<boolean> {
  let removed = false;
  await mutateJson<WatchesFile>(root, WATCHES_FILE, EMPTY, (file) => {
    const watches = file.version === 1 && Array.isArray(file.watches) ? file.watches : [];
    const kept = watches.filter((watch) => watch.id !== id);
    removed = kept.length !== watches.length;
    return { version: 1, watches: kept };
  });
  return removed;
}

/**
 * One polling pass: evaluate every enabled watch against `observe`, persist the
 * new state, and return the watches that should fire.
 */
export async function pollWatches(
  root: string,
  observe: (watch: Watch) => Promise<Observation>,
  _now: Date = new Date(),
): Promise<Watch[]> {
  const fired: Watch[] = [];

  await mutateJson<WatchesFile>(root, WATCHES_FILE, EMPTY, async (file) => {
    const watches = file.version === 1 && Array.isArray(file.watches) ? file.watches : [];
    const updated: Watch[] = [];

    for (const watch of watches) {
      if (!watch.enabled) {
        updated.push(watch);
        continue;
      }
      let observation: Observation;
      try {
        observation = await observe(watch);
      } catch {
        // A failing observation must never wedge the tick or reset state.
        updated.push(watch);
        continue;
      }
      const result = evaluateWatch(watch, observation);
      if (result.fire) {
        fired.push({ ...watch, fires: watch.fires + 1 });
      }
      updated.push({
        ...watch,
        state: result.state,
        confirmed: result.confirmed,
        fires: result.fire ? watch.fires + 1 : watch.fires,
      });
    }

    return { version: 1, watches: updated };
  });

  return fired;
}

/** A short human description of a watch, for confirmations and listings. */
export function describeWatch(watch: Watch): string {
  if (watch.spec.kind === "command") {
    return `when \`${watch.spec.command}\` starts succeeding`;
  }
  const where = watch.spec.app ? `${watch.spec.app} window` : "a window";
  const words = `"${watch.spec.title}"`;
  switch (watch.spec.event) {
    case "shows":
      return `when ${where} ${words} appears`;
    case "gone":
      return `when ${where} ${words} goes away`;
    case "settled":
      return `when ${where} ${words} has settled`;
    default:
      return `when ${where} ${words} changes`;
  }
}

/** Run a command watch's test with a short timeout. Exit 0 means "true". */
export function runWatchCommand(command: string, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolvePromise) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { timeout: timeoutMs, encoding: "utf8", windowsHide: true },
      (error) => {
        if (!error) return resolvePromise(0);
        const code = (error as NodeJS.ErrnoException).code;
        resolvePromise(typeof code === "number" ? code : null);
      },
    );
  });
}
