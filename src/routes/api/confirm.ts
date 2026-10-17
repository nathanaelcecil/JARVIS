/**
 * POST /api/confirm — Receive user decision on confirm-tier tool execution.
 *
 * Body: { confirmId: string, approved: boolean }
 *
 * The stream.ts endpoint creates a pending confirmation Promise keyed by confirmId.
 * This endpoint resolves that Promise with the user's decision.
 */

import { createFileRoute } from "@tanstack/react-router";

/**
 * approved  — the user clicked Approve
 * denied    — the user clicked Deny
 * expired   — nobody answered in time (NOT a user denial; must never be
 *             reported back as "denied by you" — people get distracted, e.g.
 *             approving Google consent in another tab while a prompt waits)
 */
export type ConfirmDecision = "approved" | "denied" | "expired";

// Map of pending confirmations: confirmId -> { resolve, tool, args }
const pendingConfirmations = new Map<
  string,
  {
    resolve: (decision: ConfirmDecision) => void;
    tool: string;
    args: Record<string, unknown>;
    createdAt: number;
  }
>();

/** Register a new pending confirmation. Resolves with the user's decision. */
export function registerConfirmation(params: {
  tool: string;
  args: Record<string, unknown>;
  confirmId?: string;
}): Promise<ConfirmDecision> {
  return new Promise((resolve) => {
    const confirmId = params.confirmId ?? crypto.randomUUID().slice(0, 8);
    pendingConfirmations.set(confirmId, {
      resolve,
      tool: params.tool,
      args: params.args,
      createdAt: Date.now(),
    });

    // Auto-expire after 3 minutes — long enough to read the prompt, switch
    // tabs (e.g. Google consent) and come back. Expiry is reported as
    // "timed out", never as a denial by the user.
    setTimeout(() => {
      const pending = pendingConfirmations.get(confirmId);
      if (pending) {
        pending.resolve("expired");
        pendingConfirmations.delete(confirmId);
      }
    }, 180_000);
  });
}

/** Get pending confirmation details (for the UI to display) */
export function getPendingConfirmation(confirmId: string) {
  return pendingConfirmations.get(confirmId);
}

export const Route = createFileRoute("/api/confirm")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json();
        const { confirmId, approved } = body as {
          confirmId: string;
          approved: boolean;
        };

        if (!confirmId) {
          return Response.json({ error: "Missing confirmId" }, { status: 400 });
        }

        const pending = pendingConfirmations.get(confirmId);
        if (!pending) {
          return Response.json(
            { error: "Confirmation not found or expired" },
            { status: 404 }
          );
        }

        const decision: ConfirmDecision = approved ? "approved" : "denied";
        pending.resolve(decision);
        pendingConfirmations.delete(confirmId);

        return Response.json({ success: true, approved, decision });
      },
    },
  },
});
