/**
 * POST /api/pick — Answer a pending "pick one" card from the model.
 *
 * Body: { pickId: string, choice: string } | { pickId: string, cancel: true }
 *
 * `ask_user` pauses the chat turn until the user answers; this endpoint hands
 * the choice back to the waiting stream.
 */

import { createFileRoute } from "@tanstack/react-router";
import { cancelPick, resolvePick } from "../../lib/picks";
import { guardLocalRequest } from "../../lib/local-request-guard";

export const Route = createFileRoute("/api/pick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const blocked = guardLocalRequest(request);
        if (blocked) return blocked;

        const body = await request.json();
        const { pickId, choice, cancel } = body as {
          pickId?: string;
          choice?: string;
          cancel?: boolean;
        };

        if (!pickId) {
          return Response.json({ error: "Missing pickId" }, { status: 400 });
        }

        if (cancel === true) {
          const dismissed = cancelPick(pickId);
          return dismissed
            ? Response.json({ success: true, cancelled: true })
            : Response.json({ error: "Pick not found or expired" }, { status: 404 });
        }

        if (typeof choice !== "string" || choice.trim().length === 0) {
          return Response.json({ error: "Missing choice" }, { status: 400 });
        }

        const answered = resolvePick(pickId, choice);
        if (!answered) {
          return Response.json({ error: "Pick not found or expired" }, { status: 404 });
        }

        return Response.json({ success: true, choice: choice.trim() });
      },
    },
  },
});
