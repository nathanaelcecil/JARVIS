/**
 * reveal.ts — pure audio-clock → text-reveal math.
 *
 * No DOM / Web Audio imports, so it is unit-testable in the node vitest
 * environment. audio-queue.ts feeds it real AudioContext times.
 *
 * A Clip is a contiguous slice of the visible transcript [from, to) paired
 * with the audio-clock interval [start, end) it is (or will be) spoken in.
 * Reveal state is derived statelessly from (transcript, clips, now), which
 * makes catch-up after a backgrounded tab trivially correct: recompute from
 * the current clock, never incrementally mutate.
 */

import { firstWordEnd, snapToWordEnd } from "./speech-text";

export interface Clip {
  /** Slice of the transcript [from, to). */
  from: number;
  to: number;
  /** Audio-clock interval the clip plays in, once scheduled. */
  start: number;
  end: number;
}

/**
 * Length of the transcript prefix that should be visible at audio-clock
 * time `now`.
 *
 * Rules:
 *  - clip fully in the past            → its whole slice is visible
 *  - now inside [start, end)           → proportional word reveal, snapped
 *                                         to word boundaries so partial words
 *                                         are never shown
 *  - exactly at a clip's start         → its first word is visible (first
 *                                         word appears the instant audio does)
 *  - clip not yet scheduled (start = Infinity) → nothing at/past it reveals
 *  - failed TTS clip (start = end = t) → its slice reveals the instant the
 *    clock reaches t, so text is never permanently hidden
 *
 * The result is monotonically non-decreasing in `now` and never exceeds the
 * last fully-scheduled clip's `to`.
 */
export function revealedLength(transcript: string, clips: Clip[], now: number): number {
  let revealed = 0;

  for (const clip of clips) {
    // Pending clips use start = Infinity: nothing at or past them is revealed
    // until they are scheduled. Zero-duration clips (failed TTS, revealed the
    // instant playback reaches them) satisfy now >= end immediately.
    if (now < clip.start) break; // clock hasn't reached this clip

    if (now >= clip.end) {
      revealed = clip.to;
      continue;
    }

    // Inside the clip: proportional reveal, ≥ first word, word-snapped.
    const frac = (now - clip.start) / (clip.end - clip.start);
    const raw = clip.from + frac * (clip.to - clip.from);
    const floor = firstWordEnd(transcript, clip.from, clip.to);
    const target = Math.max(Math.floor(raw), floor, revealed);
    revealed = snapToWordEnd(transcript, target, clip.to);
    break;
  }

  return Math.min(revealed, transcript.length);
}

/** Visible transcript prefix at audio-clock time `now`. */
export function revealedText(transcript: string, clips: Clip[], now: number): string {
  return transcript.slice(0, revealedLength(transcript, clips, now));
}

/**
 * Schedule time for a clip's audio start: gapless chaining — the next clip
 * starts exactly when the previous ends, unless the clock has already moved
 * past that point (slow TTS), in which case start ASAP at `now + lead`.
 */
export function nextStart(prevEnd: number | null, now: number, lead = 0.02): number {
  if (prevEnd === null) return now + lead;
  return Math.max(prevEnd, now + lead);
}
