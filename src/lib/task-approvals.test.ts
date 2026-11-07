/**
 * Task-scoped approvals: "always allow this tool for this task" must remember
 * the tool for exactly one chat turn, and must still mint a fresh single-use
 * approval token for every call it lets through.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allowToolForTask,
  clearAllTaskApprovals,
  clearTaskApprovals,
  isToolAllowedForTask,
  taskApprovalScopeCount,
  toolsAllowedForTask,
} from "./task-approvals";
import { authorizeToolCall } from "./tool-authorization";

const root = mkdtempSync(join(tmpdir(), "jarvis-task-approvals-"));
const keyFile = join(root, ".approval-key");
writeFileSync(keyFile, "e".repeat(64), { mode: 0o600 });
const previousKeyEnv = process.env["JARVIS_APPROVAL_KEY_FILE"];

beforeEach(() => {
  process.env["JARVIS_APPROVAL_KEY_FILE"] = keyFile;
  clearAllTaskApprovals();
});

afterAll(() => {
  if (previousKeyEnv === undefined) delete process.env["JARVIS_APPROVAL_KEY_FILE"];
  else process.env["JARVIS_APPROVAL_KEY_FILE"] = previousKeyEnv;
  rmSync(root, { recursive: true, force: true });
});

describe("task approval registry", () => {
  it("remembers a tool only for the task that allowed it", () => {
    allowToolForTask("task-a", "control_type");
    expect(isToolAllowedForTask("task-a", "control_type")).toBe(true);
    expect(isToolAllowedForTask("task-b", "control_type")).toBe(false);
    expect(isToolAllowedForTask(undefined, "control_type")).toBe(false);
  });

  it("keeps a set per task and clears one task at a time", () => {
    allowToolForTask("task-a", "control_type");
    allowToolForTask("task-a", "control_click");
    allowToolForTask("task-b", "open_app");
    expect(toolsAllowedForTask("task-a")).toEqual(["control_type", "control_click"]);
    expect(taskApprovalScopeCount()).toBe(2);

    clearTaskApprovals("task-a");
    expect(isToolAllowedForTask("task-a", "control_type")).toBe(false);
    expect(isToolAllowedForTask("task-b", "open_app")).toBe(true);
  });

  it("ignores empty ids instead of creating a scope nobody can clear", () => {
    allowToolForTask("", "control_type");
    allowToolForTask("task-a", "");
    expect(taskApprovalScopeCount()).toBe(0);
  });
});

describe("authorizeToolCall with a task scope", () => {
  it("skips the prompt but still returns a fresh approval token", async () => {
    allowToolForTask("task-a", "control_click");
    const emit = vi.fn();

    const first = await authorizeToolCall({
      tool: "control_click",
      args: { pid: 42, label: "OK" },
      source: "tool",
      taskId: "task-a",
      emitConfirmRequest: emit,
    });
    const second = await authorizeToolCall({
      tool: "control_click",
      args: { pid: 42, label: "OK" },
      source: "tool",
      taskId: "task-a",
      emitConfirmRequest: emit,
    });

    expect(first).toMatchObject({ ok: true, tier: "confirm" });
    expect(second).toMatchObject({ ok: true, tier: "confirm" });
    expect(first.ok && first.approval).toBeTruthy();
    expect(second.ok && second.approval).not.toBe(first.ok && first.approval);
    expect(emit).not.toHaveBeenCalled();
  });

  it("still prompts when the tool was never allowed for this task", async () => {
    allowToolForTask("task-a", "control_click");
    const emit = vi.fn();

    const pending = authorizeToolCall({
      tool: "control_type",
      args: { text: "hi" },
      source: "tool",
      taskId: "task-a",
      emitConfirmRequest: emit,
    });

    // The prompt is emitted before the decision is awaited.
    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0]?.[0] as { confirmId: string; taskId?: string };
    expect(payload.taskId).toBe("task-a");

    const { resolveConfirmation } = await import("./confirmations");
    resolveConfirmation(payload.confirmId, "denied");
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "denied" });
  });
});
