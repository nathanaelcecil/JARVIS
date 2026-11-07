/**
 * Confirm prompts must never report a timeout as a user denial.
 * (60s auto-deny mislabeled as "denied by you" while the user was busy
 * approving Google consent in another tab.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getPendingConfirmation, mintConfirmId, registerConfirmation, Route } from "./confirm";
import {
  clearAllTaskApprovals,
  isToolAllowedForTask,
  taskApprovalScopeCount,
} from "../../lib/task-approvals";

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

// ── Task-scoped widening ───────────────────────────────────────────────────

describe("POST /api/confirm scope=task", () => {
  type Handler = (ctx: { request: Request }) => Promise<Response>;
  const route = Route as unknown as {
    options: { server: { handlers: { POST: Handler } } };
  };
  const post = (body: Record<string, unknown>) =>
    route.options.server.handlers.POST({
      request: new Request("http://127.0.0.1:4173/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json", Host: "127.0.0.1:4173" },
        body: JSON.stringify(body),
      }),
    });

  beforeEach(() => {
    clearAllTaskApprovals();
  });

  it("widens the approval to the whole task only when asked", async () => {
    void registerConfirmation({ tool: "control_type", args: {}, confirmId: "w1", taskId: "t1" });
    const res = await post({ confirmId: "w1", approved: true, scope: "task" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ approved: true, scope: "task" });
    expect(isToolAllowedForTask("t1", "control_type")).toBe(true);
  });

  it("keeps a plain approve single-use", async () => {
    void registerConfirmation({ tool: "control_type", args: {}, confirmId: "w2", taskId: "t2" });
    const res = await post({ confirmId: "w2", approved: true });
    expect(await res.json()).toMatchObject({ approved: true, scope: "once" });
    expect(isToolAllowedForTask("t2", "control_type")).toBe(false);
  });

  it("never widens a denial, or a prompt with no task id", async () => {
    void registerConfirmation({ tool: "control_type", args: {}, confirmId: "w3", taskId: "t3" });
    await post({ confirmId: "w3", approved: false, scope: "task" });
    expect(isToolAllowedForTask("t3", "control_type")).toBe(false);

    void registerConfirmation({ tool: "control_type", args: {}, confirmId: "w4" });
    const res = await post({ confirmId: "w4", approved: true, scope: "task" });
    expect(await res.json()).toMatchObject({ approved: true, scope: "once" });
    expect(taskApprovalScopeCount()).toBe(0);
  });
});
