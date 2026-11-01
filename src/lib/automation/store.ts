/**
 * Small JSON store helpers for JARVIS automation (routines, watches,
 * procedures).
 *
 * Everything lives under `<root>/.jarvis/` — the same private directory the
 * coding agent uses — because these are local, single-user settings and must
 * work without Supabase configured. Writes are atomic (write tmp + rename) and
 * serialized per file, so two scheduler ticks can never clobber each other.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** Absolute path of a store file inside the workspace's .jarvis directory. */
export function storeFile(root: string, name: string): string {
  return path.join(path.resolve(root), ".jarvis", name);
}

const locks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to one store file. Failures do not poison the
 * queue: the next caller still runs.
 */
export function withStoreLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  locks.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/** Read a JSON store, or `fallback` when it is missing or corrupt. */
export async function readJson<T>(root: string, name: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(storeFile(root, name), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as T;
  } catch {
    // Missing or corrupt — the caller's default is the correct answer.
  }
  return fallback;
}

/** Atomically replace a JSON store. */
export async function writeJson(root: string, name: string, value: unknown): Promise<void> {
  const file = storeFile(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * Read-modify-write under the file's lock.
 *
 * The write is skipped when the mutation produced no change. That matters: the
 * automation tick runs every 15 seconds, and an idle tick must not create empty
 * stores or rewrite them (needless disk churn, and a file that should not exist
 * yet suddenly does).
 */
export async function mutateJson<T>(
  root: string,
  name: string,
  fallback: T,
  fn: (value: T) => Promise<T> | T,
): Promise<T> {
  const key = storeFile(root, name);
  return withStoreLock(key, async () => {
    const current = await readJson<T>(root, name, fallback);
    const next = await fn(current);
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      await writeJson(root, name, next);
    }
    return next;
  });
}

/** Short random id, prefixed so an id is recognisable in a log. */
export function newId(prefix: string): string {
  const random = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `${prefix}_${Date.now().toString(36)}${random}`;
}
