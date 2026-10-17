/**
 * GET /api/auth/google — Starts Google sign-in by redirecting to Google's consent screen.
 */

import { createFileRoute } from "@tanstack/react-router";
import { getGoogleAuthUrl } from "../../../functions/google-auth";

export const Route = createFileRoute("/api/auth/google")({
  server: {
    handlers: {
      GET: async () => {
        const result = await getGoogleAuthUrl();
        if ("error" in result) {
          return new Response(result.error, { status: 500 });
        }
        return Response.redirect(result.url, 302);
      },
    },
  },
});
