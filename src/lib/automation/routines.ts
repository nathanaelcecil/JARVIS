/**
 * Routines — JARVIS's answer to Atticus's cron-like "routines".
 *
 * A routine is a stored prompt plus a recurrence. The scheduler tick claims due
 * routines and puts the prompt in an outbox the UI drains, so a routine works
 * without Supabase and without a second daemon: the app already ticks every
 * 15 seconds.
 *
 * Claiming is the important property: `dueRoutines` advances `nextRunAt` and
 * stamps `lastRunAt` in the same locked write that reads the due set, so two
 * overlapping ticks can never fire the same routine twice.
 */

import { describeRecurrence, nextRunAt, parseRecurrence, type Recurrence } from "./schedule";
import { mutateJson, newId, readJson, storeFile } from "./store";

export const ROUTINES_FILE = "routines.json";
export const ROUTINE_OUTBOX_FILE = "routine-outbox.json";
export const MAX_ROUTINES = 50;
export const MAX_PROMPT_CHARS = 2000;

export interface Routine {
  id: string;
  label: string;
  prompt: string;
  recurrence: Recurrence;
  createdAt: number;
  lastRunAt: number | null;
  nextRunAt: number;
  runs: number;
  enabled: boolean;
}

interface RoutinesFile {
  version: 1;
  routines: Routine[];
}

const EMPTY: RoutinesFile = { version: 1, routines: [] };

export interface OutboxEntry {
  id: string;
  label: string;
  prompt: string;
  at: number;
}

interface OutboxFile {
  version: 1;
  entries: OutboxEntry[];
}

const EMPTY_OUTBOX: OutboxFile = { version: 1, entries: [] };

function cleanLabel(label: string | undefined, prompt: string): string {
  const raw = (label ?? prompt).trim().replace(/\s+/g, " ");
  return raw.length > 60 ? `${raw.slice(0, 57)}…` : raw || "routine";
}

/** Create a routine. Throws with an actionable message on bad input. */
export async function addRoutine(params: {
  root: string;
  prompt: string;
  when: string;
  label?: string;
  now?: Date;
}): Promise<Routine> {
  const prompt = params.prompt.trim();
  if (!prompt) throw new Error("a routine needs a prompt: what should JARVIS do when it fires?");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`the routine prompt is too long (max ${MAX_PROMPT_CHARS} characters)`);
  }

  const parsed = parseRecurrence(params.when);
  if (!parsed.ok) throw new Error(parsed.error);

  const now = params.now ?? new Date();
  const routine: Routine = {
    id: newId("rt"),
    label: cleanLabel(params.label, prompt),
    prompt,
    recurrence: parsed.recurrence,
    createdAt: now.getTime(),
    lastRunAt: null,
    nextRunAt: nextRunAt(parsed.recurrence, now).getTime(),
    runs: 0,
    enabled: true,
  };

  await mutateJson<RoutinesFile>(params.root, ROUTINES_FILE, EMPTY, (file) => {
    const routines = file.version === 1 && Array.isArray(file.routines) ? file.routines : [];
    if (routines.length >= MAX_ROUTINES) {
      throw new Error(`there are already ${MAX_ROUTINES} routines; remove one first`);
    }
    return { version: 1, routines: [...routines, routine] };
  });

  return routine;
}

/** Every routine, soonest first. */
export async function listRoutines(root: string): Promise<Routine[]> {
  const file = await readJson<RoutinesFile>(root, ROUTINES_FILE, EMPTY);
  const routines = file.version === 1 && Array.isArray(file.routines) ? file.routines : [];
  return [...routines].sort((a, b) => a.nextRunAt - b.nextRunAt);
}

/** Remove a routine by id. Returns whether anything was removed. */
export async function removeRoutine(root: string, id: string): Promise<boolean> {
  let removed = false;
  await mutateJson<RoutinesFile>(root, ROUTINES_FILE, EMPTY, (file) => {
    const routines = file.version === 1 && Array.isArray(file.routines) ? file.routines : [];
    const kept = routines.filter((routine) => routine.id !== id);
    removed = kept.length !== routines.length;
    return { version: 1, routines: kept };
  });
  return removed;
}

/**
 * Claim every routine that is due, in one locked read-modify-write.
 *
 * Returns the claimed routines; each has already been advanced, so calling this
 * twice in the same second yields the routines once and then nothing.
 */
export async function dueRoutines(root: string, now: Date = new Date()): Promise<Routine[]> {
  const claimed: Routine[] = [];
  await mutateJson<RoutinesFile>(root, ROUTINES_FILE, EMPTY, (file) => {
    const routines = file.version === 1 && Array.isArray(file.routines) ? file.routines : [];
    const updated = routines.map((routine) => {
      if (!routine.enabled) return routine;
      if (routine.nextRunAt > now.getTime()) return routine;

      claimed.push({ ...routine });
      return {
        ...routine,
        lastRunAt: now.getTime(),
        nextRunAt: nextRunAt(routine.recurrence, now).getTime(),
        runs: routine.runs + 1,
      };
    });
    return { version: 1, routines: updated };
  });
  return claimed.sort((a, b) => a.nextRunAt - b.nextRunAt);
}

/**
 * Queue prompts for the UI: claimed routines, and the `then` prompt of a watch
 * that just fired.
 */
export async function enqueueOutbox(
  root: string,
  routines: Array<{ id: string; label: string; prompt: string }>,
  at = Date.now(),
): Promise<void> {
  if (routines.length === 0) return;
  await mutateJson<OutboxFile>(root, ROUTINE_OUTBOX_FILE, EMPTY_OUTBOX, (file) => {
    const entries = file.version === 1 && Array.isArray(file.entries) ? file.entries : [];
    const added = routines.map((entry) => ({
      id: entry.id,
      label: entry.label,
      prompt: entry.prompt,
      at,
    }));
    // Keep the outbox bounded; the oldest entries are the least useful.
    return { version: 1, entries: [...entries, ...added].slice(-50) };
  });
}

/** Drain the outbox (single consumer: the /api/proactive poll). */
export async function popOutbox(root: string): Promise<OutboxEntry[]> {
  let drained: OutboxEntry[] = [];
  await mutateJson<OutboxFile>(root, ROUTINE_OUTBOX_FILE, EMPTY_OUTBOX, (file) => {
    drained = file.version === 1 && Array.isArray(file.entries) ? file.entries : [];
    return { version: 1, entries: [] };
  });
  return drained;
}

/** Where a routine's state lives (used in logs and the tool descriptions). */
export function routinesPath(root: string): string {
  return storeFile(root, ROUTINES_FILE);
}

/** Human description of when a routine runs. */
export function routineSchedule(routine: Routine): string {
  return describeRecurrence(routine.recurrence);
}
