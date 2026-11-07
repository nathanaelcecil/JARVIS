/**
 * POST /api/confirm — Receive user decision on confirm-tier tool execution.
 *
 * Body: { confirmId: string, approved: boolean, scope?: "once" | "task" }
 *
 * scope "task" additionally remembers the tool for the rest of that chat turn
 * ("always allow type for this task"), so the next identical prompt is skipped.
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
import { allowToolForTask } from "../../lib/task-approvals";

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
        const { confirmId, approved, scope } = body as {
          confirmId: string;
          approved: boolean;
          scope?: "once" | "task";
        };

        if (!confirmId) {
          return Response.json({ error: "Missing confirmId" }, { status: 400 });
        }

        const pending = getPendingConfirmation(confirmId);
        if (!pending) {
          return Response.json({ error: "Confirmation not found or expired" }, { status: 404 });
        }

        // Widening scope happens only on an approval and only when the prompt
        // carried a task id — a plain Approve stays single-use.
        const forTask = approved && scope === "task" && Boolean(pending.taskId);
        if (forTask) allowToolForTask(pending.taskId!, pending.tool);

        const decision: ConfirmDecision = approved ? "approved" : "denied";
        resolveConfirmation(confirmId, decision);

        return Response.json({
          success: true,
          approved,
          decision,
          scope: forTask ? "task" : "once",
        });
      },
    },
  },
});
