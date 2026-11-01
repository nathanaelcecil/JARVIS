/**
 * Unit tests for reveal.ts — audio-clock → text-reveal math and gapless
 * clip scheduling.
 */
import { describe, it, expect } from "vitest";
import { revealedLength, revealedText, nextStart, type Clip } from "./reveal";

/** Build a clip covering [from,to) playing on [start,end). */
function clip(from: number, to: number, start: number, end: number): Clip {
  return { from, to, start, end };
}

const TEXT = "alpha beta gamma delta epsilon zeta eta theta";

describe("revealedLength — clip lifecycle", () => {
  const clips = [
    clip(0, 11, 0, 2), // "alpha beta"   0s–2s
    clip(11, 23, 2, 4), // " gamma delta" 2s–4s
    clip(23, TEXT.length, 4, 6), // " epsilon zeta…" 4s–6s
  ];

  it("reveals nothing before the first clip starts", () => {
    expect(revealedLength(TEXT, clips, -1)).toBe(0);
  });

  it("reveals the first word exactly at clip start", () => {
    const len = revealedLength(TEXT, clips, 0);
    expect(len).toBeGreaterThan(0);
    expect(TEXT.slice(0, len).trim()).toBe("alpha");
  });

  it("reveals proportionally mid-clip, snapped to a word boundary", () => {
    const len = revealedLength(TEXT, clips, 1); // halfway through clip 1
    expect(len).toBeGreaterThan(0);
    expect(len).toBeLessThan(11);
    // Never a partial word: the char at `len` must be a space or end.
    expect(len === TEXT.length || /\s/.test(TEXT[len] ?? "")).toBe(true);
  });

  it("reveals the full clip at its end and continues to the next", () => {
    // At t=2 clip 1 is complete (11) AND clip 2's first word shows, because
    // clip 2's audio also starts at t=2 ("gamma" ends at 16).
    expect(revealedLength(TEXT, clips, 2)).toBe(16);
    const at3 = revealedLength(TEXT, clips, 3);
    expect(at3).toBeGreaterThan(11);
    expect(at3).toBeLessThan(23);
  });

  it("reveals everything after the last clip ends", () => {
    expect(revealedLength(TEXT, clips, 6)).toBe(TEXT.length);
    expect(revealedText(TEXT, clips, 99)).toBe(TEXT);
  });

  it("is monotonically non-decreasing over the clock", () => {
    let prev = 0;
    for (let t = -1; t <= 7; t += 0.1) {
      const len = revealedLength(TEXT, clips, t);
      expect(len).toBeGreaterThanOrEqual(prev);
      prev = len;
    }
  });
});

describe("revealedLength — pending clips (not yet scheduled)", () => {
  it("reveals nothing at or past an unscheduled clip", () => {
    const clips = [
      clip(0, 11, 0, 2),
      clip(11, 23, Infinity, 0), // pending: TTS not scheduled yet
    ];
    expect(revealedLength(TEXT, clips, 5)).toBe(11); // stops at the boundary
  });
});

describe("revealedLength — failed TTS (zero-duration clip)", () => {
  it("reveals the failed clip's text the instant the clock reaches it", () => {
    const clips = [
      clip(0, 11, 0, 2),
      clip(11, 23, 2, 2), // TTS failed: start == end
      clip(23, 38, 3, 5), // next real clip starts a beat later
    ];
    expect(revealedLength(TEXT, clips, 1.99)).toBeLessThan(11);
    // Clock reaches the failed clip → its whole slice shows immediately,
    // so text can never be permanently hidden by a TTS error.
    expect(revealedLength(TEXT, clips, 2)).toBe(23);
    expect(revealedLength(TEXT, clips, 3.5)).toBeGreaterThan(23);
  });
});

describe("revealedLength — cancellation (reveal-everything)", () => {
  it("shows the full transcript when the clock is past every clip", () => {
    // cancel() reveals transcript regardless; the math equivalent is a
    // clock beyond all scheduled audio plus unscheduled tail handling.
    const clips = [clip(0, 11, 0, 1), clip(11, TEXT.length, 1, 2)];
    expect(revealedText(TEXT, clips, 1000)).toBe(TEXT);
  });

  it("empty clip list reveals nothing (reply not started)", () => {
    expect(revealedLength(TEXT, [], 100)).toBe(0);
  });
});

describe("nextStart — gapless consecutive scheduling", () => {
  it("first clip starts at now + lead", () => {
    expect(nextStart(null, 10)).toBeCloseTo(10.02, 5);
  });

  it("next clip starts exactly when the previous ends (no gap)", () => {
    // prevEnd in the future → chain continues with zero gap.
    expect(nextStart(5.5, 3)).toBe(5.5);
  });

  it("falls back to now + lead when TTS fell behind the clock", () => {
    // Previous audio ended at 3s but we only got the buffer at 5s.
    expect(nextStart(3, 5)).toBeCloseTo(5.02, 5);
  });

  it("chained scheduling never overlaps and never gaps", () => {
    // Simulate: decode completes faster than playback, three clips of 1.5s.
    let prevEnd: number | null = null;
    let now = 0;
    const starts: number[] = [];
    const ends: number[] = [];
    for (let i = 0; i < 3; i++) {
      const s = nextStart(prevEnd, now);
      const e = s + 1.5;
      starts.push(s);
      ends.push(e);
      prevEnd = e;
      now = s; // scheduling happens at the clip's start (ahead of time)
    }
    // No gaps: each start equals previous end (except the first).
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeCloseTo(ends[i - 1]!, 10);
    }
    // Strictly increasing overall.
    for (let i = 1; i < ends.length; i++) {
      expect(ends[i]!).toBeGreaterThan(ends[i - 1]!);
    }
  });

  it("respects a custom lead", () => {
    expect(nextStart(null, 0, 0.5)).toBeCloseTo(0.5, 5);
  });
});
