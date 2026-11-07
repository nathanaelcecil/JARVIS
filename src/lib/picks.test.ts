/**
 * ask_user picks: the chat turn waits for the card, so every path must resolve
 * — choice, dismissal, abort and timeout — and options must never be faked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelAllPicks,
  cancelPick,
  getPendingPick,
  mintPickId,
  pendingPickCount,
  registerPick,
  resolvePick,
} from "./picks";

beforeEach(() => {
  cancelAllPicks();
});

describe("pick registry", () => {
  it("resolves with the chosen option", async () => {
    const pending = registerPick({
      prompt: "Which file?",
      options: ["a.md", "b.md"],
      pickId: "p1",
    });
    expect(resolvePick("p1", "b.md")).toBe(true);
    await expect(pending).resolves.toEqual({ choice: "b.md" });
  });

  it("matches case-insensitively and returns the canonical option", async () => {
    const pending = registerPick({ prompt: "Which?", options: ["Chrome", "Safari"], pickId: "p2" });
    resolvePick("p2", "safari");
    await expect(pending).resolves.toEqual({ choice: "Safari" });
  });

  it("accepts a free-form answer the model did not offer", async () => {
    const pending = registerPick({ prompt: "Which?", options: ["one", "two"], pickId: "p3" });
    resolvePick("p3", "something else");
    await expect(pending).resolves.toEqual({ choice: "something else" });
  });

  it("settles a dismissal as cancelled, not as an empty choice", async () => {
    const pending = registerPick({ prompt: "Which?", options: ["one"], pickId: "p4" });
    expect(cancelPick("p4")).toBe(true);
    await expect(pending).resolves.toEqual({ cancelled: true });
  });

  it("trims and de-duplicates options, and refuses an empty list", async () => {
    const pending = registerPick({
      prompt: "Which?",
      options: [" a ", "a", "", "b"],
      pickId: "p5",
    });
    expect(getPendingPick("p5")?.options).toEqual(["a", "b"]);
    cancelPick("p5");
    await expect(pending).resolves.toEqual({ cancelled: true });

    await expect(registerPick({ prompt: "Which?", options: ["  ", ""] })).resolves.toEqual({
      cancelled: true,
    });
  });

  it("expires after the timeout instead of hanging the turn", async () => {
    vi.useFakeTimers();
    try {
      const pending = registerPick({ prompt: "Which?", options: ["one"], pickId: "p-timeout" });
      vi.advanceTimersByTime(180_000);
      await expect(pending).resolves.toEqual({ expired: true });
      expect(pendingPickCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops accepting answers once settled", async () => {
    const pending = registerPick({ prompt: "Which?", options: ["one"], pickId: "p-once" });
    expect(resolvePick("p-once", "one")).toBe(true);
    expect(resolvePick("p-once", "one")).toBe(false);
    await pending;
  });

  it("exposes the prompt while pending and drops it after", async () => {
    const pending = registerPick({ prompt: "Pick a window", options: ["Terminal"], pickId: "p6" });
    expect(getPendingPick("p6")).toEqual({ prompt: "Pick a window", options: ["Terminal"] });
    cancelPick("p6");
    await pending;
    expect(getPendingPick("p6")).toBeNull();
  });

  it("mints full UUIDs", () => {
    expect(mintPickId()).toHaveLength(36);
  });
});
