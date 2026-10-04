import type { Memory, LearnedBehavior } from "./supabase-types";

/**
 * Write-through RAM cache for LLM context (memories, learned behaviors,
 * per-session history). /api/stream reads from here first — a fresh cache
 * hit skips ~0.9-1.6s of Supabase round-trips per turn.
 *
 * Sync rules (every DB write in stream.ts keeps this cache honest):
 *  - memories / learned_behaviors: 60s TTL; inserts invalidate → next read
 *    refetches with real DB ids.
 *  - messages history: 30min TTL, append-only; inserts are appended
 *    in-process (true write-through); insert failures invalidate.
 */

export interface CachedMessage {
  role: "user" | "assistant";
  content: string;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const MEMORY_TTL_MS = 60_000;
const BEHAVIOR_TTL_MS = 60_000;
const HISTORY_TTL_MS = 30 * 60_000;
const HISTORY_MAX = 40; // keep last 20 turns (user+assistant) cached

let memoryEntry: Entry<Memory[]> | null = null;
let behaviorEntry: Entry<LearnedBehavior[]> | null = null;
const historyEntries = new Map<string, Entry<CachedMessage[]>>();

// ── Memories ────────────────────────────────────────────────
export function getCachedMemories(): Memory[] | null {
  return memoryEntry && memoryEntry.expiresAt > Date.now()
    ? memoryEntry.value
    : null;
}

export function setCachedMemories(rows: Memory[]): void {
  memoryEntry = { value: rows, expiresAt: Date.now() + MEMORY_TTL_MS };
}

export function invalidateMemories(): void {
  memoryEntry = null;
}

// ── Learned behaviors ───────────────────────────────────────
export function getCachedBehaviors(): LearnedBehavior[] | null {
  return behaviorEntry && behaviorEntry.expiresAt > Date.now()
    ? behaviorEntry.value
    : null;
}

export function setCachedBehaviors(rows: LearnedBehavior[]): void {
  behaviorEntry = { value: rows, expiresAt: Date.now() + BEHAVIOR_TTL_MS };
}

export function invalidateBehaviors(): void {
  behaviorEntry = null;
}

// ── Per-session history (chronological order) ───────────────
export function getCachedHistory(sessionId: string): CachedMessage[] | null {
  const entry = historyEntries.get(sessionId);
  return entry && entry.expiresAt > Date.now() ? entry.value : null;
}

/** Store a fetched history snapshot. `msgs` must be chronological. */
export function setCachedHistory(
  sessionId: string,
  msgs: CachedMessage[],
): void {
  const trimmed =
    msgs.length > HISTORY_MAX ? msgs.slice(msgs.length - HISTORY_MAX) : msgs;
  historyEntries.set(sessionId, {
    value: trimmed,
    expiresAt: Date.now() + HISTORY_TTL_MS,
  });
}

/** Write-through: append one message to a live cache entry immediately. */
export function appendHistory(sessionId: string, msg: CachedMessage): void {
  const entry = historyEntries.get(sessionId);
  if (!entry || entry.expiresAt <= Date.now()) return; // nothing live to sync
  entry.value.push(msg);
  if (entry.value.length > HISTORY_MAX) {
    entry.value.splice(0, entry.value.length - HISTORY_MAX);
  }
}

/** Drop a session's cached history (DB write failed / divergence risk). */
export function invalidateHistory(sessionId: string): void {
  historyEntries.delete(sessionId);
}
