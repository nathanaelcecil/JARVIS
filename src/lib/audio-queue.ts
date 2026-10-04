import { speak } from "../functions/speak";

/**
 * Split text into sentence-level chunks for faster TTS synthesis.
 * Each chunk is 1-2 sentences, max ~200 chars.
 */
function splitIntoChunks(text: string, maxChars = 200): string[] {
  // Split on sentence boundaries (period, exclamation, question mark followed by space or end)
  const sentences = text.match(/[^.!?\n]+[.!?]+\s*/g) || [text];
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.length > 0 ? chunks : [text.slice(0, maxChars)];
}

// ─── Immediate interruption ─────────────────────────────────
// stopAudio() pauses the current Audio element and bumps a generation
// counter that permanently invalidates every playback loop (chunked +
// streaming pump) started before the call — no resume-after-50ms races.

let currentAudio: HTMLAudioElement | null = null;
let playbackGeneration = 0;

/** Halt all audio immediately: pause current clip + invalidate all
 *  queued/looping playback from before this call. */
export function stopAudio(): void {
  playbackGeneration++;
  const audio = currentAudio;
  currentAudio = null;
  if (audio) {
    try {
      audio.pause();
    } catch {
      // already stopped
    }
  }
}

function genValid(gen: number): boolean {
  return gen === playbackGeneration;
}

/**
 * Play a full response sentence-by-sentence.
 * - Sends first chunk to TTS immediately (fast: 2-3s for short text)
 * - Pre-fetches next chunk while current audio plays
 * - Chains playback seamlessly with no gaps
 *
 * Returns true if all chunks played, false if aborted early.
 */
export async function playResponseChunked(
  text: string,
  onSpeaking: (speaking: boolean) => void,
  shouldAbort?: () => boolean,
): Promise<boolean> {
  const chunks = splitIntoChunks(text);
  if (chunks.length === 0) return false;
  const gen = playbackGeneration;

  onSpeaking(true);

  // Pre-fetch the first chunk
  let currentAudioPromise = fetchAudio(chunks[0]!);

  for (let i = 0; i < chunks.length; i++) {
    // Check if we should stop (kill switch, new message, stopAudio, etc.)
    if (shouldAbort?.() || !genValid(gen)) {
      onSpeaking(false);
      return false;
    }

    const audioUrl = await currentAudioPromise;

    // Start pre-fetching next chunk while current plays
    let nextAudioPromise: Promise<string | null> = Promise.resolve(null);
    if (i + 1 < chunks.length && !shouldAbort?.() && genValid(gen)) {
      nextAudioPromise = fetchAudio(chunks[i + 1]!);
    }

    if (audioUrl != null) {
      if (!genValid(gen) || shouldAbort?.()) {
        onSpeaking(false);
        return false;
      }
      await playAudio(audioUrl, gen);
    }

    currentAudioPromise = nextAudioPromise;
  }

  onSpeaking(false);
  return true;
}

async function fetchAudio(text: string): Promise<string | null> {
  try {
    const result = await speak({ data: { text } });
    if (result.audioUrl) return result.audioUrl;
    console.warn("[AudioQueue] TTS returned no audio:", result.error);
    return null;
  } catch (err) {
    console.warn("[AudioQueue] TTS fetch failed:", err);
    return null;
  }
}

function playAudio(url: string, gen: number): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    currentAudio = audio;
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        if (currentAudio === audio) currentAudio = null;
        resolve();
      }
    };
    audio.onended = done;
    audio.onerror = done;
    audio.onpause = done; // stopAudio() must resolve the await instantly
    if (!genValid(gen)) {
      // Stopped before playback even started
      done();
      return;
    }
    audio.play().catch(() => done());
  });
}

/**
 * StreamingTTSManager — true concurrent LLM→TTS streaming. As sentences
 * (or bounded ~180-char segments) complete in the token stream, they are
 * queued for TTS immediately and a playback pump starts speaking while
 * the LLM is still generating.
 *
 * Usage:
 *   const tts = new StreamingTTSManager(onSpeaking, shouldAbort, perf?);
 *   for each token: tts.pushToken(token);
 *   when done: await tts.finalize();
 *   if cancelled: tts.cancel();
 */
export class StreamingTTSManager {
  private sentenceBuffer = "";
  private audioQueue: Promise<string | null>[] = [];
  private pumpRunning = false;
  private finalized = false;
  private cancelled = false;
  private playing = false;
  private ttsStarted = false;
  private firstAudio = false;
  private gen = playbackGeneration;
  private onSpeaking: (speaking: boolean) => void;
  private shouldAbort: (() => boolean) | undefined;
  private perf: ((stage: string) => void) | undefined;

  constructor(
    onSpeaking: (speaking: boolean) => void,
    shouldAbort?: () => boolean,
    perf?: (stage: string) => void,
  ) {
    this.onSpeaking = onSpeaking;
    this.shouldAbort = shouldAbort;
    this.perf = perf;
  }

  pushToken(token: string) {
    if (this.cancelled || this.finalized) return;
    this.sentenceBuffer += token;

    // Complete sentence → queue immediately
    const sentenceEnd = this.sentenceBuffer.match(/[^.!?\n]+[.!?]+\s*/);
    if (sentenceEnd) {
      const sentence = sentenceEnd[0].trim();
      this.sentenceBuffer = this.sentenceBuffer.slice(sentenceEnd[0].length);
      if (sentence.length > 5) this.queueSentence(sentence);
      return;
    }

    // Bounded flush: no sentence boundary yet but the buffer is long —
    // cut at the last comma/space so TTS starts early instead of waiting
    // for a full stop (bounds worst-case first-audio latency). The FIRST
    // chunk of a reply uses a much smaller threshold (~90 chars): XTTS
    // synth time scales with clip length, so a shorter first clip
    // meaningfully cuts REQUEST→FIRST AUDIBLE AUDIO.
    const flushAt = this.ttsStarted ? 180 : 90;
    if (this.sentenceBuffer.length >= flushAt) {
      const cut = Math.max(
        this.sentenceBuffer.lastIndexOf(","),
        this.sentenceBuffer.lastIndexOf(" "),
      );
      if (cut > (this.ttsStarted ? 40 : 20)) {
        const chunk = this.sentenceBuffer.slice(0, cut).trim();
        this.sentenceBuffer = this.sentenceBuffer.slice(cut + 1);
        if (chunk.length > 5) this.queueSentence(chunk);
      } else if (this.sentenceBuffer.length >= 300) {
        // No natural cut point — flush everything to keep latency bounded
        const chunk = this.sentenceBuffer.trim();
        this.sentenceBuffer = "";
        if (chunk.length > 5) this.queueSentence(chunk);
      }
    }
  }

  private queueSentence(text: string) {
    if (!this.ttsStarted) {
      this.ttsStarted = true;
      this.perf?.("first_sentence_complete");
      this.perf?.("tts_start");
    }
    this.audioQueue.push(fetchAudio(text));
    if (!this.pumpRunning) {
      this.pumpRunning = true;
      void this.pump();
    }
  }

  /** Concurrent playback pump: plays clips as their TTS resolves while
   *  the LLM keeps streaming new sentences into the queue. */
  private async pump(): Promise<void> {
    while (!this.cancelled && genValid(this.gen)) {
      const next = this.audioQueue.shift();
      if (!next) {
        if (this.finalized) break;
        await new Promise((r) => setTimeout(r, 30));
        continue;
      }
      const url = await next;
      if (this.cancelled || !genValid(this.gen)) break;
      if (url != null) {
        if (!this.playing) {
          this.playing = true;
          this.onSpeaking(true);
        }
        if (!this.firstAudio) {
          this.firstAudio = true;
          this.perf?.("tts_first_audio");
          this.perf?.("audio_playback_start");
        }
        await playAudio(url, this.gen);
      }
    }
    if (this.playing) {
      this.playing = false;
      this.onSpeaking(false);
    }
    this.pumpRunning = false;
  }

  async finalize(): Promise<boolean> {
    if (this.cancelled) return false;
    this.finalized = true;

    // Flush any remaining text in the buffer
    const tail = this.sentenceBuffer.trim();
    if (tail.length > 10) this.queueSentence(tail);
    this.sentenceBuffer = "";

    // Wait for the pump to drain the queue
    while (this.pumpRunning && !this.cancelled && genValid(this.gen)) {
      await new Promise((r) => setTimeout(r, 30));
    }
    return !this.cancelled;
  }

  /** Immediate interruption: kill the pump, drop queued clips, pause audio. */
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.audioQueue = [];
    this.sentenceBuffer = "";
    stopAudio(); // pauses current clip + invalidates generation
    if (this.playing || this.pumpRunning) {
      this.playing = false;
      this.pumpRunning = false;
      this.onSpeaking(false);
    }
  }
}
