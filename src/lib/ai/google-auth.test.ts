/**
 * getValidAccessToken — scope gate so writes fail with an actionable message
 * instead of a raw Google 403 when the grant predates the new scopes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  loadGoogleTokens: vi.fn(),
  saveGoogleTokens: vi.fn(),
  hasValidGoogleTokens: vi.fn(),
}));

vi.mock("../../lib/google/token-store", () => ({
  loadGoogleTokens: mocks.loadGoogleTokens,
  saveGoogleTokens: mocks.saveGoogleTokens,
  hasValidGoogleTokens: mocks.hasValidGoogleTokens,
}));

const OLD_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly";
const FULL_SCOPE =
  OLD_SCOPE +
  " https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events";

function tokens(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    tokenType: "Bearer",
    expiryDate: Date.now() + 60 * 60 * 1000,
    scope: OLD_SCOPE,
    ...overrides,
  };
}

describe("getValidAccessToken", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.loadGoogleTokens.mockReset();
  });

  it("fails with the reconnect URL when required scopes are missing", async () => {
    mocks.loadGoogleTokens.mockResolvedValue(tokens());
    const { getValidAccessToken } = await import("../../functions/google-auth");
    await expect(
      getValidAccessToken(["https://www.googleapis.com/auth/gmail.send"])
    ).rejects.toThrow(/new Google permissions.*\/api\/auth\/google/s);
    // Reads (no required scopes) still work with the old grant.
    await expect(getValidAccessToken()).resolves.toBe("access-1");
  });

  it("returns the token when the scopes are granted", async () => {
    mocks.loadGoogleTokens.mockResolvedValue(tokens({ scope: FULL_SCOPE }));
    const { getValidAccessToken } = await import("../../functions/google-auth");
    await expect(
      getValidAccessToken([
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/calendar.events",
      ])
    ).resolves.toBe("access-1");
  });

  it("tells the user to connect when no token is stored", async () => {
    mocks.loadGoogleTokens.mockResolvedValue(null);
    const { getValidAccessToken } = await import("../../functions/google-auth");
    await expect(getValidAccessToken()).rejects.toThrow(/Not authenticated with Google/);
  });
});
