/**
 * Persistent agent task state.
 *
 * Tasks live at <workspace>/.jarvis/tasks.json (atomic writes) so long-running
 * work survives application restarts. On load, tasks that were mid-flight when
 * the process died are marked CANCELLED + interrupted (resumable) — they are
 * never silently restarted.
 *
 * A single task may be ACTIVE at a time per store: duplicate or conflicting
 * execution is rejected at start.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentEvent, AgentPhase, AgentTaskRecord } from "./engine-types";

/** Phases considered "in flight" for duplicate-execution prevention. */
export const ACTIVE_PHASES: AgentPhase[] = [
  "IDLE",
  "UNDERSTANDING",
  "INVESTIGATING",
  "PLANNING",
  "IMPLEMENTING",
  "TESTING",
  "CORRECTING",
  "NEEDS_APPROVAL",
];

export const TERMINAL_PHASES: AgentPhase[] = ["COMPLETED", "FAILED", "CANCELLED"];

interface StoreFile {
  version: 1;
  tasks: AgentTaskRecord[];
}

function storePath(repoRoot: string): string {
  return path.join(repoRoot, ".jarvis", "tasks.json");
}

/**
 * Per-store write queue: load+mutate+rename must be one critical section,
 * because parallel read-only investigations append events concurrently.
 * Without it, two saveTask calls would race on the same tmp file and the
 * second load could clobber the first write.
 */
const writeQueues = new Map<string, Promise<void>>();

function queueWrite(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const guarded = run.catch(() => undefined);
  writeQueues.set(key, guarded);
  return run;
}

async function loadStore(repoRoot: string): Promise<StoreFile> {
  try {
    const raw = await fs.readFile(storePath(repoRoot), "utf-8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.tasks)) {
      return parsed;
    }
  } catch {
    // Missing or corrupt — start fresh.
  }
  return { version: 1, tasks: [] };
}

async function saveStore(repoRoot: string, data: StoreFile): Promise<void> {
  const p = storePath(repoRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmp, p);
}

/**
 * Load persisted tasks and mark any that were mid-flight at process death as
 * CANCELLED + interrupted (resumable). Returns the recovered records.
 * Call once at server start.
 */
export async function recoverTasks(repoRoot: string): Promise<AgentTaskRecord[]> {
  const data = await loadStore(repoRoot);
  let changed = false;
  for (const t of data.tasks) {
    if (ACTIVE_PHASES.includes(t.phase)) {
      t.phase = "CANCELLED";
      t.interrupted = true;
      t.error = "Interrupted by application restart — resumable";
      t.updatedAt = Date.now();
      changed = true;
    }
  }
  if (changed) await saveStore(repoRoot, data);
  return data.tasks;
}

export async function saveTask(record: AgentTaskRecord): Promise<void> {
  const key = storePath(record.repoRoot);
  await queueWrite(key, async () => {
    const data = await loadStore(record.repoRoot);
    const idx = data.tasks.findIndex((t) => t.id === record.id);
    if (idx >= 0) data.tasks[idx] = record;
    else data.tasks.push(record);
    // Cap history: keep the most recent 30 terminal tasks.
    const terminals = data.tasks
      .filter((t) => TERMINAL_PHASES.includes(t.phase))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (terminals.length > 30) {
      const drop = new Set(terminals.slice(30).map((t) => t.id));
      data.tasks = data.tasks.filter((t) => !drop.has(t.id));
    }
    await saveStore(record.repoRoot, data);
  });
}

export async function loadTask(
  repoRoot: string,
  taskId: string,
): Promise<AgentTaskRecord | undefined> {
  const data = await loadStore(repoRoot);
  return data.tasks.find((t) => t.id === taskId);
}

export async function listTasks(repoRoot: string): Promise<AgentTaskRecord[]> {
  const data = await loadStore(repoRoot);
  return [...data.tasks].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The one currently in-flight task, if any. */
export async function findActiveTask(repoRoot: string): Promise<AgentTaskRecord | undefined> {
  const data = await loadStore(repoRoot);
  return data.tasks.find((t) => ACTIVE_PHASES.includes(t.phase));
}

/** Append a progress event with a bounded buffer, then persist. */
export async function appendEvent(
  record: AgentTaskRecord,
  event: Omit<AgentEvent, "at">,
): Promise<void> {
  record.events.push({ at: Date.now(), ...event });
  if (record.events.length > 200) {
    record.events = record.events.slice(-200);
  }
  record.updatedAt = Date.now();
  await saveTask(record);
}

/** Record a completed milestone for resume/reporting. */
export async function appendStep(
  record: AgentTaskRecord,
  step: { phase: AgentPhase; summary: string },
): Promise<void> {
  record.steps.push({ at: Date.now(), ...step });
  record.updatedAt = Date.now();
  await saveTask(record);
}
