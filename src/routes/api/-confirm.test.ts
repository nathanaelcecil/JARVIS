/**
 * Confirm prompts must never report a timeout as a user denial.
 * (60s auto-deny mislabeled as "denied by you" while the user was busy
 * approving Google consent in another tab.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getPendingConfirmation, mintConfirmId, registerConfirmation } from "./confirm";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("registerConfirmation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is still pending after 60s — a slow approval must not become a denial", async () => {
    const p = registerConfirmation({
      tool: "notion.notion_append_blocks",
      args: {},
      confirmId: "slow1",
    });
    const settled: string[] = [];
    void p.then((d) => settled.push(d));

    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(settled).toEqual([]);

    vi.advanceTimersByTime(119_000); // 179s total — still waiting
    await Promise.resolve();
    expect(settled).toEqual([]);

    vi.advanceTimersByTime(1_000); // 180s total
    expect(await p).toBe("expired");
  });

  it("expires (not 'denied') when nobody answers within 3 minutes", async () => {
    const p = registerConfirmation({ tool: "t", args: {}, confirmId: "idle1" });
    vi.advanceTimersByTime(180_000);
    expect(await p).toBe("expired");
    // The entry is cleaned up so a late click gets a 404, not a false denial.
    expect(getPendingConfirmation("idle1")).toBeUndefined();
  });

  it("resolves approved / denied from the pending entry (what POST /api/confirm calls)", async () => {
    const approved = registerConfirmation({
      tool: "t",
      args: {},
      confirmId: "ok1",
    });
    getPendingConfirmation("ok1")!.resolve("approved");
    expect(await approved).toBe("approved");

    const denied = registerConfirmation({
      tool: "t",
      args: {},
      confirmId: "no1",
    });
    getPendingConfirmation("no1")!.resolve("denied");
    expect(await denied).toBe("denied");
  });

  it("mints the full UUID, not an 8-character prefix", () => {
    const id = mintConfirmId();
    expect(id).toHaveLength(36);
    expect(id).toMatch(UUID_V4);
    // Truncation would make collisions plausible across a long session.
    expect(id).not.toHaveLength(8);
  });

  it("accepts an id minted by mintConfirmId and exposes it unchanged", () => {
    const id = mintConfirmId();
    void registerConfirmation({ tool: "t", args: {}, confirmId: id });
    expect(getPendingConfirmation(id)?.tool).toBe("t");
  });

  it("keeps tool and args visible for the UI while pending", () => {
    void registerConfirmation({
      tool: "gmail.gmail_send_email",
      args: { to: "bob@example.com" },
      confirmId: "meta1",
    });
    const pending = getPendingConfirmation("meta1");
    expect(pending?.tool).toBe("gmail.gmail_send_email");
    expect(pending?.args).toEqual({ to: "bob@example.com" });
  });
});
