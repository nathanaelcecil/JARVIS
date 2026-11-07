/**
 * Pending confirmation registry (pure module — no router, no framework).
 *
 * `approved` — the user clicked Approve.
 * `denied`  — the user clicked Deny.
 * `expired` — nobody answered within 3 minutes. NEVER reported as a denial:
 *             people get distracted (e.g. approving Google consent in another
 *             tab) and being told "you denied it" is a lie.
 * `cancelled` — the task was aborted while the prompt was pending.
 */

export type ConfirmDecision = "approved" | "denied" | "expired" | "cancelled";

export const CONFIRMATION_TIMEOUT_MS = 180_000;

interface PendingConfirmation {
  resolve: (decision: ConfirmDecision) => void;
  tool: string;
  args: Record<string, unknown>;
  /** Chat turn this prompt belongs to, for "always allow for this task". */
  taskId?: string | undefined;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();

/**
 * Opaque confirmation id. Always the FULL UUID: truncating to 8 hex chars
 * made collisions plausible across a long session.
 */
export function mintConfirmId(): string {
  return crypto.randomUUID();
}

function settle(confirmId: string, decision: ConfirmDecision): boolean {
  const pending = pendingConfirmations.get(confirmId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingConfirmations.delete(confirmId);
  pending.resolve(decision);
  return true;
}

/** Register a new pending confirmation. Resolves with the user's decision. */
export function registerConfirmation(params: {
  tool: string;
  args: Record<string, unknown>;
  confirmId?: string;
  /** When set, the UI may offer to allow this tool for the rest of the task. */
  taskId?: string | undefined;
}): Promise<ConfirmDecision> {
  return new Promise((resolve) => {
    const confirmId = params.confirmId ?? mintConfirmId();
    // Auto-expire — long enough to read the prompt, switch tabs (e.g. Google
    // consent) and come back. Expiry is "timed out", never "denied by you".
    const timer = setTimeout(() => {
      settle(confirmId, "expired");
    }, CONFIRMATION_TIMEOUT_MS);

    pendingConfirmations.set(confirmId, {
      resolve,
      tool: params.tool,
      args: params.args,
      taskId: params.taskId,
      createdAt: Date.now(),
      timer,
    });
  });
}

/**
 * Cancel a pending confirmation (task abort). Resolves it as `cancelled` and
 * removes the entry, so a late click gets a 404 rather than a false denial.
 */
export function cancelConfirmation(confirmId: string): boolean {
  return settle(confirmId, "cancelled");
}

/** Resolve a pending confirmation from a user decision (POST /api/confirm). */
export function resolveConfirmation(confirmId: string, decision: ConfirmDecision): boolean {
  return settle(confirmId, decision);
}

/** Get pending confirmation details (for the UI to display). */
export function getPendingConfirmation(confirmId: string) {
  return pendingConfirmations.get(confirmId);
}

/** Number of pending confirmations (test/diagnostic aid). */
export function pendingConfirmationCount(): number {
  return pendingConfirmations.size;
}
