/**
 * Model-discovery tests. The fetch is replaced with a fake `globalThis.fetch`,
 * so these run offline and pin the two behaviours that matter: a missing model
 * name is repaired to one that exists, and a failed lookup changes nothing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chooseModel,
  clearModelCache,
  isVisionModel,
  listInstalledModels,
  parseTags,
} from "./ollama-models";

afterEach(() => {
  clearModelCache();
  vi.unstubAllGlobals();
});

describe("parseTags", () => {
  it("reads names and sizes", () => {
    const tags = parseTags({ models: [{ name: "qwen2.5:14b", size: 9 }, { name: "x" }] });
    expect(tags).toEqual([
      { name: "qwen2.5:14b", sizeBytes: 9 },
      { name: "x", sizeBytes: 0 },
    ]);
  });

  it("ignores malformed bodies instead of throwing", () => {
    expect(parseTags(null)).toEqual([]);
    expect(parseTags({ models: "nope" })).toEqual([]);
    expect(parseTags({ models: [{ name: "" }, { size: 1 }, null] })).toEqual([]);
  });
});

describe("isVisionModel", () => {
  it("recognises the vision families", () => {
    expect(isVisionModel("qwen2.5vl:7b")).toBe(true);
    expect(isVisionModel("llava:13b")).toBe(true);
    expect(isVisionModel("qwen2.5:14b")).toBe(false);
  });
});

describe("chooseModel", () => {
  const available = ["qwen2.5:14b", "qwen2.5vl:7b", "llama3.2:3b"];

  it("keeps the requested model when it is installed", () => {
    expect(chooseModel("qwen2.5vl:7b", available)).toBe("qwen2.5vl:7b");
  });

  it("falls back to the same family when the tag is missing", () => {
    expect(chooseModel("qwen2.5:32b", available)).toBe("qwen2.5:14b");
  });

  it("picks an installed vision model for a vision route", () => {
    expect(chooseModel("llava:13b", available)).toBe("qwen2.5vl:7b");
  });

  it("returns the request untouched when nothing is installed", () => {
    expect(chooseModel("qwen2.5:14b", [])).toBe("qwen2.5:14b");
  });

  it("uses the first model when no family matches", () => {
    expect(chooseModel("mistral:7b", ["llama3.2:3b"])).toBe("llama3.2:3b");
  });
});

describe("listInstalledModels", () => {
  it("reads the daemon's tag list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "a" }, { name: "b" }] }))),
    );
    await expect(listInstalledModels("http://127.0.0.1:11434", 1)).resolves.toEqual(["a", "b"]);
  });

  it("returns an empty list when the daemon is down, and caches nothing", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", failing);
    await expect(listInstalledModels("http://127.0.0.1:11434", 1)).resolves.toEqual([]);
    await expect(listInstalledModels("http://127.0.0.1:11434", 2)).resolves.toEqual([]);
    expect(failing).toHaveBeenCalledTimes(2); // failures are retried, not cached
  });

  it("caches a successful answer for the TTL", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "a" }] })));
    vi.stubGlobal("fetch", fetchMock);
    await listInstalledModels("http://127.0.0.1:11434", 1);
    await listInstalledModels("http://127.0.0.1:11434", 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
