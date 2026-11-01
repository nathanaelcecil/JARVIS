/**
 * Persistent, repository-scoped engineering memory.
 *
 * Stored at <workspace>/.jarvis/memory.json — one entry list per repo root.
 * Entries remember architecture, conventions, decisions, known bugs, fixes,
 * failed approaches and task status so JARVIS can resume work without
 * repeating it.
 *
 * Safety properties:
 *  - Secret-looking content is refused at write time (looksLikeSecret).
 *  - Entries that reference files are lazily marked stale when those files
 *    change on disk (current source beats outdated memory).
 *  - Inspect/correct: listMemory / updateMemoryEntry / deleteMemoryEntry.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { looksLikeSecret } from "./workspace";

export type MemoryKind =
  | "architecture"
  | "decision"
  | "convention"
  | "bug"
  | "fix"
  | "failed_approach"
  | "task_status"
  | "note";

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  /** Workspace-relative file paths this entry describes (for staleness). */
  fileRefs: string[];
  updatedAt: number;
  /** True when a referenced file changed after the entry was written. */
  stale?: boolean;
  /** Free-form tag, e.g. the task id that produced it. */
  source?: string;
}

interface MemoryFile {
  version: 1;
  repos: Record<string, { entries: MemoryEntry[] }>;
}

const MAX_ENTRIES_PER_REPO = 200;
const MAX_CONTENT_CHARS = 1000;

function memoryPath(repoRoot: string): string {
  return path.join(repoRoot, ".jarvis", "memory.json");
}

async function loadMemoryFile(repoRoot: string): Promise<MemoryFile> {
  try {
    const raw = await fs.readFile(memoryPath(repoRoot), "utf-8");
    const parsed = JSON.parse(raw) as MemoryFile;
    if (parsed && parsed.version === 1 && parsed.repos) return parsed;
  } catch {
    // Missing or corrupt — start fresh (never throws on read).
  }
  return { version: 1, repos: {} };
}

/**
 * Serializes the file writes so two saves can't collide on the same tmp
 * file. Read-modify-write callers must themselves be sequential (the engine
 * stores memories one entry at a time).
 */
const memoryQueues = new Map<string, Promise<void>>();

async function saveMemoryFile(repoRoot: string, data: MemoryFile): Promise<void> {
  const p = memoryPath(repoRoot);
  const prev = memoryQueues.get(p) ?? Promise.resolve();
  const run = prev.then(
    () => writeMemoryFile(p, data),
    () => writeMemoryFile(p, data),
  );
  const guarded = run.catch(() => undefined);
  memoryQueues.set(p, guarded);
  await guarded;
}

async function writeMemoryFile(p: string, data: MemoryFile): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmp, p);
}

/** Mark entries stale whose referenced files changed after entry write. */
async function refreshStaleness(repoRoot: string, entries: MemoryEntry[]): Promise<boolean> {
  let changed = false;
  for (const e of entries) {
    if (e.stale || e.fileRefs.length === 0) continue;
    for (const rel of e.fileRefs) {
      try {
        const st = await fs.stat(path.join(repoRoot, rel));
        // Floor mtime to the same millisecond resolution as Date.now() so a
        // file written just before saving the entry isn't flagged stale by
        // sub-millisecond precision alone.
        if (Math.floor(st.mtimeMs) > e.updatedAt) {
          e.stale = true;
          changed = true;
          break;
        }
      } catch {
        // Referenced file gone → entry is questionable; mark stale.
        e.stale = true;
        changed = true;
        break;
      }
    }
  }
  return changed;
}

export interface SaveMemoryInput {
  kind: MemoryKind;
  content: string;
  fileRefs?: string[];
  source?: string;
}

/**
 * Store a memory entry. Returns the saved entry, or throws with a clear
 * reason when the content looks like a secret or is out of budget.
 */
export async function saveMemory(repoRoot: string, input: SaveMemoryInput): Promise<MemoryEntry> {
  const content = input.content.trim();
  if (!content) throw new Error("Memory content must be non-empty");
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error(
      `Memory too long (${content.length} > ${MAX_CONTENT_CHARS} chars) — keep it terse`,
    );
  }
  if (looksLikeSecret(content)) {
    throw new Error("Refusing to store content that looks like a secret (keys/tokens/passwords)");
  }

  const data = await loadMemoryFile(repoRoot);
  const key = path.resolve(repoRoot);
  const bucket = data.repos[key] ?? { entries: [] };

  // De-duplicate: same kind + identical content → refresh timestamp.
  const existing = bucket.entries.find((e) => e.kind === input.kind && e.content === content);
  if (existing) {
    existing.updatedAt = Date.now();
    existing.stale = false;
    if (input.fileRefs?.length) existing.fileRefs = input.fileRefs;
  } else {
    bucket.entries.push({
      id: crypto.randomUUID().slice(0, 12),
      kind: input.kind,
      content,
      fileRefs: input.fileRefs ?? [],
      updatedAt: Date.now(),
      ...(input.source ? { source: input.source } : {}),
    });
    // Cap: drop oldest by updatedAt.
    if (bucket.entries.length > MAX_ENTRIES_PER_REPO) {
      bucket.entries.sort((a, b) => b.updatedAt - a.updatedAt);
      bucket.entries.length = MAX_ENTRIES_PER_REPO;
    }
  }
  data.repos[key] = bucket;
  await saveMemoryFile(repoRoot, data);
  return existing ?? bucket.entries[bucket.entries.length - 1]!;
}

/**
 * Retrieve memories relevant to a query (token overlap + recency),
 * refreshing staleness flags along the way.
 */
export async function recallMemory(
  repoRoot: string,
  query: string,
  limit = 6,
): Promise<MemoryEntry[]> {
  const data = await loadMemoryFile(repoRoot);
  const bucket = data.repos[path.resolve(repoRoot)];
  if (!bucket || bucket.entries.length === 0) return [];

  const changed = await refreshStaleness(repoRoot, bucket.entries);
  if (changed) await saveMemoryFile(repoRoot, data);

  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  const now = Date.now();

  const scored = bucket.entries.map((e) => {
    const hay = (e.content + " " + e.fileRefs.join(" ")).toLowerCase();
    let score = tokens.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
    // Recency and freshness nudges; stale entries sink.
    const ageDays = (now - e.updatedAt) / 86_400_000;
    score += Math.max(0, 2 - ageDays / 14);
    if (e.stale) score -= 2;
    return { e, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.e);
}

/** Everything stored for a repo — for the inspect/correct UI. */
export async function listMemory(repoRoot: string): Promise<MemoryEntry[]> {
  const data = await loadMemoryFile(repoRoot);
  const bucket = data.repos[path.resolve(repoRoot)];
  if (!bucket) return [];
  await refreshStaleness(repoRoot, bucket.entries);
  return [...bucket.entries].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Correct an entry's content/kind (inspect-and-correct API). */
export async function updateMemoryEntry(
  repoRoot: string,
  id: string,
  patch: { content?: string; kind?: MemoryKind },
): Promise<MemoryEntry> {
  const data = await loadMemoryFile(repoRoot);
  const bucket = data.repos[path.resolve(repoRoot)];
  const entry = bucket?.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`Memory entry not found: ${id}`);
  if (patch.content !== undefined) {
    const content = patch.content.trim();
    if (!content) throw new Error("Memory content must be non-empty");
    if (looksLikeSecret(content)) {
      throw new Error("Refusing to store content that looks like a secret");
    }
    entry.content = content;
  }
  if (patch.kind !== undefined) entry.kind = patch.kind;
  entry.updatedAt = Date.now();
  entry.stale = false;
  await saveMemoryFile(repoRoot, data);
  return entry;
}

export async function deleteMemoryEntry(repoRoot: string, id: string): Promise<void> {
  const data = await loadMemoryFile(repoRoot);
  const bucket = data.repos[path.resolve(repoRoot)];
  if (!bucket) throw new Error(`Memory entry not found: ${id}`);
  const before = bucket.entries.length;
  bucket.entries = bucket.entries.filter((e) => e.id !== id);
  if (bucket.entries.length === before) {
    throw new Error(`Memory entry not found: ${id}`);
  }
  await saveMemoryFile(repoRoot, data);
}

/** Format memories as a prompt block (stale entries labelled as such). */
export function memoryToPrompt(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map(
    (e) => `- [${e.kind}${e.stale ? ", STALE — verify against source" : ""}] ${e.content}`,
  );
  return `\n\n## Project memory (verify against current source when it conflicts)\n${lines.join("\n")}`;
}
