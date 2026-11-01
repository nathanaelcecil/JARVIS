/**
 * History-search tests.
 *
 * The Supabase call is not exercised here — what matters for correctness is the
 * pure part: query normalisation (PostgREST filter characters), snippet
 * centring, honest ordering, and the cap. Those are what a wrong answer would
 * come from.
 */

import { describe, expect, it } from "vitest";

import {
  makeSnippet,
  MAX_QUERY_CHARS,
  normalizeHistoryQuery,
  rankMessages,
  type HistoryRow,
} from "./history-search";

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: "m1",
    session_id: "s1",
    role: "assistant",
    content: "The deployment uses Cloudflare Workers, not Node.",
    created_at: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeHistoryQuery", () => {
  it("keeps ordinary words", () => {
    expect(normalizeHistoryQuery("deploy plan")).toBe("deploy plan");
  });

  it("drops the characters PostgREST treats as filter syntax", () => {
    expect(normalizeHistoryQuery("deploy,plan:(a)*")).toBe("deploy plan a");
  });

  it("collapses whitespace and caps the length", () => {
    const long = normalizeHistoryQuery(`x${"y".repeat(500)}`);
    expect(long!.length).toBe(MAX_QUERY_CHARS);
    expect(normalizeHistoryQuery("  two   words  ")).toBe("two words");
  });

  it("refuses a query too short to mean anything", () => {
    expect(normalizeHistoryQuery("")).toBeNull();
    expect(normalizeHistoryQuery(" a ")).toBeNull();
    expect(normalizeHistoryQuery("*:*")).toBeNull();
  });
});

describe("makeSnippet", () => {
  it("centres the match instead of showing the head of the message", () => {
    const filler = "a".repeat(400);
    const content = `${filler} the answer is forty-two ${filler}`;
    const snippet = makeSnippet(content, "forty-two");
    expect(snippet).toContain("forty-two");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThan(400);
  });

  it("returns the whole short message when the match is inside it", () => {
    expect(makeSnippet("Use pnpm here.", "pnpm")).toBe("Use pnpm here.");
  });

  it("truncates a long message with no match rather than returning everything", () => {
    const snippet = makeSnippet("z".repeat(1000), "absent");
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThan(400);
  });
});

describe("rankMessages", () => {
  const rows: HistoryRow[] = [
    row({ id: "old", created_at: "2026-09-01T10:00:00.000Z" }),
    row({ id: "new", created_at: "2026-10-20T10:00:00.000Z" }),
    row({ id: "mid", created_at: "2026-10-01T10:00:00.000Z" }),
  ];

  it("returns the newest hit first whatever order the rows arrive in", () => {
    const hits = rankMessages(rows, "deploy", 10);
    expect(hits.map((hit) => hit.id)).toEqual(["new", "mid", "old"]);
  });

  it("honours the cap and reports the whole-message length", () => {
    const hits = rankMessages(rows, "deploy", 2);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.length).toBe(rows[0]!.content.length);
    expect(hits[0]!.snippet).toContain("Cloudflare");
  });

  it("survives a null-ish body without throwing", () => {
    const hits = rankMessages([row({ content: undefined as unknown as string })], "x", 5);
    expect(hits[0]!.snippet).toBe("");
    expect(hits[0]!.length).toBe(0);
  });
});
