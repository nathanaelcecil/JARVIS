/**
 * Profile tests: sensitive detection, masking, storage rules and the
 * "only what this request is about" prompt context.
 *
 * Every test uses a temporary root; no real `.jarvis/profile.json` is touched.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addFact,
  forgetFact,
  forgetSource,
  isSensitive,
  listFacts,
  maskValue,
  profileContext,
  PROFILE_FILE,
} from "./profile";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jarvis-profile-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sensitive detection and masking", () => {
  it("recognises identifiers", () => {
    expect(isSensitive("SSN 123-45-6789")).toBe(true);
    expect(isSensitive("card 4111 1111 1111 1111")).toBe(true);
    expect(isSensitive("cvv: 123")).toBe(true);
    expect(isSensitive("password hunter2")).toBe(true);
    expect(isSensitive("routing number 021000021")).toBe(true);
    expect(isSensitive("I prefer short answers")).toBe(false);
  });

  it("keeps only the last four characters", () => {
    const masked = maskValue("SSN 123-45-6789");
    expect(masked).toContain("6789");
    expect(masked).not.toContain("123");
    expect(masked).not.toContain("45");
  });

  it("masks a card with its brand when it can tell", () => {
    expect(maskValue("visa 4111111111111111")).toContain("visa");
    expect(maskValue("visa 4111111111111111")).not.toContain("4111111111");
  });
});

describe("fact storage", () => {
  it("stores a normal fact verbatim", async () => {
    const fact = await addFact({ root, category: "basics", value: "Nathan", kind: "name" });
    expect(fact.value).toBe("Nathan");
    expect(fact.sensitive).toBe(false);
    expect(fact.source).toBe("you");
  });

  it("never writes a raw sensitive value to disk", async () => {
    await addFact({ root, category: "contact", value: "SSN 123-45-6789", kind: "ssn" });
    const raw = readFileSync(join(root, ".jarvis", PROFILE_FILE), "utf-8");
    expect(raw).not.toContain("123-45-6789");
    expect(raw).toContain("6789");
  });

  it("rejects an unknown category and an empty value", async () => {
    await expect(addFact({ root, category: "hobbies", value: "chess" })).rejects.toThrow(
      /unknown category/,
    );
    await expect(addFact({ root, category: "notes", value: "   " })).rejects.toThrow(
      /needs a value/,
    );
  });

  it("does not store the same fact twice", async () => {
    const before = (await listFacts(root)).length;
    await addFact({ root, category: "preferences", value: "short answers", kind: "answer style" });
    await addFact({ root, category: "preferences", value: "short answers", kind: "answer style" });
    expect((await listFacts(root)).length).toBe(before + 1);
  });

  it("forgets one fact, or a whole source", async () => {
    const fact = await addFact({
      root,
      category: "places",
      value: "lives in Cape Town",
      source: "you",
    });
    expect(await forgetFact(root, fact.id)).toBe(true);
    expect(await forgetFact(root, fact.id)).toBe(false);

    await addFact({ root, category: "people", value: "Ada is my sister", source: "contacts" });
    await addFact({ root, category: "people", value: "Bob is my brother", source: "contacts" });
    const removed = await forgetSource(root, "contacts");
    expect(removed).toBe(2);
    expect((await listFacts(root)).every((entry) => entry.source !== "contacts")).toBe(true);
  });
});

describe("prompt context", () => {
  const facts = [
    {
      id: "1",
      category: "basics" as const,
      kind: "name",
      value: "Nathan",
      source: "you" as const,
      date: "2026-10-30",
      sensitive: false,
    },
    {
      id: "2",
      category: "preferences" as const,
      kind: "answer style",
      value: "short answers, no filler",
      source: "you" as const,
      date: "2026-10-30",
      sensitive: false,
    },
    {
      id: "3",
      category: "people" as const,
      kind: "birthday",
      value: "Ada's birthday is 3 May",
      source: "you" as const,
      date: "2026-10-30",
      sensitive: false,
    },
    {
      id: "4",
      category: "contact" as const,
      kind: "ssn",
      value: "•••• SSN ending 6789",
      source: "you" as const,
      date: "2026-10-30",
      sensitive: true,
    },
  ];

  it("always includes the name and answer style", () => {
    const context = profileContext(facts, "what's my battery level");
    expect(context).toContain("Nathan");
    expect(context).toContain("short answers");
  });

  it("leaves unrelated facts out", () => {
    const context = profileContext(facts, "what's my battery level");
    expect(context).not.toContain("birthday");
    expect(context).not.toContain("6789");
  });

  it("attaches a fact when the request mentions it", () => {
    expect(profileContext(facts, "when is Ada's birthday party")).toContain("birthday");
    expect(profileContext(facts, "what is my ssn")).toContain("6789");
  });

  it("marks masked values so the model knows not to repeat them in full", () => {
    const context = profileContext(facts, "what is my ssn");
    expect(context).toContain("masked");
  });

  it("returns nothing for an empty profile", () => {
    expect(profileContext([], "anything")).toBe("");
  });
});
