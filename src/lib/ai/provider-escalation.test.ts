import { describe, expect, it } from "vitest";
import { EscalatingProvider, escalationModel, type AIProvider, type ChatMessage } from "./provider";

/** A provider that replays scripted outcomes and records the models it saw. */
function scripted(outcomes: Array<{ content: string } | Error>, calls: string[] = []): AIProvider {
  let index = 0;
  return {
    async chat(params: { messages: ChatMessage[]; model: string }) {
      calls.push(params.model);
      const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? { content: "" };
      index += 1;
      if (outcome instanceof Error) throw outcome;
      return { content: outcome.content };
    },
  };
}

const messages: ChatMessage[] = [{ role: "user", content: "hello" }];

describe("EscalatingProvider", () => {
  it("keeps a usable answer and does not retry", async () => {
    const calls: string[] = [];
    const provider = new EscalatingProvider(scripted([{ content: "fine" }], calls), "work:model");
    await expect(provider.chat({ messages, model: "cheap:model" })).resolves.toMatchObject({
      content: "fine",
    });
    expect(calls).toEqual(["cheap:model"]);
  });

  it("escalates an empty answer to the work model once", async () => {
    const calls: string[] = [];
    const provider = new EscalatingProvider(
      scripted([{ content: "   " }, { content: "real answer" }], calls),
      "work:model",
    );
    await expect(provider.chat({ messages, model: "cheap:model" })).resolves.toMatchObject({
      content: "real answer",
    });
    expect(calls).toEqual(["cheap:model", "work:model"]);
  });

  it("escalates a thrown error to the work model", async () => {
    const calls: string[] = [];
    const provider = new EscalatingProvider(
      scripted([new Error("model not loaded"), { content: "recovered" }], calls),
      "work:model",
    );
    await expect(provider.chat({ messages, model: "cheap:model" })).resolves.toMatchObject({
      content: "recovered",
    });
    expect(calls).toEqual(["cheap:model", "work:model"]);
  });

  it("does not loop when the work model itself is empty or failing", async () => {
    const emptyCalls: string[] = [];
    const empty = new EscalatingProvider(scripted([{ content: "" }], emptyCalls), "work:model");
    await expect(empty.chat({ messages, model: "work:model" })).resolves.toMatchObject({
      content: "",
    });
    expect(emptyCalls).toEqual(["work:model"]);

    const failing = new EscalatingProvider(scripted([new Error("boom")]), "work:model");
    await expect(failing.chat({ messages, model: "work:model" })).rejects.toThrow("boom");
  });

  it("never retries after the user aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    const provider = new EscalatingProvider(scripted([new Error("aborted")], calls), "work:model");
    await expect(
      provider.chat({ messages, model: "cheap:model", signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(calls).toEqual(["cheap:model"]);
  });

  it("defaults the work model from the environment", () => {
    expect(escalationModel()).toBe(
      process.env["OLLAMA_ESCALATION_MODEL"] ??
        process.env["OLLAMA_SMART_MODEL"] ??
        process.env["OLLAMA_LOCAL_MODEL"] ??
        "qwen2.5:14b",
    );
  });
});
