/**
 * Characterization + contract tests for the shared authorization policy.
 * These pin the tier behavior stream.ts and the coding agent relied on before
 * the refactor: auto runs, confirm asks, never refuses, unknown = confirm.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { authorizeToolCall, decideToolTier } from "./tool-authorization";
import {
  pendingConfirmationCount,
  resolveConfirmation,
} from "./confirmations";
import { NonceStore, verifyApprovalToken } from "../../local-agent/approval";

const root = mkdtempSync(join(tmpdir(), "jarvis-auth-"));
const keyFile = join(root, ".approval-key");
const APPROVAL_KEY = "d".repeat(64);
writeFileSync(keyFile, APPROVAL_KEY, { mode: 0o600 });

const previousKeyEnv = process.env["JARVIS_APPROVAL_KEY_FILE"];

beforeEach(() => {
  process.env["JARVIS_APPROVAL_KEY_FILE"] = keyFile;
});

afterAll(() => {
  if (previousKeyEnv === undefined) delete process.env["JARVIS_APPROVAL_KEY_FILE"];
  else process.env["JARVIS_APPROVAL_KEY_FILE"] = previousKeyEnv;
  rmSync(root, { recursive: true, force: true });
});

describe("decideToolTier", () => {
  it("maps auto tools to auto", () => {
    const decision = decideToolTier("list_directory");
    expect(decision.allowed).toBe(true);
    expect(decision.tier).toBe("auto");
  });

  it("maps confirm tools to confirm", () => {
    expect(decideToolTier("open_app").tier).toBe("confirm");
  });

  it("refuses the never tier", () => {
    const decision = decideToolTier("system.shutdown");
    expect(decision.allowed).toBe(false);
    expect(decision.tier).toBe("never");
    expect(decision.message).toBe(
      "Tool blocked by security policy: system.shutdown (tier: never)",
    );
  });

  it("defaults unknown tools to confirm", () => {
    const decision = decideToolTier("totally_unknown_tool");
    expect(decision.allowed).toBe(true);
    expect(decision.tier).toBe("confirm");
  });
});

describe("authorizeToolCall", () => {
  it("allows auto-tier tools without a prompt", async () => {
    const emit = vi.fn();
    const result = await authorizeToolCall({
      tool: "list_directory",
      args: { path: "/tmp" },
      source: "tool",
      emitConfirmRequest: emit,
    });
    expect(result).toEqual({ ok: true, tier: "auto" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses never-tier tools without a prompt", async () => {
    const emit = vi.fn();
    const result = await authorizeToolCall({
      tool: "system.shutdown",
      args: {},
      source: "tool",
      emitConfirmRequest: emit,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("never");
    expect(result.tier).toBe("never");
    expect(emit).not.toHaveBeenCalled();
  });

  it("prompts for an unknown tool and runs it when approved", async () => {
    const result = await authorizeToolCall({
      tool: "totally_unknown_tool",
      args: { x: 1 },
      source: "tool",
      emitConfirmRequest: ({ confirmId }) => resolveConfirmation(confirmId, "approved"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tier).toBe("confirm");
    // Not a local-agent tool → no approval token.
    expect(result.approval).toBeUndefined();
  });

  it("emits confirm_request with the exact payload shape before resolving", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const result = await authorizeToolCall({
      tool: "open_app",
      args: { name: "Safari" },
      source: "fast",
      emitConfirmRequest: (payload) => {
        seen.push(payload as unknown as Record<string, unknown>);
        resolveConfirmation(payload.confirmId, "approved");
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!).sort()).toEqual(["args", "confirmId", "tool"]);
    expect(seen[0]!["tool"]).toBe("open_app");
    expect(seen[0]!["args"]).toEqual({ name: "Safari" });
    expect(String(seen[0]!["confirmId"])).toHaveLength(36);
  });

  it("reports a denial with the existing message", async () => {
    const result = await authorizeToolCall({
      tool: "open_app",
      args: { name: "Safari" },
      source: "tool",
      emitConfirmRequest: ({ confirmId }) => resolveConfirmation(confirmId, "denied"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("denied");
    expect(result.message).toBe("Action denied by user: open_app");
  });

  it("reports an expiry as expired, never as a denial", async () => {
    vi.useFakeTimers();
    try {
      const pending = authorizeToolCall({
        tool: "open_app",
        args: { name: "Safari" },
        source: "tool",
        emitConfirmRequest: () => {
          /* nobody answers */
        },
      });
      await vi.advanceTimersByTimeAsync(180_000);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("expired");
      expect(result.message).toContain("timed out");
      expect(result.message).not.toContain("denied");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves as cancelled when the task aborts while pending", async () => {
    const controller = new AbortController();
    const before = pendingConfirmationCount();
    const pending = authorizeToolCall({
      tool: "open_app",
      args: { name: "Safari" },
      source: "tool",
      signal: controller.signal,
      emitConfirmRequest: () => {
        controller.abort();
      },
    });
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cancelled");
    expect(result.message).toContain("cancelled");
    // The pending entry is removed — a late approval gets a 404.
    expect(pendingConfirmationCount()).toBe(before);
  });

  it("rejects malformed arguments", async () => {
    const result = await authorizeToolCall({
      tool: "open_app",
      args: [] as unknown as Record<string, unknown>,
      source: "tool",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_args");
  });

  it("mints a verifiable approval token for a confirm-tier local-agent tool", async () => {
    const args = { name: "Safari" };
    const result = await authorizeToolCall({
      tool: "open_app",
      args,
      source: "fast",
      emitConfirmRequest: ({ confirmId }) => resolveConfirmation(confirmId, "approved"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.approval).toBe("string");
    const check = verifyApprovalToken({
      key: APPROVAL_KEY,
      token: result.approval as string,
      tool: "open_app",
      args,
      nonces: new NonceStore(),
    });
    expect(check.ok).toBe(true);
  });

  it("binds the token to the approved arguments", async () => {
    const result = await authorizeToolCall({
      tool: "open_app",
      args: { name: "Safari" },
      source: "fast",
      emitConfirmRequest: ({ confirmId }) => resolveConfirmation(confirmId, "approved"),
    });
    if (!result.ok || !result.approval) throw new Error("expected an approval token");
    const swapped = verifyApprovalToken({
      key: APPROVAL_KEY,
      token: result.approval,
      tool: "open_app",
      args: { name: "Mail" },
      nonces: new NonceStore(),
    });
    expect(swapped.ok).toBe(false);
    if (!swapped.ok) expect(swapped.code).toBe("approval_mismatch");
  });

  it("does not mint a token for in-process server-side tools", async () => {
    const result = await authorizeToolCall({
      tool: "gmail_send_email",
      args: { to: "bob@example.com", subject: "s", body: "b" },
      source: "tool",
      emitConfirmRequest: ({ confirmId }) => resolveConfirmation(confirmId, "approved"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approval).toBeUndefined();
  });
});
