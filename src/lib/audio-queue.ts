/**
 * audio-queue.ts — Web Audio playback engine with audio-clock-driven text
 * reveal.
 *
 * Design (Phases 1+2 of the sync plan):
 *  - A single AudioContext is the authoritative clock (ctx.currentTime).
 *  - Clips are decoded AudioBuffers scheduled gaplessly via
 *    AudioBufferSourceNode.start(nextStart(...)) — no per-clip <audio>
 *    elements, so there is no decode/start gap between sentences.
 *  - The visible transcript is revealed from the SAME clock: a rAF loop
 *    computes revealedText(transcript, clips, ctx.currentTime), so text and
 *    audio move in lockstep (word-snapped, ≥1 word at clip start).
 *  - Cancellation / errors / failed TTS / completion all converge on
 *    revealRemaining(): text is never permanently hidden, and every audio
 *    source is stopped.
 *  - A generation counter invalidates every loop/source from before
 *    stopAudio(), so stale callbacks can never touch a newer session.
 *
 * Phase 3: chunks are normalized with toSpeechText() before TTS; the visible
 * transcript keeps the original text (clips index into the raw transcript).
 */

import { speak } from "../functions/speak";
import { findSentenceBoundary, splitIntoSpeechChunks, toSpeechText } from "./speech-text";
import { nextStart, revealedText, type Clip } from "./reveal";

// ─── Module-level playback state ────────────────────────────────────────────

let audioCtx: AudioContext | null = null;
let playbackGeneration = 0;
const activeSources = new Set<AudioBufferSourceNode>();
/** The streaming session stopAudio() should force-reveal. */
let activeSession: StreamingTTSManager | null = null;

function genValid(gen: number): boolean {
  return gen === playbackGeneration;
}

/**
 * Halt all audio immediately: stop every scheduled/playing source, bump the
 * generation so every rAF loop and pump from before this call dies, and
 * reveal the active session's full transcript so text is never left hidden.
 */
export function stopAudio(): void {
  playbackGeneration++;
  for (const src of activeSources) {
    try {
      src.stop();
    } catch {
      // already stopped / never started
    }
  }
  activeSources.clear();
  const session = activeSession;
  activeSession = null;
  session?.forceReveal();
}

async function ensureAudioContext(): Promise<AudioContext | null> {
  try {
    if (!audioCtx || audioCtx.state === "closed") {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === "suspended") {
      // Autoplay policy: resume() usually succeeds because every playback
      // here follows a user gesture (send / mic / click). Race it so a
      // blocked resume can never hang the pipeline.
      await Promise.race([audioCtx.resume(), new Promise((r) => setTimeout(r, 1000))]);
    }
    return audioCtx.state === "running" ? audioCtx : null;
  } catch {
    return null;
  }
}

// ─── TTS fetch + decode ─────────────────────────────────────────────────────

/** Fetch synthesized audio for `text` (normalized for TTS only).
 *  Decode needs the AudioContext, so it happens later in the pump — this
 *  function only fetches, which is what makes prefetch-ahead possible at
 *  queue time. */
async function fetchAudioChunk(text: string): Promise<ArrayBuffer | null> {
  const speech = toSpeechText(text);
  if (!speech) return null; // nothing speakable (e.g. pure markup)
  try {
    const result = await speak({ data: { text: speech } });
    if (!result.audioUrl) {
      console.warn("[AudioQueue] TTS returned no audio:", result.error);
      return null;
    }
    const resp = await fetch(result.audioUrl);
    return await resp.arrayBuffer();
  } catch (err) {
    console.warn("[AudioQueue] TTS fetch failed:", err);
    return null;
  }
}

async function decodeChunk(
  ctx: AudioContext,
  raw: ArrayBuffer | null,
): Promise<AudioBuffer | null> {
  if (!raw) return null;
  try {
    return await ctx.decodeAudioData(raw);
  } catch (err) {
    console.warn("[AudioQueue] decode failed:", err);
    return null;
  }
}

/** Schedule one clip gaplessly at the end of the chain. A null buffer (TTS
 *  failed) produces a zero-duration clip whose text reveals the instant the
 *  clock reaches its start, preserving transcript order without audio. */
function scheduleClipSource(
  ctx: AudioContext,
  clip: Clip,
  buffer: AudioBuffer | null,
  prevEnd: number | null,
  onFirstAudio: (() => void) | undefined,
): number {
  const start = nextStart(prevEnd, ctx.currentTime);
  clip.start = start;

  if (!buffer) {
    clip.end = start; // zero-duration: reveals immediately at `start`
    return start;
  }

  try {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    clip.end = start + buffer.duration;
    source.start(start);
    activeSources.add(source);
    source.onended = () => activeSources.delete(source);
    onFirstAudio?.();
    return clip.end;
  } catch {
    // Context raced to closed — degrade to a failed (instant-reveal) clip.
    clip.end = start;
    return start;
  }
}

// ─── StreamingTTSManager — one spoken reply ─────────────────────────────────

/**
 * True concurrent LLM→TTS streaming. As sentences (or bounded word-boundary
 * segments) complete in the token stream they are queued for TTS — the fetch
 * starts immediately (prefetch-ahead) — while a pump decodes and schedules
 * them gaplessly on the audio clock. A rAF loop reveals exactly what is
 * being spoken at that clock time.
 *
 * Usage:
 *   const tts = new StreamingTTSManager(onSpeaking, shouldAbort, perf?);
 *   tts.setRevealHandler((text) => setMessageBody(text));
 *   for each token: tts.pushToken(token);
 *   when done: await tts.finalize();
 *   if cancelled: tts.cancel();
 */
export class StreamingTTSManager {
  private transcript = "";
  private sentenceBuffer = "";
  /** Prefetch-ahead: one fetch promise per queued clip, in order. */
  private audioQueue: Array<Promise<ArrayBuffer | null>> = [];
  private clips: Clip[] = [];
  private pumpRunning = false;
  private prevEnd: number | null = null;
  private finalized = false;
  private stopped = false;
  private noAudio = false;
  private ttsStarted = false;
  private firstAudioFired = false;
  private perfMarked = false;
  private rafId: number | null = null;
  /** Timer beside rAF: background tabs throttle/stall rAF, and a stalled
   *  reveal would hide a finished reply indefinitely. */
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private lastRevealed = "";
  private readonly driftLogged = new Set<number>();
  private resolveFinished: (() => void) | null = null;
  private finishedPromise: Promise<void> | null = null;
  private ctx: AudioContext | null = null;
  private ctxPromise: Promise<AudioContext | null> | null = null;

  private readonly gen: number;
  private readonly onSpeaking: (speaking: boolean) => void;
  private readonly shouldAbort: (() => boolean) | undefined;
  private readonly perf: ((stage: string) => void) | undefined;
  private revealHandler: ((text: string) => void) | null = null;

  constructor(
    onSpeaking: (speaking: boolean) => void,
    shouldAbort?: () => boolean,
    perf?: (stage: string) => void,
  ) {
    this.onSpeaking = onSpeaking;
    this.shouldAbort = shouldAbort;
    this.perf = perf;
    this.gen = playbackGeneration;

    // Intentional singleton: the module-level session is how stale callbacks get cancelled.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    activeSession = this;
  }

  /** Register the callback that receives the visible transcript prefix. */
  setRevealHandler(fn: (text: string) => void): void {
    this.revealHandler = fn;
  }

  private emitReveal(text: string): void {
    if (text === this.lastRevealed) return;
    this.lastRevealed = text;
    this.revealHandler?.(text);
  }

  /** Reveal the entire transcript (cancel/error/done/no-audio paths). */
  revealRemaining(): void {
    this.emitReveal(this.transcript);
  }

  private get isStopped(): boolean {
    return this.stopped || !genValid(this.gen);
  }

  private ensureCtx(): Promise<AudioContext | null> {
    if (!this.ctxPromise) this.ctxPromise = ensureAudioContext();
    return this.ctxPromise;
  }

  // ── Token intake ─────────────────────────────────────────────────────────

  pushToken(token: string): void {
    if (this.isStopped || this.finalized) return;
    this.sentenceBuffer += token;
    this.transcript += token;

    // Without an audio clock nothing will ever reveal this — do it live.
    if (this.noAudio) {
      this.emitReveal(this.transcript);
      return;
    }

    // Completed sentence → queue immediately.
    const cut = findSentenceBoundary(this.sentenceBuffer, { allowEnd: false });
    if (cut > 0) {
      const sentence = this.sentenceBuffer.slice(0, cut);
      this.sentenceBuffer = this.sentenceBuffer.slice(cut);
      if (sentence.length > 0) this.queueClip(sentence);
      return;
    }

    // Bounded flush at a word boundary so TTS starts before a full stop
    // (bounds worst-case first-audio latency). The FIRST clip uses a smaller
    // threshold: XTTS synth time scales with clip length.
    const flushAt = this.ttsStarted ? 180 : 90;
    if (this.sentenceBuffer.length >= flushAt) {
      const ws = Math.max(
        this.sentenceBuffer.lastIndexOf(" "),
        this.sentenceBuffer.lastIndexOf("\n"),
      );
      if (ws > (this.ttsStarted ? 40 : 20)) {
        const chunk = this.sentenceBuffer.slice(0, ws + 1);
        this.sentenceBuffer = this.sentenceBuffer.slice(ws + 1);
        this.queueClip(chunk);
      } else if (this.sentenceBuffer.length >= 300) {
        // No natural cut point — flush everything to keep latency bounded.
        const chunk = this.sentenceBuffer;
        this.sentenceBuffer = "";
        this.queueClip(chunk);
      }
    }
  }

  /** Queue a transcript slice as a clip. Slices are contiguous exact slices
   *  of the transcript (offsets derived from the previous clip's `to`), so
   *  reveal math and display text can never drift apart. Whitespace-only
   *  slices are queued too — skipping them would break contiguity. */
  private queueClip(text: string): void {
    if (text.length === 0) return;
    const prevTo = this.clips.length > 0 ? this.clips[this.clips.length - 1]!.to : 0;
    this.clips.push({
      from: prevTo,
      to: prevTo + text.length,
      start: Infinity,
      end: 0,
    });

    if (!this.ttsStarted) {
      this.ttsStarted = true;
      this.perf?.("first_sentence_complete");
      this.perf?.("tts_start");
    }

    // Prefetch-ahead: the TTS fetch starts NOW, concurrent with playback of
    // previously scheduled clips and with token streaming.
    this.audioQueue.push(fetchAudioChunk(text));
    if (!this.pumpRunning) {
      this.pumpRunning = true;
      void this.pump();
    }
  }

  // ── Pump: decode + gapless scheduling ────────────────────────────────────

  private async pump(): Promise<void> {
    const ctx = await this.ensureCtx();
    this.ctx = ctx;

    if (!ctx) {
      // Autoplay blocked / no Web Audio: no clock, no audio — reveal all
      // text as it arrives instead of hiding it behind a silent voice.
      this.noAudio = true;
      this.audioQueue = [];
      this.pumpRunning = false;
      this.revealRemaining();
      if (this.finalized && !this.isStopped) this.finish();
      return;
    }

    while (this.audioQueue.length > 0) {
      if (this.isStopped) break;
      const raw = await this.audioQueue.shift()!;
      if (this.isStopped) break;

      const clip = this.clips.find((c) => !Number.isFinite(c.start));
      if (!clip) continue;

      const buffer = await decodeChunk(ctx, raw);
      if (this.isStopped) break;

      scheduleClipSource(ctx, clip, buffer, this.prevEnd, () => {
        if (!this.firstAudioFired) {
          this.firstAudioFired = true;
          this.onSpeaking(true);
        }
      });
      this.prevEnd = clip.end;

      // No audio for this clip (TTS down, or nothing speakable): reveal its
      // own text now instead of waiting on a clock that has nothing to clock.
      // Clip order is preserved, so this can never reveal ahead of the voice.
      if (!buffer) this.emitReveal(this.transcript.slice(0, clip.to));

      if (!this.perfMarked) {
        this.perfMarked = true;
        this.perf?.("tts_first_audio");
        this.perf?.("audio_playback_start");
      }

      // Reveal heart: start (or keep) the rAF loop on the audio clock.
      this.startRevealLoop();
      this.emitReveal(revealedText(this.transcript, this.clips, ctx.currentTime));
    }

    this.pumpRunning = false;
    if (this.isStopped) return;

    // Pump drained. If the reply is finalized and everything played (or no
    // rAF loop is running because no clip was ever scheduled), finish here.
    if (this.finalized && this.audioQueue.length === 0) {
      const last = this.clips[this.clips.length - 1];
      if (!last || (ctx.currentTime >= last.end && !this.hasPendingClips())) {
        this.finish();
      }
    }
  }

  private hasPendingClips(): boolean {
    return this.clips.some((c) => !Number.isFinite(c.start));
  }

  // ── Reveal loop (the synchronisation heart) ──────────────────────────────

  private get loopRunning(): boolean {
    return this.rafId !== null || this.timerId !== null;
  }

  /** Arm exactly one pending tick, on whichever of rAF / timer fires first. */
  private armTick(tick: () => void): void {
    if (this.loopRunning || this.isStopped) return;
    this.rafId = requestAnimationFrame(() => {
      if (this.timerId !== null) {
        clearTimeout(this.timerId);
        this.timerId = null;
      }
      this.rafId = null;
      tick();
    });
    // 60 ms is well below the granularity a reader can notice, and it keeps
    // revealing in a background tab where rAF is throttled to ~1 Hz or paused.
    this.timerId = setTimeout(() => {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.timerId = null;
      tick();
    }, 60);
  }

  private startRevealLoop(): void {
    if (this.loopRunning || this.isStopped) return;
    const tick = () => {
      this.rafId = null;
      if (this.isStopped) return;
      if (this.shouldAbort?.()) {
        this.cancel();
        return;
      }
      const now = this.ctx?.currentTime ?? 0;

      // Clip-boundary drift instrumentation: how late the (rAF-quantised)
      // reveal loop observed each clip's scheduled start.
      for (let i = 0; i < this.clips.length; i++) {
        const c = this.clips[i]!;
        if (Number.isFinite(c.start) && now >= c.start && !this.driftLogged.has(i)) {
          this.driftLogged.add(i);
          if (c.end > c.start) {
            const drift = Math.max(0, (now - c.start) * 1000);
            console.log(`[Sync] clip ${i} boundary drift: ${drift.toFixed(1)}ms`);
          }
        }
      }

      this.emitReveal(revealedText(this.transcript, this.clips, now));

      // Completion: only when the reply is finalized AND every clip is
      // scheduled AND the clock has passed the last one. Before finalize,
      // an idle gap between clips must NOT end the session (tokens may
      // still be streaming).
      const last = this.clips[this.clips.length - 1];
      if (this.finalized && last && now >= last.end && !this.hasPendingClips()) {
        this.revealRemaining();
        this.finish();
        return;
      }
      this.armTick(tick);
    };
    this.armTick(tick);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Flush remaining text and resolve when playback completes (or is
   * cancelled). Never drops the tail: even a 1-char remainder becomes a clip.
   */
  finalize(): Promise<void> {
    if (!this.finalized) {
      this.finalized = true;
      const tail = this.sentenceBuffer;
      this.sentenceBuffer = "";

      if (this.isStopped) {
        // Already cancelled — nothing more to schedule.
      } else if (this.noAudio) {
        this.revealRemaining();
        this.finish();
      } else if (tail.length > 0) {
        this.queueClip(tail);
        // Completion is owned by the pump (if still draining) and/or the
        // rAF loop once every clip is scheduled and the clock passes it.
        if (!this.pumpRunning && this.audioQueue.length === 0) {
          const last = this.clips[this.clips.length - 1];
          if (!last || !Number.isFinite(last.start)) {
            this.finish(); // no clip scheduled and none queued — empty reply
          }
        }
      } else if (!this.pumpRunning && this.audioQueue.length === 0) {
        const last = this.clips[this.clips.length - 1];
        if (!last || (Number.isFinite(last.start) && this.ranPast(last))) {
          this.finish();
        } else if (!this.loopRunning && !this.hasPendingClips()) {
          this.finish();
        } else if (!this.loopRunning) {
          this.startRevealLoop(); // resume tracking for already-scheduled tail
        }
      }
    }
    return this.ensureFinished();
  }

  private ranPast(clip: Clip): boolean {
    return !!this.ctx && Number.isFinite(clip.start) && this.ctx.currentTime >= clip.end;
  }

  private ensureFinished(): Promise<void> {
    if (!this.finishedPromise) {
      this.finishedPromise = new Promise((resolve) => {
        this.resolveFinished = resolve;
      });
    }
    return this.finishedPromise;
  }

  /** Playback ran to completion (called by pump + reveal loop). */
  private finish(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.teardownRaf();
    if (activeSession === this) activeSession = null;
    this.revealRemaining();
    this.onSpeaking(false);
    this.ensureFinished();
    this.resolveFinished?.();
  }

  /** Cancel playback (user abort, kill switch, new message). */
  cancel(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.teardownRaf();
    this.stopSources();
    if (activeSession === this) activeSession = null;
    this.revealRemaining(); // never leave text hidden
    this.onSpeaking(false);
    this.ensureFinished();
    this.resolveFinished?.();
  }

  /** Force-reveal + silence; called by stopAudio() across generations. */
  forceReveal(): void {
    this.stopped = true;
    this.teardownRaf();
    this.revealRemaining();
    this.onSpeaking(false);
    this.ensureFinished();
    this.resolveFinished?.();
  }

  private teardownRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  private stopSources(): void {
    for (const src of activeSources) {
      try {
        src.stop();
      } catch {
        // ignore
      }
    }
    activeSources.clear();
  }
}

// ─── playResponseChunked — whole-text replies (proactive, greeting) ─────────

/**
 * Speak a complete response. Returns true if playback ran to completion,
 * false if aborted early or no audio was possible. `onReveal` receives the
 * visible transcript prefix in sync with the audio clock (and the full text
 * immediately when there is no audio or playback is aborted, so text is
 * never permanently hidden).
 */
export async function playResponseChunked(
  text: string,
  onSpeaking: (speaking: boolean) => void,
  shouldAbort?: (() => boolean) | undefined,
  onReveal?: ((revealed: string) => void) | undefined,
): Promise<boolean> {
  const chunks = splitIntoSpeechChunks(text);
  let lastReveal = "";
  const emit = (t: string) => {
    if (t === lastReveal) return;
    lastReveal = t;
    onReveal?.(t);
  };

  if (chunks.length === 0) {
    emit(text);
    return false;
  }

  const gen = playbackGeneration;
  const ctx = await ensureAudioContext();
  if (!ctx || !genValid(gen)) {
    // No audio possible: reveal everything at once (never hidden).
    emit(text);
    return false;
  }

  const clips: Clip[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    clips.push({ from: offset, to: offset + chunk.length, start: Infinity, end: 0 });
    offset += chunk.length;
  }

  let prevEnd: number | null = null;
  let speakingFired = false;
  let aborted = false;

  for (let i = 0; i < clips.length; i++) {
    if (!genValid(gen) || shouldAbort?.()) {
      aborted = true;
      break;
    }
    const raw = await fetchAudioChunk(chunks[i]!);
    const buffer = await decodeChunk(ctx, raw);
    if (!genValid(gen) || shouldAbort?.()) {
      aborted = true;
      break;
    }
    scheduleClipSource(ctx, clips[i]!, buffer, prevEnd, () => {
      if (!speakingFired) {
        speakingFired = true;
        onSpeaking(true);
      }
    });
    prevEnd = clips[i]!.end;
    emit(revealedText(text, clips, ctx.currentTime));
  }

  if (aborted || !genValid(gen)) {
    emit(text); // never leave text hidden
    onSpeaking(false);
    return false;
  }

  // Track the reveal on the audio clock until the chain completes.
  const last = clips[clips.length - 1]!;
  const completed = await new Promise<boolean>((resolve) => {
    const check = () => {
      if (!genValid(gen) || shouldAbort?.()) {
        emit(text);
        onSpeaking(false);
        resolve(false);
        return;
      }
      const now = ctx.currentTime;
      emit(revealedText(text, clips, now));
      if (now >= last.end) {
        emit(text);
        onSpeaking(false);
        resolve(true);
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });

  return completed;
}
