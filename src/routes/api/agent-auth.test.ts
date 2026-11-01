/**
 * /api/agent is the only control plane that can start file-modifying work.
 * It must reject any request without the exact bearer token.
 *
 * These tests only assert the 401 rejections, so they never need the real
 * token value (and never print it). `requireAgentAuth` will create the token
 * file on first use — which is git-ignored, same as the real bootstrap.
 */
import { describe, it, expect } from "vitest";
import { requireAgentAuth } from "./agent";

function req(authHeader: string | null): Request {
  return new Request("http://127.0.0.1:3000/api/agent", {
    method: "GET",
    ...(authHeader === null ? {} : { headers: { authorization: authHeader } }),
  });
}

describe("requireAgentAuth", () => {
  it("401s when the Authorization header is missing", async () => {
    const res = await requireAgentAuth(req(null));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("401s when the header is not a bearer token", async () => {
    const res = await requireAgentAuth(req("Basic Zm9vOmJhcg=="));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("401s for a wrong bearer token", async () => {
    const res = await requireAgentAuth(req("Bearer definitely-not-the-real-token-000000000000"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("401s for an empty bearer token", async () => {
    const res = await requireAgentAuth(req("Bearer "));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("401s for a right-length but wrong token (constant-time compare path)", async () => {
    // The real token is 64 hex chars; this exercises the timingSafeEqual branch
    // without ever knowing or printing the real value.
    const wrong = "f".repeat(64);
    const res = await requireAgentAuth(req(`Bearer ${wrong}`));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });
});
