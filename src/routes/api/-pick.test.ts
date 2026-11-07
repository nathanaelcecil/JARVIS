/**
 * POST /api/pick hands a card answer back to the waiting turn. A dismissal
 * must cancel, and an unknown id must never look like success.
 */

import { describe, expect, it } from "vitest";
import { Route } from "./pick";
import { getPendingPick, registerPick } from "../../lib/picks";

type Handler = (ctx: { request: Request }) => Promise<Response>;
const route = Route as unknown as {
  options: { server: { handlers: { POST: Handler } } };
};

const post = (body: Record<string, unknown>) =>
  route.options.server.handlers.POST({
    request: new Request("http://127.0.0.1:4173/api/pick", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:4173" },
      body: JSON.stringify(body),
    }),
  });

describe("POST /api/pick", () => {
  it("resolves a pending pick with the chosen option", async () => {
    const pending = registerPick({ prompt: "Which?", options: ["a", "b"], pickId: "e1" });
    const res = await post({ pickId: "e1", choice: "b" });
    expect(res.status).toBe(200);
    await expect(pending).resolves.toEqual({ choice: "b" });
  });

  it("cancels on dismissal", async () => {
    const pending = registerPick({ prompt: "Which?", options: ["a"], pickId: "e2" });
    const res = await post({ pickId: "e2", cancel: true });
    expect(res.status).toBe(200);
    await expect(pending).resolves.toEqual({ cancelled: true });
  });

  it("rejects an unknown or already-answered pick", async () => {
    const res = await post({ pickId: "nope", choice: "a" });
    expect(res.status).toBe(404);

    const pending = registerPick({ prompt: "Which?", options: ["a"], pickId: "e3" });
    await post({ pickId: "e3", choice: "a" });
    await pending;
    expect(getPendingPick("e3")).toBeNull();
    expect((await post({ pickId: "e3", choice: "a" })).status).toBe(404);
  });

  it("requires an id and a non-empty choice", async () => {
    expect((await post({ choice: "a" })).status).toBe(400);
    const pending = registerPick({ prompt: "Which?", options: ["a"], pickId: "e4" });
    expect((await post({ pickId: "e4", choice: "   " })).status).toBe(400);
    expect(getPendingPick("e4")).not.toBeNull();
    // leave nothing pending for later files
    await post({ pickId: "e4", cancel: true });
    await pending;
  });
});
