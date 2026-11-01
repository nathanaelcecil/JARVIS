/**
 * Learned procedures — the "say it once, then it just happens" capability.
 *
 * Atticus learns a shortcut from a verified multi-step success and later replays
 * it with no model in the loop. JARVIS does the same, but the safety rule is
 * stricter and enforced here rather than by the model: a procedure may only
 * contain tools that are *never* blocked, and it may not contain a step whose
 * arguments look destructive. Steps that still need an approval (confirm tier)
 * stay in the procedure — they simply keep asking when they replay, which is
 * the honest behaviour: a click is not something to pre-authorise forever.
 *
 * Matching is exact after normalisation. That is deliberate: a fuzzy match that
 * replays the wrong procedure is worse than no match at all.
 */

import { mutateJson, readJson } from "./store";

export const PROCEDURES_FILE = "procedures.json";
export const MAX_PROCEDURES = 100;
export const MAX_STEPS = 12;

export interface ProcedureStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface Procedure {
  /** Normalised trigger; also the store key. */
  key: string;
  /** The phrase as the user said it. */
  trigger: string;
  steps: ProcedureStep[];
  createdAt: number;
  uses: number;
  lastUsedAt: number | null;
}

interface ProceduresFile {
  version: 1;
  procedures: Procedure[];
}

const EMPTY: ProceduresFile = { version: 1, procedures: [] };

/** Words that never belong in a replayable step. */
const DESTRUCTIVE =
  /\b(rm|rmdir|sudo|mkfs|dd|shutdown|reboot|halt|diskutil|erase|format|uninstall|git push)\b/i;
const DESTRUCTIVE_TOOLS = /^(system\.shutdown|git\.push)$/i;

/**
 * Normalise a trigger phrase: case, punctuation and a leading "hey jarvis" are
 * not part of what the user meant.
 */
export function normalizeTrigger(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\s*(?:hey|ok|okay)?\s*jarvis[,: ]+/i, "")
    .replace(/[“”"'`]/g, "")
    .replace(/[.!?,;:]+$/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type ReplayVerdict = { safe: true } | { safe: false; reason: string; stepIndex?: number };

/**
 * Decide whether a step list may be stored and replayed.
 *
 * `tierOf` is injected so this stays usable outside the server (tests pass a
 * stub); the default is the real permission table.
 */
export function isReplaySafe(
  steps: ProcedureStep[],
  tierOf: (tool: string) => "auto" | "confirm" | "never",
): ReplayVerdict {
  if (steps.length === 0) return { safe: false, reason: "a procedure needs at least one step" };
  if (steps.length > MAX_STEPS) {
    return { safe: false, reason: `at most ${MAX_STEPS} steps can be replayed` };
  }
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step.tool !== "string" || !step.tool.trim()) {
      return { safe: false, reason: "every step needs a tool name", stepIndex: index };
    }
    if (tierOf(step.tool) === "never") {
      return {
        safe: false,
        reason: `${step.tool} is blocked by policy and can never be replayed`,
        stepIndex: index,
      };
    }
    if (DESTRUCTIVE_TOOLS.test(step.tool)) {
      return { safe: false, reason: `${step.tool} is never replayable`, stepIndex: index };
    }
    const args = step.args ?? {};
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      return { safe: false, reason: "step arguments must be an object", stepIndex: index };
    }
    const flat = JSON.stringify(args);
    if (DESTRUCTIVE.test(flat)) {
      return {
        safe: false,
        reason: `step ${index + 1} looks destructive and cannot be replayed without you`,
        stepIndex: index,
      };
    }
  }
  return { safe: true };
}

/** Store (or replace) a procedure for a trigger phrase. */
export async function recordProcedure(params: {
  root: string;
  trigger: string;
  steps: ProcedureStep[];
  tierOf: (tool: string) => "auto" | "confirm" | "never";
  now?: Date;
}): Promise<Procedure> {
  const key = normalizeTrigger(params.trigger);
  if (!key) throw new Error("a procedure needs a phrase to trigger it");

  const verdict = isReplaySafe(params.steps, params.tierOf);
  if (!verdict.safe) throw new Error(verdict.reason);

  const now = (params.now ?? new Date()).getTime();
  const procedure: Procedure = {
    key,
    trigger: params.trigger.trim(),
    steps: params.steps.map((step) => ({ tool: step.tool, args: { ...step.args } })),
    createdAt: now,
    uses: 0,
    lastUsedAt: null,
  };

  await mutateJson<ProceduresFile>(params.root, PROCEDURES_FILE, EMPTY, (file) => {
    const procedures = file.version === 1 && Array.isArray(file.procedures) ? file.procedures : [];
    const without = procedures.filter((entry) => entry.key !== key);
    if (!procedures.some((entry) => entry.key === key) && procedures.length >= MAX_PROCEDURES) {
      throw new Error(`there are already ${MAX_PROCEDURES} procedures; forget one first`);
    }
    // A re-recording keeps its usage history: it is the same phrase.
    const previous = procedures.find((entry) => entry.key === key);
    const merged = previous
      ? { ...procedure, uses: previous.uses, createdAt: previous.createdAt }
      : procedure;
    return { version: 1, procedures: [...without, merged] };
  });

  return procedure;
}

/** Exact (normalised) lookup. Returns null rather than a fuzzy guess. */
export async function matchProcedure(root: string, text: string): Promise<Procedure | null> {
  const key = normalizeTrigger(text);
  if (!key) return null;
  const file = await readJson<ProceduresFile>(root, PROCEDURES_FILE, EMPTY);
  const procedures = file.version === 1 && Array.isArray(file.procedures) ? file.procedures : [];
  return procedures.find((entry) => entry.key === key) ?? null;
}

/** Count a use so the listing can show which procedures actually earn their keep. */
export async function markUsed(root: string, key: string, now: Date = new Date()): Promise<void> {
  await mutateJson<ProceduresFile>(root, PROCEDURES_FILE, EMPTY, (file) => {
    const procedures = file.version === 1 && Array.isArray(file.procedures) ? file.procedures : [];
    return {
      version: 1,
      procedures: procedures.map((entry) =>
        entry.key === key ? { ...entry, uses: entry.uses + 1, lastUsedAt: now.getTime() } : entry,
      ),
    };
  });
}

export async function listProcedures(root: string): Promise<Procedure[]> {
  const file = await readJson<ProceduresFile>(root, PROCEDURES_FILE, EMPTY);
  const procedures = file.version === 1 && Array.isArray(file.procedures) ? file.procedures : [];
  return [...procedures].sort((a, b) => b.uses - a.uses || b.createdAt - a.createdAt);
}

/** Forget a procedure by its phrase (or its normalised key). */
export async function forgetProcedure(root: string, trigger: string): Promise<boolean> {
  const key = normalizeTrigger(trigger);
  let removed = false;
  await mutateJson<ProceduresFile>(root, PROCEDURES_FILE, EMPTY, (file) => {
    const procedures = file.version === 1 && Array.isArray(file.procedures) ? file.procedures : [];
    const kept = procedures.filter((entry) => entry.key !== key);
    removed = kept.length !== procedures.length;
    return { version: 1, procedures: kept };
  });
  return removed;
}
