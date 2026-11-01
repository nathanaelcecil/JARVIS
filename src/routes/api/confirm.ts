/**
 * POST /api/confirm — Receive user decision on confirm-tier tool execution.
 *
 * Body: { confirmId: string, approved: boolean }
 *
 * The stream/engine authorization path registers a pending confirmation keyed
 * by confirmId; this endpoint resolves it with the user's decision.
 */

import { createFileRoute } from "@tanstack/react-router";
import {
  getPendingConfirmation,
  mintConfirmId,
  registerConfirmation,
  resolveConfirmation,
  type ConfirmDecision,
} from "../../lib/confirmations";
import { guardLocalRequest } from "../../lib/local-request-guard";

// Re-exported for existing importers (stream.ts, tests).
export { getPendingConfirmation, mintConfirmId, registerConfirmation };
export type { ConfirmDecision };

export const Route = createFileRoute("/api/confirm")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const blocked = guardLocalRequest(request);
        if (blocked) return blocked;
        const body = await request.json();
        const { confirmId, approved } = body as {
          confirmId: string;
          approved: boolean;
        };

        if (!confirmId) {
          return Response.json({ error: "Missing confirmId" }, { status: 400 });
        }

        const pending = getPendingConfirmation(confirmId);
        if (!pending) {
          return Response.json({ error: "Confirmation not found or expired" }, { status: 404 });
        }

        const decision: ConfirmDecision = approved ? "approved" : "denied";
        resolveConfirmation(confirmId, decision);

        return Response.json({ success: true, approved, decision });
      },
    },
  },
});
