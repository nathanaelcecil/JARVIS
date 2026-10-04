/**
 * POST /api/confirm — Receive user decision on confirm-tier tool execution.
 *
 * Body: { confirmId: string, approved: boolean }
 *
 * The stream.ts endpoint creates a pending confirmation Promise keyed by confirmId.
 * This endpoint resolves that Promise with the user's decision.
 */

import { createFileRoute } from "@tanstack/react-router";

// Map of pending confirmations: confirmId -> { resolve, tool, args }
const pendingConfirmations = new Map<
  string,
  {
    resolve: (approved: boolean) => void;
    tool: string;
    args: Record<string, unknown>;
    createdAt: number;
  }
>();

/** Register a new pending confirmation. Returns the confirmId. */
export function registerConfirmation(params: {
  tool: string;
  args: Record<string, unknown>;
  confirmId?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const confirmId = params.confirmId ?? crypto.randomUUID().slice(0, 8);
    pendingConfirmations.set(confirmId, {
      resolve,
      tool: params.tool,
      args: params.args,
      createdAt: Date.now(),
    });

    // Auto-deny after 60 seconds
    setTimeout(() => {
      const pending = pendingConfirmations.get(confirmId);
      if (pending) {
        pending.resolve(false);
        pendingConfirmations.delete(confirmId);
      }
    }, 60_000);
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

        pending.resolve(approved);
        pendingConfirmations.delete(confirmId);

        return Response.json({ success: true, approved });
      },
    },
  },
});
