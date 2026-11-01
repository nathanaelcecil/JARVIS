/**
 * Unit tests for speech-text.ts — TTS normalization and sentence splitting.
 */
import { describe, it, expect } from "vitest";
import {
  toSpeechText,
  findSentenceBoundary,
  splitIntoSpeechChunks,
  snapToWordEnd,
  firstWordEnd,
} from "./speech-text";

describe("toSpeechText — punctuation & markdown", () => {
  it("strips markdown structure but keeps words", () => {
    expect(toSpeechText("## Hello **world**")).toBe("Hello world");
    expect(toSpeechText("- first\n- second")).toBe("first second");
    expect(toSpeechText("`code` and [link](https://example.com)")).toContain("code and link");
  });

  it("drops fenced code blocks entirely (never read aloud)", () => {
    const out = toSpeechText("Run this:\n```js\nconst x = 1;\n```\nDone.");
    expect(out).not.toContain("const");
    expect(out).toContain("Run this:");
    expect(out).toContain("Done.");
  });

  it("keeps decimals intact", () => {
    expect(toSpeechText("Pi is 3.14 exactly.")).toBe("Pi is 3.14 exactly.");
    expect(toSpeechText("version 9.4 of the core")).toContain("9.4");
  });
});

describe("toSpeechText — emoji & symbols", () => {
  it("verbalizes common UI symbols", () => {
    const out = toSpeechText("⚙ Running ✅ done ⚠ careful ⏹ stop");
    expect(out).toContain("gear");
    expect(out).toContain("check");
    expect(out).toContain("warning");
    expect(out).toContain("stop");
  });

  it("strips unmapped emoji entirely", () => {
    const out = toSpeechText("Hello 🚀🌍 there");
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(out).toContain("Hello");
    expect(out).toContain("there");
  });

  it("converts em dashes and arrows into spoken words", () => {
    expect(toSpeechText("a — b")).toBe("a, b");
    expect(toSpeechText("go → home")).toContain("to");
  });
});

describe("toSpeechText — abbreviations", () => {
  it("expands common abbreviations", () => {
    expect(toSpeechText("e.g. this")).toContain("for example");
    expect(toSpeechText("i.e. that")).toContain("that is");
    expect(toSpeechText("etc. and more")).toContain("and so on");
    expect(toSpeechText("Dr. Smith")).toContain("Doctor");
    expect(toSpeechText("vs. them")).toContain("versus");
  });

  it("leaves sentence-final periods on normal words alone", () => {
    expect(toSpeechText("Hello world.")).toBe("Hello world.");
  });
});

describe("toSpeechText — version numbers & code terms", () => {
  it("speaks version numbers naturally", () => {
    expect(toSpeechText("v9.4 is out")).toContain("version 9.4");
    expect(toSpeechText("run v2 of it")).toContain("version 2");
  });

  it("normalizes code operators into language", () => {
    expect(toSpeechText("x => y")).toContain("yields");
    expect(toSpeechText("a && b")).toContain("and");
    expect(toSpeechText("foo_bar")).toBe("foo bar");
  });

  it("keeps acronym acronyms but normalizes known ones", () => {
    expect(toSpeechText("the TTS engine")).toContain("text to speech");
  });
});

describe("toSpeechText — URLs", () => {
  it("reads URLs as spoken words", () => {
    const out = toSpeechText("see https://example.com/path now");
    expect(out).not.toContain("https://");
    expect(out).toContain("example dot com");
    expect(out).toContain("slash");
  });

  it("does not mangle surrounding sentence text", () => {
    const out = toSpeechText("Visit www.example.com today.");
    expect(out).toContain("today.");
  });
});

describe("findSentenceBoundary", () => {
  it("splits at a normal sentence end", () => {
    const text = "Hello there. And now?";
    const cut = findSentenceBoundary(text);
    expect(cut).toBe(12); // just after "Hello there."
    expect(text.slice(0, cut)).toBe("Hello there.");
  });

  it("never splits inside a decimal number", () => {
    const text = "Pi is 3.14159 digits long. Ok.";
    const cut = findSentenceBoundary(text);
    expect(text.slice(0, cut)).toBe("Pi is 3.14159 digits long.");
  });

  it("never splits after single-letter initials", () => {
    const text = "J. R. R. Tolkien wrote it. Truly.";
    const cut = findSentenceBoundary(text);
    expect(text.slice(0, cut)).toBe("J. R. R. Tolkien wrote it.");
  });

  it("never splits after common abbreviations", () => {
    const text = "Ask Dr. Smith about it. Then go.";
    const cut = findSentenceBoundary(text);
    expect(text.slice(0, cut)).toBe("Ask Dr. Smith about it.");
  });

  it("does not split when the next word starts lowercase", () => {
    const text = "The value is approx. five items total. Done.";
    const cut = findSentenceBoundary(text);
    expect(text.slice(0, cut)).toBe("The value is approx. five items total.");
  });

  it("returns -1 in streaming mode when the buffer ends at the punctuation", () => {
    expect(findSentenceBoundary("Wait for v9.", { allowEnd: false })).toBe(-1);
    expect(findSentenceBoundary("Wait for v9.", { allowEnd: true })).toBe(12);
  });

  it("waits for the next word in streaming mode", () => {
    expect(findSentenceBoundary("Hello. ", { allowEnd: false })).toBe(-1);
    expect(findSentenceBoundary("Hello. W", { allowEnd: false })).toBe(6);
  });

  it("respects a `from` offset", () => {
    const text = "One. Two. Three.";
    const second = findSentenceBoundary(text, { from: 4 });
    expect(second).toBe(9);
  });
});

describe("splitIntoSpeechChunks", () => {
  it("returns the whole text when under the cap", () => {
    expect(splitIntoSpeechChunks("Short reply.", 200)).toEqual(["Short reply."]);
  });

  it("produces contiguous chunks that reproduce the input exactly", () => {
    const text = Array.from(
      { length: 30 },
      (_, i) => `Sentence number ${i} with a few words in it.`,
    ).join(" ");
    const chunks = splitIntoSpeechChunks(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("respects the cap except for single unbreakable words", () => {
    const text = `${"word ".repeat(80)}end`;
    const chunks = splitIntoSpeechChunks(text, 50);
    for (const c of chunks) {
      if (c.trim().includes(" ")) expect(c.length).toBeLessThanOrEqual(50);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("splits over-long single sentences at word boundaries", () => {
    const text = "A ".repeat(200) + "end";
    const chunks = splitIntoSpeechChunks(text, 60);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.join("")).toBe(text);
    // No chunk may start mid-word or with a space (cuts land on boundaries).
    for (const c of chunks) {
      expect(c.startsWith(" ")).toBe(false);
    }
  });

  it("handles empty input", () => {
    expect(splitIntoSpeechChunks("")).toEqual([]);
  });
});

describe("word-boundary reveal helpers", () => {
  const text = "hello world again";

  it("firstWordEnd returns the end of the word at `from`", () => {
    expect(firstWordEnd(text, 0, text.length)).toBe(5);
    expect(firstWordEnd(text, 6, text.length)).toBe(11);
  });

  it("snapToWordEnd never splits a word", () => {
    expect(snapToWordEnd(text, 3, text.length)).toBe(5); // inside "hello"
    expect(snapToWordEnd(text, 5, text.length)).toBe(5); // on the space
    expect(snapToWordEnd(text, 7, text.length)).toBe(11); // inside "world"
  });

  it("clamps to [0, limit]", () => {
    expect(snapToWordEnd(text, -5, text.length)).toBe(0);
    expect(snapToWordEnd(text, 999, text.length)).toBe(text.length);
    expect(firstWordEnd(text, 999, text.length)).toBe(text.length);
  });
});
