/**
 * GET  /api/proactive — frontend poll: return pending initiative messages
 *                         (and make sure the scheduler is running).
 * POST /api/proactive — background task finished callback (from the local agent):
 *                         { jobId, label, exitCode, summary? }
 *                       Creates an immediate task-completion message.
 *
 * Delivery: GET returns messages → frontend appends to chat + speaks them.
 * The macOS banner is fired separately by the scheduler (or immediately here
 * for task callbacks).
 */

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/proactive")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { ensureProactiveScheduler, runProactiveTick } = await import(
            "../../lib/proactive/scheduler"
          );
          ensureProactiveScheduler();
          // Don't wait a full 15s for a message that may already be due
          await runProactiveTick();

          const { getPendingMessages } = await import(
            "../../functions/proactive"
          );
          const messages = await getPendingMessages();
          return Response.json({ messages });
        } catch (err) {
          console.error("[Proactive] poll failed:", err);
          return Response.json(
            { error: err instanceof Error ? err.message : "poll failed" },
            { status: 500 }
          );
        }
      },

      POST: async ({ request }) => {
        try {
          const body = await request.json();
          const { jobId, label, exitCode, summary } = body as {
            jobId?: string;
            label?: string;
            exitCode?: number;
            summary?: string;
          };

          if (!jobId || typeof exitCode !== "number") {
            return Response.json(
              { error: "Missing jobId or exitCode" },
              { status: 400 }
            );
          }

          const { reportTaskCompletion } = await import(
            "../../functions/proactive"
          );
          const schedule = await reportTaskCompletion({
            jobId,
            label: label ?? jobId,
            exitCode,
            summary,
          });

          // Fire it right away instead of waiting for the 15s tick
          const { runProactiveTick } = await import(
            "../../lib/proactive/scheduler"
          );
          await runProactiveTick();

          return Response.json({ success: true, scheduleId: schedule.id });
        } catch (err) {
          console.error("[Proactive] task callback failed:", err);
          return Response.json(
            { error: err instanceof Error ? err.message : "callback failed" },
            { status: 500 }
          );
        }
      },
    },
  },
});
