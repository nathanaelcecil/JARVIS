/**
 * Project memory — recall, staleness, secret refusal, inspect/correct API.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  saveMemory,
  recallMemory,
  listMemory,
  updateMemoryEntry,
  deleteMemoryEntry,
  memoryToPrompt,
} from "./memory";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "jarvis-mem-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("saveMemory", () => {
  it("stores and lists entries per repository", async () => {
    await saveMemory(root, {
      kind: "convention",
      content: "Tests live in *.test.ts next to the source",
      fileRefs: ["src/lib/x.ts"],
    });
    await saveMemory(root, { kind: "decision", content: "Ollama is the provider" });
    const all = await listMemory(root);
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.kind)).toContain("convention");
  });

  it("refuses secret-looking content", async () => {
    await expect(
      saveMemory(root, { kind: "note", content: "apiKey = 'sk-abcdef1234567890'" }),
    ).rejects.toThrow(/secret/i);
    await expect(
      saveMemory(root, { kind: "note", content: "password: hunter2hunter2hunter2" }),
    ).rejects.toThrow(/secret/i);
    expect(await listMemory(root)).toHaveLength(0);
  });

  it("refuses empty and oversized content", async () => {
    await expect(saveMemory(root, { kind: "note", content: "   " })).rejects.toThrow(/non-empty/);
    await expect(saveMemory(root, { kind: "note", content: "x".repeat(2000) })).rejects.toThrow(
      /too long/i,
    );
  });

  it("de-duplicates identical kind+content by refreshing", async () => {
    const a = await saveMemory(root, { kind: "note", content: "same" });
    const b = await saveMemory(root, { kind: "note", content: "same" });
    expect(b.id).toBe(a.id);
    expect(await listMemory(root)).toHaveLength(1);
  });

  it("caps stored entries at 200, dropping the oldest", async () => {
    for (let i = 0; i < 205; i++) {
      await saveMemory(root, { kind: "note", content: `entry ${i}` });
    }
    const all = await listMemory(root);
    expect(all.length).toBeLessThanOrEqual(200);
  });
});

describe("recallMemory", () => {
  it("scores token overlap and returns the most relevant", async () => {
    await saveMemory(root, {
      kind: "architecture",
      content: "The chat endpoint streams server-sent events from stream.ts",
    });
    await saveMemory(root, { kind: "convention", content: "Prettier formats on save" });
    const hits = await recallMemory(root, "how does streaming SSE chat work?");
    expect(hits[0]!.content).toContain("server-sent events");
    expect(hits.length).toBeLessThanOrEqual(6);
  });

  it("returns nothing for an empty store", async () => {
    expect(await recallMemory(root, "anything")).toEqual([]);
  });

  it("marks entries stale when a referenced file changes afterwards", async () => {
    const target = path.join(root, "src.ts");
    await fs.writeFile(target, "v1\n");
    await saveMemory(root, {
      kind: "architecture",
      content: "src.ts owns routing",
      fileRefs: ["src.ts"],
    });
    expect((await recallMemory(root, "src.ts routing"))[0]!.stale).toBeFalsy();

    // Touch the file AFTER the entry was written.
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(target, "v2\n");
    const after = await recallMemory(root, "src.ts routing");
    expect(after[0]!.stale).toBe(true);
    expect(memoryToPrompt(after)).toContain("STALE");
  });

  it("marks entries stale when the referenced file disappears", async () => {
    await saveMemory(root, {
      kind: "bug",
      content: "ghost.ts has a race",
      fileRefs: ["ghost.ts"],
    });
    const hits = await recallMemory(root, "ghost race");
    expect(hits[0]!.stale).toBe(true);
  });
});

describe("inspect & correct", () => {
  it("updates content/kind and clears staleness", async () => {
    const e = await saveMemory(root, { kind: "note", content: "draft" });
    const updated = await updateMemoryEntry(root, e.id, {
      content: "corrected text",
      kind: "decision",
    });
    expect(updated.content).toBe("corrected text");
    expect(updated.kind).toBe("decision");
    const [listed] = await listMemory(root);
    expect(listed!.content).toBe("corrected text");
  });

  it("rejects secret content during correction too", async () => {
    const e = await saveMemory(root, { kind: "note", content: "fine" });
    await expect(
      updateMemoryEntry(root, e.id, { content: "token = ghp_abcdefghijklmnopqrstuvwx" }),
    ).rejects.toThrow(/secret/i);
  });

  it("deletes entries and reports missing ids", async () => {
    const e = await saveMemory(root, { kind: "note", content: "temp" });
    await deleteMemoryEntry(root, e.id);
    expect(await listMemory(root)).toHaveLength(0);
    await expect(deleteMemoryEntry(root, e.id)).rejects.toThrow(/not found/);
    await expect(updateMemoryEntry(root, "nope", { content: "x" })).rejects.toThrow(/not found/);
  });

  it("memory survives a reload (persisted to .jarvis/memory.json)", async () => {
    await saveMemory(root, { kind: "fix", content: "reboot fixed the tokenizer" });
    const file = path.join(root, ".jarvis", "memory.json");
    const raw = JSON.parse(await fs.readFile(file, "utf-8"));
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.repos)).toHaveLength(1);
  });
});
