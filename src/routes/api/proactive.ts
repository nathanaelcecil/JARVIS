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
import { guardLocalRequest } from "../../lib/local-request-guard";

export const Route = createFileRoute("/api/proactive")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const blocked = guardLocalRequest(request);
        if (blocked) return blocked;
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

          // Routine prompts are drained separately: they are requests to run,
          // not messages JARVIS said. They are file-backed so they survive
          // Supabase being unconfigured.
          let routines: unknown[] = [];
          try {
            const { popOutbox } = await import("../../lib/automation/routines");
            routines = await popOutbox(process.cwd());
          } catch (err) {
            console.error("[Proactive] routine outbox failed:", err);
          }

          return Response.json({ messages, routines });
        } catch (err) {
          console.error("[Proactive] poll failed:", err);
          return Response.json(
            { error: err instanceof Error ? err.message : "poll failed" },
            { status: 500 }
          );
        }
      },

      POST: async ({ request }) => {
        // Allows the local agent's server-to-server callback (no Origin, no
        // Sec-Fetch-Site) while rejecting cross-site browser posts.
        const blocked = guardLocalRequest(request);
        if (blocked) return blocked;
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
