/**
 * Pending user-choice registry (pure module — no router, no framework).
 *
 * The model asks a question with a fixed set of options ("pick one") and the
 * UI renders a card; the chat turn waits for the answer instead of guessing.
 * Resolutions:
 *   { choice: "..." }        — the user picked an option (or typed one)
 *   { cancelled: true }      — dismissed, or the turn was aborted
 *   { expired: true }        — nobody answered within 3 minutes
 */

export const PICK_TIMEOUT_MS = 180_000;

export type PickOutcome = { choice: string } | { cancelled: true } | { expired: true };

interface PendingPick {
  resolve: (outcome: PickOutcome) => void;
  prompt: string;
  options: string[];
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const pendingPicks = new Map<string, PendingPick>();

/** Opaque pick id — always a full UUID, never a truncation. */
export function mintPickId(): string {
  return crypto.randomUUID();
}

function settle(pickId: string, outcome: PickOutcome): boolean {
  const pending = pendingPicks.get(pickId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingPicks.delete(pickId);
  pending.resolve(outcome);
  return true;
}

/**
 * Register a pending pick. `options` must be non-empty; entries are trimmed and
 * de-duplicated so a card never shows the same choice twice.
 */
export function registerPick(params: {
  prompt: string;
  options: string[];
  pickId?: string;
}): Promise<PickOutcome> {
  const options: string[] = [];
  for (const raw of params.options) {
    const option = raw.trim();
    if (option.length > 0 && !options.includes(option)) options.push(option);
  }
  if (options.length === 0) {
    return Promise.resolve({ cancelled: true });
  }

  return new Promise((resolve) => {
    const pickId = params.pickId ?? mintPickId();
    const timer = setTimeout(() => settle(pickId, { expired: true }), PICK_TIMEOUT_MS);
    pendingPicks.set(pickId, {
      resolve,
      prompt: params.prompt,
      options,
      createdAt: Date.now(),
      timer,
    });
  });
}

/** Answer a pending pick. Returns false when the id is unknown or expired. */
export function resolvePick(pickId: string, choice: string): boolean {
  const pending = pendingPicks.get(pickId);
  if (!pending) return false;
  const match = pending.options.find((o) => o.toLowerCase() === choice.trim().toLowerCase());
  return settle(pickId, { choice: match ?? choice.trim() });
}

/** Dismiss a pending pick without choosing (the user closed the card). */
export function cancelPick(pickId: string): boolean {
  return settle(pickId, { cancelled: true });
}

/** Abort every pick that belongs to an interrupted turn. */
export function cancelAllPicks(): void {
  for (const pickId of [...pendingPicks.keys()]) settle(pickId, { cancelled: true });
}

export function getPendingPick(pickId: string): { prompt: string; options: string[] } | null {
  const pending = pendingPicks.get(pickId);
  return pending ? { prompt: pending.prompt, options: pending.options } : null;
}

export function pendingPickCount(): number {
  return pendingPicks.size;
}
