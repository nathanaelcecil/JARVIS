/**
 * speech-text.ts — pure text utilities for the voice pipeline.
 *
 * Everything here is DOM-free and side-effect free so it is unit-testable in
 * the node vitest environment.
 *
 *   - toSpeechText():      normalizes a transcript slice into clear spoken
 *                          language. Used for TTS INPUT ONLY — the visible
 *                          transcript always keeps the original formatting.
 *   - findSentenceBoundary(): streaming-safe sentence detection that never
 *                          splits decimals, initials, or abbreviations.
 *   - splitIntoSpeechChunks(): batch chunking at sentence/word boundaries.
 *   - snapToWordEnd() / firstWordEnd(): word-boundary snapping used by the
 *                          audio-driven text reveal clock.
 */

/** Abbreviations (lowercased, trailing dot already stripped) that must not
 *  end a sentence. Includes dotted forms like "e.g" / "u.s". */
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "etc",
  "inc",
  "ltd",
  "co",
  "corp",
  "dept",
  "est",
  "cf",
  "ca",
  "al",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "approx",
  "vol",
  "fig",
  "ref",
  "min",
  "max",
  "e.g",
  "i.e",
  "u.s",
  "a.m",
  "p.m",
]);

/** Closing quotes/brackets that may follow sentence punctuation. */
const CLOSERS = "\"'”’»)]";

// ─── Sentence boundary detection ────────────────────────────────────────────

export interface BoundaryOptions {
  /** In batch mode a sentence may end at the end of the string. Streaming
   *  passes false so "…for v9." never splits before the "4" token arrives. */
  allowEnd?: boolean;
  /** Absolute index to start scanning from. */
  from?: number;
}

/**
 * Return the absolute index just AFTER the first safe sentence end at or
 * after `from`, or -1 if there is none yet.
 *
 * A boundary requires [.!?] (+ optional closers) followed by whitespace with
 * a following word available (unless allowEnd). It refuses to split after
 * digits (decimals/list markers), single-letter initials, dotted initials,
 * or known abbreviations, and refuses when the next word starts lowercase.
 */
export function findSentenceBoundary(text: string, opts: BoundaryOptions = {}): number {
  const allowEnd = opts.allowEnd ?? true;
  const len = text.length;
  let i = opts.from ?? 0;

  while (i < len) {
    const ch = text[i]!;
    if (ch !== "." && ch !== "!" && ch !== "?") {
      i++;
      continue;
    }

    // Consume the punctuation run (e.g. "!!" or "...").
    let j = i;
    let lastDot = -1;
    while (j < len && (text[j] === "." || text[j] === "!" || text[j] === "?")) {
      if (text[j] === ".") lastDot = j;
      j++;
    }
    // Consume closing quotes/brackets: "…done." → "…done."
    while (j < len && CLOSERS.includes(text[j]!)) {
      if (text[j] === ".") lastDot = j;
      j++;
    }
    const cut = j; // candidate end (exclusive)

    // Must be followed by whitespace, or be the very end of the string.
    const next = cut < len ? text[cut]! : "";
    const atEnd = cut >= len;
    const afterWs = next !== "" && /\s/.test(next);

    if (!atEnd && !afterWs) {
      i = cut; // e.g. decimal "3.14" or abbreviation run — keep scanning
      continue;
    }

    // ---- Non-boundary checks (only meaningful for '.' endings) ----
    if (lastDot >= 0) {
      const pre = text.slice(0, lastDot);
      const m = pre.match(/([A-Za-z.]+)$/);
      if (m) {
        const token = m[1]!.toLowerCase();
        if (ABBREVIATIONS.has(token)) {
          i = cut;
          continue;
        }
        if (token.includes(".")) {
          // Dotted initials: "J. R. R." / "U.S."
          i = cut;
          continue;
        }
        if (token.length === 1) {
          // Single-letter initial: "J. R. R. Tolkien"
          i = cut;
          continue;
        }
      } else if (/\d$/.test(pre)) {
        const digits = pre.match(/\d+$/)?.[0] ?? "";
        const before = pre.slice(0, pre.length - digits.length);
        const bareNumber = before.length === 0 || /[\s([{]$/.test(before);
        if (bareNumber) {
          // Bare number before the period: possible ordered-list marker
          // ("1. Item") — stay conservative and let the next real boundary
          // or the chunk cap decide. Letter+digits ("v9.") is a real end.
          i = cut;
          continue;
        }
      }
    }

    if (atEnd) {
      return allowEnd ? cut : -1;
    }

    // Lookahead: a following word must exist and not start lowercase
    // (catches missed abbreviations like "approx. five…").
    let k = cut;
    while (k < len && /\s/.test(text[k]!)) k++;
    if (k >= len) {
      // Only whitespace to the end of the buffer: wait for more in streaming.
      return allowEnd ? cut : -1;
    }
    if (/[a-z]/.test(text[k]!)) {
      i = cut;
      continue;
    }

    return cut;
  }

  return -1;
}

// ─── Chunking ───────────────────────────────────────────────────────────────

/** Last whitespace at or before `limit` inside [from, limit], or -1. */
function lastWhitespaceBefore(text: string, from: number, limit: number): number {
  const sub = text.slice(from, limit + 1);
  let idx = -1;
  for (const ws of ["\n", " ", "\t"]) {
    const p = sub.lastIndexOf(ws);
    if (p > idx) idx = p;
  }
  return idx === -1 ? -1 : from + idx;
}

/**
 * Split text into TTS chunks of at most `maxChars`, cutting on sentence
 * boundaries where possible and at word boundaries otherwise.
 * The chunks are contiguous, exact slices: joining them reproduces `text`.
 */
export function splitIntoSpeechChunks(text: string, maxChars = 200): string[] {
  if (text.length === 0) return [];
  if (text.length <= maxChars) return [text];

  // Pass 1 — units: sentences, with any over-long sentence hard-split at
  // word boundaries. Units are contiguous exact slices of `text`.
  const units: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const rel = findSentenceBoundary(text, { allowEnd: true, from: pos });
    const unitEnd = rel === -1 ? text.length : rel;
    const unit = text.slice(pos, unitEnd);

    if (unit.length > maxChars) {
      let u = 0;
      while (unit.length - u > maxChars) {
        const relWs = lastWhitespaceBefore(unit, u, u + maxChars);
        const cut = relWs > u ? relWs + 1 : u + maxChars;
        units.push(unit.slice(u, cut));
        u = cut;
      }
      if (u < unit.length) units.push(unit.slice(u));
    } else if (unit.length > 0) {
      units.push(unit);
    }
    pos = unitEnd;
  }

  // Pass 2 — greedy merge: pack adjacent units into chunks up to maxChars.
  const chunks: string[] = [];
  for (const u of units) {
    const prev = chunks[chunks.length - 1];
    if (prev !== undefined && prev.length + u.length <= maxChars) {
      chunks[chunks.length - 1] = prev + u;
    } else {
      chunks.push(u);
    }
  }
  return chunks;
}

// ─── Audio-driven reveal helpers ────────────────────────────────────────────

/**
 * Snap an in-progress reveal index to a word boundary: if `idx` lands inside
 * a word, advance past that word so a partial word is never displayed.
 * Never exceeds `limit`.
 */
export function snapToWordEnd(text: string, idx: number, limit: number): number {
  let i = Math.max(0, Math.min(idx, limit));
  if (i === 0 || i >= limit) return i;
  const inWord = !/\s/.test(text[i]!) && !/\s/.test(text[i - 1]!);
  if (inWord) {
    while (i < limit && !/\s/.test(text[i]!)) i++;
  }
  return i;
}

/** End index of the word starting at `from` (used so the first word of a
 *  clip becomes visible exactly when its audio begins). */
export function firstWordEnd(text: string, from: number, limit: number): number {
  let i = Math.max(0, Math.min(from, limit));
  while (i < limit && !/\s/.test(text[i]!)) i++;
  return i;
}

// ─── TTS normalization ──────────────────────────────────────────────────────

/** Common emoji/symbols → spoken words. Anything not mapped is stripped. */
const EMOJI_MAP: Record<string, string> = {
  "⚙": "gear",
  "⚙️": "gear",
  "✓": "check",
  "✔": "check",
  "✅": "check",
  "⚠": "warning",
  "⚠️": "warning",
  "⏹": "stop",
  "⏹️": "stop",
  "🛑": "stop",
  "⛔": "stop",
  "🔧": "tool",
  "🔒": "locked",
  "📎": "attachment",
  "📧": "email",
  "📅": "calendar",
  "⏸": "pause",
  "⏸️": "pause",
  "▶": "play",
  "▶️": "play",
  "🎙": "microphone",
  "🎙️": "microphone",
  "❤": "heart",
  "❤️": "heart",
  "👍": "thumbs up",
  "👎": "thumbs down",
  "🎉": "celebration",
};

/** Spoken forms for common abbreviations (matched with optional trailing dot). */
const ABBREV_PATTERNS: Array<[RegExp, string]> = [
  [/\be\.g\./gi, "for example"],
  [/\bi\.e\./gi, "that is"],
  [/\betc\./gi, "and so on"],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\bapprox\.(?=\s)/gi, "approximately"],
  [/\bDr\.(?=\s)/g, "Doctor"],
  [/\bMr\.(?=\s)/g, "Mister"],
  [/\bMrs\.(?=\s)/g, "Missus"],
  [/\bProf\.(?=\s)/g, "Professor"],
  [/\bSr\.(?=\s)/g, "Senior"],
  [/\bJr\.(?=\s)/g, "Junior"],
  [/\bw\/o\b/g, "without"],
  [/\bw\/(?=\s|$)/g, "with"],
  [/\bASAP\b/g, "as soon as possible"],
  [/\bFAQs\b/g, "frequently asked questions"],
  [/\bFAQ\b/g, "frequently asked question"],
  [/\bCLI\b/g, "C L I"],
  [/\bAPI\b/g, "A P I"],
  [/\bUI\b/g, "U I"],
  [/\bLLM\b/g, "large language model"],
  [/\bTTS\b/g, "text to speech"],
  [/\bSTT\b/g, "speech to text"],
  [/\bXTTS\b/g, "X T T S"],
  [/\bGPU\b/g, "G P U"],
  [/\bCPU\b/g, "C P U"],
  [/\bRAM\b/g, "R A M"],
];

/** Convert a single URL into naturally spoken words. */
function urlToSpeech(raw: string): string {
  let u = raw.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "");
  // Strip trailing sentence punctuation we should keep outside the URL.
  const trailing = u.match(/[.,;:!?]+$/)?.[0] ?? "";
  u = u.replace(/[.,;:!?]+$/, "");
  const spoken = u
    .replace(/\//g, " slash ")
    .replace(/\./g, " dot ")
    .replace(/-/g, " dash ")
    .replace(/_/g, " underscore ")
    .replace(/\?/g, " question mark ")
    .replace(/&/g, " and ")
    .replace(/=/g, " equals ")
    .replace(/%/g, " percent ")
    .replace(/#/g, " hash ");
  return spoken.replace(/\s+/g, " ").trim() + trailing;
}

/**
 * Normalize text FOR TTS ONLY. The visible transcript is never modified by
 * this function. Guarantees:
 *   - decimals ("3.14") and code fences survive untouched structurally
 *   - URLs, abbreviations, version numbers, emoji and code operators become
 *     natural spoken language
 *   - output is single-spaced, trimmed text with no markdown syntax
 */
export function toSpeechText(raw: string): string {
  let t = raw;

  // Fenced code blocks: never read code aloud — drop the block content.
  t = t.replace(/```[\s\S]*?```/g, " ");
  // Inline code: keep the content, drop the backticks.
  t = t.replace(/`([^`]+)`/g, "$1");
  // Images → alt text; links → link text.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Headings, bullets, emphasis, horizontal rules.
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/^\s*\d+\.\s+/gm, (m) => m.replace(/[.]/, ""));
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  t = t.replace(/__([^_\n]+)__/g, "$1");
  t = t.replace(/\*([^*\n]+)\*/g, "$1");
  t = t.replace(/^\s*={3,}\s*$/gm, " ");
  t = t.replace(/^\s*-{3,}\s*$/gm, " ");

  // URLs (before other punctuation rules mangle them).
  t = t.replace(/\b(?:https?:\/\/|www\.)[^\s<>()[\]]+/g, (m) => urlToSpeech(m));

  // Code operators / syntax → spoken equivalents.
  t = t.replace(/=>/g, " yields ");
  t = t.replace(/->/g, " to ");
  t = t.replace(/===/g, " equals ");
  t = t.replace(/!==/g, " does not equal ");
  t = t.replace(/==/g, " equals ");
  t = t.replace(/!=/g, " does not equal ");
  t = t.replace(/&&/g, " and ");
  t = t.replace(/\|\|/g, " or ");
  t = t.replace(/\{\s*\}/g, " ");
  t = t.replace(/\[\s*\]/g, " ");
  t = t.replace(/\(\s*\)/g, " ");
  t = t.replace(/[{}/;<>]/g, " ");
  t = t.replace(/\\n/g, " ");
  // snake_case identifiers → "snake case"
  t = t.replace(/\b([a-z0-9]+)_([a-z0-9]+)\b/g, "$1 $2");

  // Version numbers: "v9.4" → "version 9.4", "v2" → "version 2".
  t = t.replace(/\bv(\d+(?:\.\d+)+)/gi, "version $1");
  t = t.replace(/\bv(\d+)\b/gi, "version $1");
  t = t.replace(/\bREV\s+(\d+(?:\.\d+)*)/gi, "revision $1");

  // Abbreviations and acronyms.
  for (const [re, spoken] of ABBREV_PATTERNS) {
    t = t.replace(re, spoken);
  }

  // Currency: "$5" → "5 dollars" (keeps decimals intact: "$5.50" → "5.50 dollars").
  t = t.replace(/\$(\d+(?:\.\d+)?)/g, "$1 dollars");
  t = t.replace(/(\d)%/g, "$1 percent");

  // Emoji / symbols.
  for (const [emoji, spoken] of Object.entries(EMOJI_MAP)) {
    t = t.split(emoji).join(" " + spoken + " ");
  }
  // (FE0F gets its own pass — a combining mark inside a character class is
  // flagged by lint and unsupported by tsc; the stripped set is identical.)
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{200D}]/gu, " ");
  t = t.replace(/\u{FE0F}/gu, " ");

  // Punctuation that should become a natural pause or plain punctuation.
  t = t.replace(/[—–]/g, ", ");
  t = t.replace(/…/g, "... ");
  t = t.replace(/[•●▪]/g, " ");
  t = t.replace(/[→⟶]/g, " to ");
  t = t.replace(/[←]/g, " from ");
  t = t.replace(/[©]/g, " copyright ");
  t = t.replace(/[™®]/g, " ");
  t = t.replace(/[“”]/g, '"');
  t = t.replace(/[‘’]/g, "'");
  t = t.replace(/\|/g, " ");

  // Collapse whitespace (never touch the decimal points inside digits).
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\s*\n\s*/g, " ");
  t = t.replace(/ +([,.!?;:])/g, "$1");
  t = t.replace(/([,.!?;:]){2,}/g, "$1");
  return t.trim();
}
