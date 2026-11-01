import { describe, expect, it } from "vitest";
import {
  allowedOriginConfig,
  evaluateLocalRequest,
  guardLocalRequest,
} from "./local-request-guard";

const config = allowedOriginConfig({});

function decide(overrides: Partial<Parameters<typeof evaluateLocalRequest>[0]>) {
  return evaluateLocalRequest(
    {
      host: "localhost:3000",
      origin: null,
      secFetchSite: null,
      method: "POST",
      ...overrides,
    },
    config,
  );
}

describe("Host header (DNS rebinding)", () => {
  it("accepts loopback hosts on the app port", () => {
    expect(decide({ host: "localhost:3000" }).ok).toBe(true);
    expect(decide({ host: "127.0.0.1:3000" }).ok).toBe(true);
    expect(decide({ host: "[::1]:3000" }).ok).toBe(true);
    expect(decide({ host: "LOCALHOST:3000" }).ok).toBe(true);
    expect(decide({ host: "localhost:4173" }).ok).toBe(true);
  });

  it("rejects a rebinding hostname even when its Origin looks local", () => {
    const result = decide({
      host: "evil.example:3000",
      origin: "http://evil.example:3000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("rejects a port the app does not serve", () => {
    expect(decide({ host: "localhost:3001", origin: null }).ok).toBe(false);
    expect(decide({ host: "127.0.0.1:8080" }).ok).toBe(false);
  });

  it("rejects a missing or malformed Host", () => {
    expect(decide({ host: null }).ok).toBe(false);
    expect(decide({ host: "" }).ok).toBe(false);
    expect(decide({ host: "localhost" }).ok).toBe(false);
    expect(decide({ host: "[::1" }).ok).toBe(false);
  });
});

describe("Origin header (cross-site requests)", () => {
  it("accepts an exact same-origin match", () => {
    expect(decide({ origin: "http://localhost:3000" }).ok).toBe(true);
    expect(decide({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }).ok).toBe(true);
    expect(decide({ host: "[::1]:3000", origin: "http://[::1]:3000" }).ok).toBe(true);
  });

  it("rejects a hostile origin", () => {
    for (const origin of [
      "https://evil.example",
      "http://evil.example:3000",
      "http://localhost:3001",
      "null",
      "file://",
    ]) {
      const result = decide({ origin });
      expect(result.ok, origin).toBe(false);
    }
  });

  it("normalizes a trailing slash in Origin", () => {
    expect(decide({ origin: "http://localhost:3000/" }).ok).toBe(true);
  });
});

describe("Origin absent table", () => {
  it("allows a server-to-server POST (no Origin, no Sec-Fetch-Site)", () => {
    expect(decide({ method: "POST", origin: null, secFetchSite: null }).ok).toBe(true);
  });

  it("allows same-origin and none", () => {
    expect(decide({ method: "POST", secFetchSite: "same-origin" }).ok).toBe(true);
    expect(decide({ method: "POST", secFetchSite: "none" }).ok).toBe(true);
  });

  it("rejects cross-site and same-site on state-changing methods", () => {
    expect(decide({ method: "POST", secFetchSite: "cross-site" }).ok).toBe(false);
    expect(decide({ method: "POST", secFetchSite: "same-site" }).ok).toBe(false);
    expect(decide({ method: "DELETE", secFetchSite: "cross-site" }).ok).toBe(false);
  });

  it("allows non-state-changing methods", () => {
    expect(decide({ method: "GET", secFetchSite: "cross-site" }).ok).toBe(true);
    expect(decide({ method: "HEAD", secFetchSite: "cross-site" }).ok).toBe(true);
  });
});

describe("JARVIS_ALLOWED_ORIGINS", () => {
  it("adds an extra loopback origin and its port", () => {
    const extended = allowedOriginConfig({
      JARVIS_ALLOWED_ORIGINS: "http://localhost:4321",
    });
    expect(
      evaluateLocalRequest(
        {
          host: "localhost:4321",
          origin: "http://localhost:4321",
          secFetchSite: null,
          method: "POST",
        },
        extended,
      ).ok,
    ).toBe(true);
    // The extra port is not available to a non-matching origin.
    expect(
      evaluateLocalRequest(
        {
          host: "localhost:4321",
          origin: "https://evil.example",
          secFetchSite: null,
          method: "POST",
        },
        extended,
      ).ok,
    ).toBe(false);
  });

  it("ignores non-loopback and malformed entries", () => {
    const extended = allowedOriginConfig({
      JARVIS_ALLOWED_ORIGINS: "https://evil.example,not a url,http://localhost:9999",
    });
    expect(extended.origins).not.toContain("https://evil.example");
    expect(extended.origins).toContain("http://localhost:9999");
  });
});

describe("guardLocalRequest", () => {
  it("passes a valid streaming request through untouched", () => {
    const request = new Request("http://localhost:3000/api/stream", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
        accept: "text/event-stream",
      },
      body: "{}",
    });
    expect(guardLocalRequest(request)).toBeNull();
  });

  it("returns a 403 JSON response for a hostile origin", () => {
    const request = new Request("http://localhost:3000/api/confirm", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "https://evil.example" },
      body: "{}",
    });
    const response = guardLocalRequest(request);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(403);
  });

  it("does not leak internal details in the error", async () => {
    const request = new Request("http://localhost:3000/api/transcribe", {
      method: "POST",
      headers: { host: "evil.example:3000" },
      body: "{}",
    });
    const response = guardLocalRequest(request);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("forbidden_origin");
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
  });
});
