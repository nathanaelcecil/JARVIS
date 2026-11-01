/**
 * Local agent boundary tests: bearer auth, argument validation, and
 * approval-token enforcement. Uses the real factory over an ephemeral
 * 127.0.0.1 port with fake tool handlers — no Playwright, no secret files.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createAgentServer, type AgentServerConfig, type ToolHandler } from "./server";
import { mintApprovalToken } from "./approval";

const SECRET = "bearer-secret-for-tests";
const APPROVAL_KEY = "a".repeat(64);

const openApp = vi.fn(() => ({ success: true, app: "Safari" }));
const listDirectory = vi.fn(() => ({ success: true, path: "/tmp", entries: [] }));
const runCommand = vi.fn(() => ({ success: true, stdout: "ok" }));
const getVolume = vi.fn(() => ({ success: true, volume: 10 }));

const TOOLS: Record<string, ToolHandler> = {
  open_app: openApp,
  list_directory: listDirectory,
  run_command: runCommand,
  get_volume: getVolume,
};

interface Harness {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

async function start(overrides: Partial<AgentServerConfig> = {}): Promise<Harness> {
  const { tools, ...rest } = overrides;
  const server = createAgentServer({
    secret: SECRET,
    approvalKey: APPROVAL_KEY,
    tools: tools ?? TOOLS,
    log: () => {},
    ...rest,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let harness: Harness | null = null;

afterEach(async () => {
  openApp.mockClear();
  listDirectory.mockClear();
  runCommand.mockClear();
  getVolume.mockClear();
  if (harness) await harness.close();
  harness = null;
});

async function call(
  url: string,
  body: unknown,
  options: { secret?: string | null; raw?: boolean } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.secret !== null) headers["Authorization"] = `Bearer ${options.secret ?? SECRET}`;
  const res = await fetch(`${url}/call`, {
    method: "POST",
    headers,
    body: options.raw ? String(body) : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

describe("bearer auth", () => {
  it("serves /health without auth", async () => {
    harness = await start();
    const res = await fetch(`${harness.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; tools: number };
    expect(body.status).toBe("ok");
    expect(body.tools).toBe(4);
  });

  it("rejects a missing or wrong bearer secret", async () => {
    harness = await start();
    const missing = await call(
      harness.url,
      { tool: "list_directory", args: { path: "/tmp" } },
      { secret: null },
    );
    expect(missing.status).toBe(401);
    const wrong = await call(
      harness.url,
      { tool: "list_directory", args: { path: "/tmp" } },
      { secret: "nope" },
    );
    expect(wrong.status).toBe(401);
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("runs auto-tier tools with a valid bearer", async () => {
    harness = await start();
    const res = await call(harness.url, { tool: "list_directory", args: { path: "/tmp" } });
    expect(res.status).toBe(200);
    expect(listDirectory).toHaveBeenCalledTimes(1);
  });
});

describe("argument validation runs before handlers", () => {
  it("returns 404 for unknown tools", async () => {
    harness = await start();
    const res = await call(harness.url, { tool: "not_a_tool", args: {} });
    expect(res.status).toBe(404);
  });

  it("rejects unknown argument keys with 400", async () => {
    harness = await start();
    const res = await call(harness.url, {
      tool: "list_directory",
      args: { path: "/tmp", extra: "value" },
    });
    expect(res.status).toBe(400);
    expect(res.json["error"]).toBe("invalid_arguments");
    expect(res.json["field"]).toBe("extra");
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("rejects wrong types and missing required args", async () => {
    harness = await start();
    const wrongType = await call(harness.url, { tool: "list_directory", args: { path: 123 } });
    expect(wrongType.status).toBe(400);
    expect(wrongType.json["field"]).toBe("path");

    const missing = await call(harness.url, { tool: "list_directory", args: {} });
    expect(missing.status).toBe(400);
    expect(missing.json["field"]).toBe("path");
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("rejects hostile app names with 400", async () => {
    harness = await start();
    const res = await call(harness.url, {
      tool: "open_app",
      args: { name: 'Safari"; touch /tmp/sentinel; echo "' },
    });
    expect(res.status).toBe(400);
    expect(res.json["error"]).toBe("invalid_arguments");
    expect(openApp).not.toHaveBeenCalled();
  });

  it("rejects non-object bodies", async () => {
    harness = await start();
    const res = await call(harness.url, "[1,2,3]");
    expect(res.status).toBe(400);
  });

  it("rejects oversized bodies with 413", async () => {
    harness = await start({ maxBodyBytes: 128 });
    const res = await call(harness.url, {
      tool: "list_directory",
      args: { path: "/" + "a".repeat(400) },
    });
    expect(res.status).toBe(413);
    expect(listDirectory).not.toHaveBeenCalled();
  });
});

describe("approval tokens", () => {
  it("refuses confirm-tier tools when no approval key is configured", async () => {
    harness = await start({ approvalKey: null });
    const res = await call(harness.url, { tool: "open_app", args: { name: "Safari" } });
    expect(res.status).toBe(401);
    expect(res.json["error"]).toBe("approval_required");
    expect(openApp).not.toHaveBeenCalled();
  });

  it("refuses a confirm-tier call with only the bearer secret", async () => {
    harness = await start();
    const res = await call(harness.url, { tool: "open_app", args: { name: "Safari" } });
    expect(res.status).toBe(401);
    expect(res.json["error"]).toBe("approval_required");
    expect(openApp).not.toHaveBeenCalled();
  });

  it("executes exactly once with a valid token", async () => {
    harness = await start();
    const args = { name: "Safari" };
    const token = mintApprovalToken({ key: APPROVAL_KEY, tool: "open_app", args });
    const res = await call(harness.url, { tool: "open_app", args, approvalToken: token });
    expect(res.status).toBe(200);
    expect(openApp).toHaveBeenCalledTimes(1);
  });

  it("accepts the token from the approval header", async () => {
    harness = await start();
    const args = { name: "Safari" };
    const token = mintApprovalToken({ key: APPROVAL_KEY, tool: "open_app", args });
    const res = await fetch(`${harness.url}/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
        "X-Jarvis-Approval": token,
      },
      body: JSON.stringify({ tool: "open_app", args }),
    });
    expect(res.status).toBe(200);
    expect(openApp).toHaveBeenCalledTimes(1);
  });

  it("refuses a replayed token", async () => {
    harness = await start();
    const args = { name: "Safari" };
    const token = mintApprovalToken({ key: APPROVAL_KEY, tool: "open_app", args });
    expect((await call(harness.url, { tool: "open_app", args, approvalToken: token })).status).toBe(
      200,
    );
    const replay = await call(harness.url, { tool: "open_app", args, approvalToken: token });
    expect(replay.status).toBe(403);
    expect(replay.json["error"]).toBe("approval_replayed");
    expect(openApp).toHaveBeenCalledTimes(1);
  });

  it("refuses a token minted for different arguments", async () => {
    harness = await start();
    const token = mintApprovalToken({
      key: APPROVAL_KEY,
      tool: "open_app",
      args: { name: "Safari" },
    });
    const res = await call(harness.url, {
      tool: "open_app",
      args: { name: "Mail" },
      approvalToken: token,
    });
    expect(res.status).toBe(403);
    expect(res.json["error"]).toBe("approval_mismatch");
    expect(openApp).not.toHaveBeenCalled();
  });

  it("refuses a token minted for a different tool", async () => {
    harness = await start();
    const args = { command: "echo hi" };
    const token = mintApprovalToken({ key: APPROVAL_KEY, tool: "run_command", args });
    const res = await call(harness.url, {
      tool: "open_app",
      args: { name: "Safari" },
      approvalToken: token,
    });
    expect(res.status).toBe(403);
    expect(res.json["error"]).toBe("approval_mismatch");
    expect(openApp).not.toHaveBeenCalled();
  });

  it("refuses an expired token", async () => {
    harness = await start();
    const args = { name: "Safari" };
    const token = mintApprovalToken({
      key: APPROVAL_KEY,
      tool: "open_app",
      args,
      now: Date.now() - 10 * 60_000,
    });
    const res = await call(harness.url, { tool: "open_app", args, approvalToken: token });
    expect(res.status).toBe(403);
    expect(res.json["error"]).toBe("approval_expired");
    expect(openApp).not.toHaveBeenCalled();
  });

  it("refuses a token signed with the wrong key", async () => {
    harness = await start();
    const args = { name: "Safari" };
    const token = mintApprovalToken({ key: "b".repeat(64), tool: "open_app", args });
    const res = await call(harness.url, { tool: "open_app", args, approvalToken: token });
    expect(res.status).toBe(403);
    expect(res.json["error"]).toBe("approval_invalid");
    expect(openApp).not.toHaveBeenCalled();
  });

  it("refuses malformed tokens", async () => {
    harness = await start();
    for (const token of ["", "v1", "v1.abc", "v2.aaa.bbb", "garbage.token.value"]) {
      const res = await call(harness.url, {
        tool: "open_app",
        args: { name: "Safari" },
        approvalToken: token,
      });
      // Empty string is treated as "no token".
      expect([401, 403]).toContain(res.status);
    }
    expect(openApp).not.toHaveBeenCalled();
  });

  it("refuses never-tier tools even with a valid-looking token", async () => {
    harness = await start({ tierFor: () => "never" });
    const args = { path: "/tmp" };
    const token = mintApprovalToken({ key: APPROVAL_KEY, tool: "list_directory", args });
    const res = await call(harness.url, { tool: "list_directory", args, approvalToken: token });
    expect(res.status).toBe(403);
    expect(res.json["error"]).toBe("tool_forbidden");
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("does not require a token for auto-tier tools", async () => {
    harness = await start();
    const res = await call(harness.url, { tool: "get_volume", args: {} });
    expect(res.status).toBe(200);
    expect(getVolume).toHaveBeenCalledTimes(1);
  });
});
