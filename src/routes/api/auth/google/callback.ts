/**
 * GET /api/auth/google/callback — Google redirects here with ?code=...
 * Exchanges the code for tokens and stores them.
 */

import { createFileRoute } from "@tanstack/react-router";
import { exchangeGoogleCode } from "../../../../functions/google-auth";

export const Route = createFileRoute("/api/auth/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");

        if (error || !code) {
          return new Response("Google sign-in failed: " + (error ?? "no code returned"), { status: 400 });
        }

        try {
          await exchangeGoogleCode({ data: code });
        } catch (e) {
          return new Response("Token exchange failed: " + (e as Error).message, { status: 500 });
        }

        return Response.redirect(url.origin + "/", 302);
      },
    },
  },
});
