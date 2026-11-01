/**
 * Scripted AIProvider for offline evals.
 *
 * Implements the real AIProvider interface (chat + chatStream) but returns
 * pre-written replies — including valid `---METADATA---` blocks, malformed
 * metadata, and placeholder-only replies. No network, no model.
 */

import type { AIProvider, ChatMessage, ResponseMetadata } from "../ai/provider";

export type ScriptedReply =
  | string
  | { content: string; metadata?: ResponseMetadata }
  | ((params: { messages: ChatMessage[]; model: string; raw?: boolean }) => string);

export interface ScriptedCall {
  model: string;
  messageCount: number;
  raw: boolean;
}

export class ScriptedProvider implements AIProvider {
  readonly calls: ScriptedCall[] = [];
  private index = 0;

  constructor(private readonly script: ScriptedReply[]) {}

  private next(params: { messages: ChatMessage[]; model: string; raw?: boolean }): {
    content: string;
    metadata?: ResponseMetadata;
  } {
    this.calls.push({
      model: params.model,
      messageCount: params.messages.length,
      raw: params.raw === true,
    });
    const turn = this.script[this.index];
    this.index += 1;
    if (turn === undefined) {
      throw new Error(`scripted provider exhausted after ${this.script.length} turns`);
    }
    if (typeof turn === "function") return { content: turn(params) };
    return typeof turn === "string" ? { content: turn } : turn;
  }

  async chat(params: {
    messages: ChatMessage[];
    model: string;
    signal?: AbortSignal;
    temperature?: number;
    raw?: boolean;
    timeoutMs?: number;
  }): Promise<{ content: string; metadata?: ResponseMetadata }> {
    if (params.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return this.next(params);
  }

  async *chatStream(params: {
    messages: ChatMessage[];
    model: string;
    signal?: AbortSignal;
  }): AsyncGenerator<string, void, unknown> {
    const { content } = this.next(params);
    // Chunk it so streaming consumers see multiple deltas.
    for (let i = 0; i < content.length; i += 8) {
      if (params.signal?.aborted) return;
      yield content.slice(i, i + 8);
    }
  }

  /** Remaining scripted turns (test diagnostics). */
  get remaining(): number {
    return Math.max(0, this.script.length - this.index);
  }
}

/** Build a chat reply with a metadata block appended. */
export function withMetadata(text: string, block: Record<string, unknown>): string {
  return `${text}\n---METADATA--- ${JSON.stringify(block)}`;
}

export const MALFORMED_METADATA_REPLY = "Working on it.\n---METADATA--- not-json";
export const PLACEHOLDER_REPLY = "Done.";
