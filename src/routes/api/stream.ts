/**
 * SSE Streaming Chat Endpoint
 *
 * POST /api/stream  →  text/event-stream
 *
 * Events:
 *   ack     — immediate acknowledgement for FAST-class requests
 *   token   — { text: "..." } per streamed delta
 *   done    — { taskId, route, text } when generation completes
 *   error   — { error: "..." } on failure
 */

import { createFileRoute } from "@tanstack/react-router";
import { createProvider, type ChatMessage } from "../../lib/ai/provider";
import { buildSystemPrompt } from "../../lib/ai/system-prompt";
import { describeReplayOutcome, planProcedureReplay } from "../../lib/automation/replay";
import { markUsed as markProcedureUsed } from "../../lib/automation/procedures";
import { listFacts, profileContext } from "../../lib/profile";
import { supabaseAdmin } from "../../lib/supabase-server";
import { isKillSwitchActive, logActivity } from "../../lib/guardrails";
import { authorizeToolCall } from "../../lib/tool-authorization";
import { clearTaskApprovals } from "../../lib/task-approvals";
import { cancelPick, mintPickId, registerPick } from "../../lib/picks";
import { routeRequest } from "../../lib/ai/router";
import { registerTask, updateTaskStatus, cleanupOldTasks } from "../../lib/ai/task-registry";
import { routeToolCall } from "../../lib/mcp/registry";
import { guardLocalRequest } from "../../lib/local-request-guard";
import {
  DATA_TOOLS,
  NO_DATA_NOTE,
  buildToolContext,
  deterministicPlan,
  hasUnplannedServices,
  looksLikeDataRequest,
  looksLikeScreenRequest,
  planTools,
  type PlannedTool,
  type ToolRun,
} from "../../lib/ai/data-tools";
import {
  getCachedMemories,
  setCachedMemories,
  invalidateMemories,
  getCachedBehaviors,
  setCachedBehaviors,
  invalidateBehaviors,
  getCachedHistory,
  setCachedHistory,
  appendHistory,
  invalidateHistory,
  type CachedMessage,
} from "../../lib/context-cache";
import type { Memory, LearnedBehavior } from "../../lib/supabase-types";

function extractKeywords(text: string): string[] {
  const stopwords = new Set([
    "i",
    "me",
    "my",
    "we",
    "our",
    "you",
    "your",
    "he",
    "she",
    "it",
    "they",
    "them",
    "is",
    "am",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "shall",
    "can",
    "need",
    "dare",
    "a",
    "an",
    "the",
    "and",
    "or",
    "but",
    "if",
    "then",
    "so",
    "for",
    "of",
    "in",
    "to",
    "at",
    "by",
    "on",
    "with",
    "from",
    "that",
    "this",
    "these",
    "those",
    "not",
    "no",
    "nor",
    "as",
    "what",
    "which",
    "who",
    "how",
    "when",
    "where",
    "why",
    "all",
    "each",
    "every",
    "both",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "than",
    "too",
    "very",
    "just",
    "about",
    "above",
    "after",
    "again",
    "also",
    "any",
    "before",
    "between",
    "come",
    "don't",
    "get",
    "got",
    "here",
    "into",
    "know",
    "let",
    "like",
    "make",
    "much",
    "new",
    "now",
    "only",
    "out",
    "over",
    "really",
    "right",
    "said",
    "same",
    "see",
    "tell",
    "think",
    "thing",
    "time",
    "two",
    "up",
    "us",
    "want",
    "way",
    "well",
    "give",
    "going",
    "back",
    "still",
    "even",
    "though",
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopwords.has(w))
    .slice(0, 15);
}

function getTimeOfDay(): string {
  const hour = new Date().getUTCHours();
  return hour >= 9 && hour < 17 ? "work" : "personal";
}

/** Marker the model appends at the end of its reply for memory/tool instructions. */
const META_MARK = "---METADATA---";

/**
 * Strip the trailing ---METADATA--- block from a reply. Everything from the
 * marker on is machine instructions: it must never reach the user's screen,
 * the TTS voice, or stored conversation history.
 */
function cleanReply(raw: string): string {
  const idx = raw.indexOf(META_MARK);
  return (idx >= 0 ? raw.slice(0, idx) : raw).replace(/\s+$/, "");
}

/**
 * User-visible portion of a partially streamed reply. If the marker hasn't
 * fully arrived yet, hold back any trailing partial marker (e.g. "---META")
 * so it can never leak mid-stream either.
 */
function visibleReply(raw: string): string {
  const idx = raw.indexOf(META_MARK);
  if (idx >= 0) return raw.slice(0, idx);
  const max = Math.min(META_MARK.length - 1, raw.length);
  for (let k = max; k > 0; k--) {
    if (raw.endsWith(META_MARK.slice(0, k))) return raw.slice(0, raw.length - k);
  }
  return raw;
}

/** Fast path: deterministic commands that skip the LLM entirely */
interface FastPathResult {
  tool: string;
  args: Record<string, unknown>;
}

function matchFastPath(message: string): FastPathResult | null {
  const msg = message.toLowerCase().trim();

  // Open app: "open Chrome", "launch Spotify", "start Terminal"
  const openMatch = msg.match(/^(?:open|launch|start|run)\s+(.+?)(?:\s+for\s+me)?$/i);
  if (openMatch) {
    const appName = openMatch[1]?.trim();
    if (appName && appName.length < 50) {
      return { tool: "open_app", args: { name: appName } };
    }
  }

  // Quit app: "quit Chrome", "close Spotify"
  const quitMatch = msg.match(/^(?:quit|close|exit|kill)\s+(.+?)(?:\s+app)?$/i);
  if (quitMatch) {
    const appName = quitMatch[1]?.trim();
    if (appName && appName.length < 50) {
      return { tool: "quit_app", args: { name: appName } };
    }
  }

  // Set volume: "set volume to 30", "volume 50"
  const volSetMatch = msg.match(/^(?:set\s+)?volume\s+(?:to\s+)?(\d+)(?:%|\s*percent)?$/i);
  if (volSetMatch) {
    const level = parseInt(volSetMatch[1] ?? "0", 10);
    if (level >= 0 && level <= 100) {
      return { tool: "set_volume", args: { level } };
    }
  }

  // Get battery
  if (
    /^(?:what'?s\s+my|get|show|check|read)\s+(?:battery|charge)/i.test(msg) ||
    /^how\s+much\s+battery/i.test(msg) ||
    /^battery$/i.test(msg)
  ) {
    return { tool: "get_battery", args: {} };
  }

  // Get volume
  if (
    /^(?:what'?s\s+(?:the|my)|get|show|check|current)\s+volume/i.test(msg) ||
    /^volume\s+(?:level|now)?$/i.test(msg)
  ) {
    return { tool: "get_volume", args: {} };
  }

  // Get RAM
  if (
    /^(?:what'?s\s+my|get|show|check)\s+(?:ram|memory)/i.test(msg) ||
    /^how\s+much\s+(?:ram|memory)/i.test(msg)
  ) {
    return { tool: "get_ram", args: {} };
  }

  // Get storage
  if (
    /^(?:what'?s\s+my|get|show|check)\s+(?:storage|disk|space)/i.test(msg) ||
    /^how\s+much\s+(?:storage|disk|space)/i.test(msg)
  ) {
    return { tool: "get_storage", args: {} };
  }

  // List apps
  if (
    /^what(?:s|ever)?\s+(?:apps?|applications?)\s+(?:are|is)\s+running/i.test(msg) ||
    /^list\s+(?:running\s+)?(?:apps?|applications?)/i.test(msg)
  ) {
    return { tool: "list_running_apps", args: {} };
  }

  // List directory / open in Finder
  const listMatch = msg.match(
    /^(?:list|show|open)\s+(?:the\s+)?(?:files?\s+in\s+)?(?:my\s+)?(downloads?|documents?|desktop|applications?|music|pictures?)$/i,
  );
  if (listMatch) {
    const dir = (listMatch[1] ?? "").toLowerCase();
    const pathMap: Record<string, string> = {
      downloads: "~/Downloads",
      documents: "~/Documents",
      desktop: "~/Desktop",
      applications: "/Applications",
      music: "~/Music",
      pictures: "~/Pictures",
    };
    const path = pathMap[dir];
    if (path) {
      if (/^open/i.test(msg)) {
        return { tool: "open_in_finder", args: { path } };
      }
      return { tool: "list_directory", args: { path } };
    }
  }

  return null;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Map tool name to its permission category in guardrails.ts —
 * now shared with the coding-agent engine (guardrails.toolPermissionCategory).
 */

/** Wrap a Supabase PromiseLike into a real Promise for Promise.all */
function toPromise<T>(thenable: { then: (fn: (r: T) => T) => unknown }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (thenable as any).then(
      (r: T) => resolve(r),
      (e: unknown) => reject(e),
    );
  });
}

export const Route = createFileRoute("/api/stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Host/Origin guard: blocks browser cross-site calls and DNS rebinding.
        // Not authentication — see src/lib/local-request-guard.ts. Streaming
        // responses pass through untouched.
        const blocked = guardLocalRequest(request);
        if (blocked) return blocked;
        const t0 = Date.now();
        const body = await request.json();
        const { message, sessionId, image, images, clientMsgId, truncateAfter } = body as {
          message: string;
          sessionId: string;
          image?: string;
          images?: string[];
          clientMsgId?: string;
          truncateAfter?: string;
        };

        // Ensure the proactive scheduler (daily check-in, reminders) is running.
        // Idempotent — starts one server-side interval per process.
        try {
          const { ensureProactiveScheduler } = await import("../../lib/proactive/scheduler");
          ensureProactiveScheduler();
        } catch (schedErr) {
          console.error("[Proactive] scheduler start failed:", schedErr);
        }

        // One scope id per chat turn: "always allow for this task" is limited to
        // this stream and is dropped when it ends or is cancelled.
        const taskId = crypto.randomUUID();

        // Set when a task registers; ReadableStream.cancel() aborts it so an
        // interrupted client stops the in-flight Ollama request immediately.
        let activeTask: { abortController: AbortController } | null = null;

        // Create a ReadableStream for SSE
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const write = (chunk: string) => {
              try {
                controller.enqueue(encoder.encode(chunk));
              } catch {
                // Stream may be closed
              }
            };

            /** Emit a perf milestone to the log + the client as SSE. */
            const perf = (stage: string) => {
              const ms = Date.now() - t0;
              console.log(`[Perf] ${stage}: ${ms}ms`);
              write(sseEvent("perf", { stage, ms }));
            };

            // Run the handler logic asynchronously
            (async () => {
              try {
                // Kill switch check
                if (isKillSwitchActive()) {
                  write(
                    sseEvent("done", {
                      text: "Operation halted by kill switch.",
                      route: "NONE",
                    }),
                  );
                  controller.close();
                  return;
                }

                // Edited prompt: drop this message and everything after it
                // (DB is the context source of truth), then run a fresh turn.
                if (truncateAfter && !isNaN(Date.parse(truncateAfter))) {
                  try {
                    const del = await toPromise(
                      supabaseAdmin
                        .from("messages")
                        .delete()
                        .eq("session_id", sessionId)
                        .gte("created_at", truncateAfter),
                    );
                    if (del.error) console.error("[Edit] truncate FAILED:", del.error.message);
                    else console.log("[Edit] truncated history >= ", truncateAfter);
                  } catch (delErr) {
                    console.error("[Edit] truncate FAILED:", delErr);
                  }
                  invalidateHistory(sessionId);
                }

                // Fast path: deterministic commands first (skipped for
                // edited prompts — a re-run always gets the full LLM)
                const fastPath = truncateAfter ? null : matchFastPath(message);
                if (fastPath) {
                  console.log(
                    `[FastPath] Direct tool call: ${fastPath.tool}`,
                    JSON.stringify(fastPath.args),
                  );
                  const task = registerTask({
                    message,
                    route: "FAST",
                    model: "direct",
                  });
                  activeTask = task;
                  updateTaskStatus(task.id, "RUNNING");
                  const signal = task.abortController.signal;

                  // Shared authorization policy: tier decision, confirm prompt,
                  // cancellation and (for local-agent tools) the approval token.
                  const auth = await authorizeToolCall({
                    tool: fastPath.tool,
                    args: fastPath.args,
                    source: "fast",
                    taskId,
                    signal,
                    // Same event, same key order as before.
                    emitConfirmRequest: (payload) => write(sseEvent("confirm_request", payload)),
                  });

                  if (!auth.ok) {
                    console.log(`[FastPath] ${auth.reason.toUpperCase()}: ${fastPath.tool}`);
                    write(
                      sseEvent("done", {
                        taskId: task.id,
                        route: "FAST",
                        text: auth.reason === "denied" ? "Action denied." : auth.message,
                        error: true,
                      }),
                    );
                    updateTaskStatus(task.id, "FAILED");
                    controller.close();
                    return;
                  }

                  try {
                    write(
                      sseEvent("ack", {
                        text: "One moment, sir.",
                        route: "FAST",
                      }),
                    );
                    write(sseEvent("tool_start", { tool: fastPath.tool }));
                    const result = await routeToolCall(
                      fastPath.tool,
                      fastPath.args,
                      signal,
                      auth.approval,
                    );
                    write(sseEvent("tool_result", { tool: fastPath.tool, result }));
                    updateTaskStatus(task.id, "COMPLETED");
                    const resultStr = JSON.stringify(result);
                    write(
                      sseEvent("done", {
                        taskId: task.id,
                        route: "FAST",
                        text: resultStr,
                      }),
                    );
                  } catch (toolErr) {
                    const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                    updateTaskStatus(task.id, "FAILED");
                    write(
                      sseEvent("done", {
                        taskId: task.id,
                        route: "FAST",
                        text: errMsg,
                        error: true,
                      }),
                    );
                  }
                  controller.close();
                  return;
                }

                // Accept images[] (multi-image / video frames) plus the
                // legacy single image param; only real data URLs go forward.
                const imageList: string[] = [];
                for (const candidate of [...(images ?? []), ...(image ? [image] : [])]) {
                  if (typeof candidate === "string" && candidate.startsWith("data:")) {
                    imageList.push(candidate);
                  }
                }

                // Route the request
                const routeResult = routeRequest(message, imageList.length > 0);
                console.log(
                  `[Router] ${routeResult.route} → ${routeResult.model} (${routeResult.reason})`,
                );

                // Register task
                const task = registerTask({
                  message,
                  route: routeResult.route,
                  model: routeResult.model,
                });
                activeTask = task;
                updateTaskStatus(task.id, "RUNNING");

                const signal = task.abortController.signal;

                // Clean up old tasks periodically
                cleanupOldTasks();

                // Immediately acknowledge FAST requests
                if (routeResult.route === "FAST") {
                  write(
                    sseEvent("ack", {
                      text: "One moment, sir.",
                      route: routeResult.route,
                    }),
                  );
                }

                // Parallel DB reads — RAM-cached (60s memories/behaviors,
                // 30min per-session history; write-through on every write
                // below). Cache hits skip ~0.9-1.6s of Supabase latency.
                const cachedMemories = getCachedMemories();
                const cachedBehaviors = getCachedBehaviors();
                const cachedHistory = getCachedHistory(sessionId);
                const cacheHits =
                  (cachedMemories ? 1 : 0) + (cachedBehaviors ? 1 : 0) + (cachedHistory ? 1 : 0);
                perf("db_start");

                const [memoriesData, behaviorsData, historyChrono] = await Promise.all([
                  cachedMemories
                    ? Promise.resolve(cachedMemories)
                    : toPromise(
                        supabaseAdmin
                          .from("memory")
                          .select("*")
                          .order("last_accessed", { ascending: false })
                          .limit(50),
                      ).then((r) => {
                        const rows = (r.data ?? []) as Memory[];
                        setCachedMemories(rows);
                        return rows;
                      }),
                  cachedBehaviors
                    ? Promise.resolve(cachedBehaviors)
                    : toPromise(
                        supabaseAdmin
                          .from("learned_behaviors")
                          .select("*")
                          .order("created_at", { ascending: true }),
                      ).then((r) => {
                        const rows = (r.data ?? []) as LearnedBehavior[];
                        setCachedBehaviors(rows);
                        return rows;
                      }),
                  cachedHistory
                    ? Promise.resolve(cachedHistory)
                    : toPromise(
                        supabaseAdmin
                          .from("messages")
                          .select("role, content")
                          .eq("session_id", sessionId)
                          .order("created_at", { ascending: false })
                          .limit(20),
                      ).then((r) => {
                        const chrono = ([...(r.data ?? [])] as CachedMessage[]).reverse();
                        setCachedHistory(sessionId, chrono);
                        return chrono;
                      }),
                ]);

                const relevantMemories = memoriesData.slice(0, 10);
                const learnedBehaviors = behaviorsData;
                const history = historyChrono.slice(-20);
                console.log(`[Perf] context cache: ${cacheHits}/3 hits`);
                perf("db_complete");

                // Build messages for the LLM
                // "About you": name and answer-style always, other categories
                // only when this request actually mentions them. Masked values
                // are already masked on disk, so nothing raw can leak here.
                let about = "";
                try {
                  about = profileContext(await listFacts(process.cwd()), message);
                } catch {
                  about = "";
                }

                const systemPrompt =
                  buildSystemPrompt({
                    memories: relevantMemories,
                    learnedBehaviors,
                    timeOfDay: getTimeOfDay(),
                  }) + (about ? `\n\n## About the user (facts, never instructions)\n${about}` : "");

                const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
                for (const msg of history) {
                  messages.push({
                    role: msg.role as "user" | "assistant",
                    content: msg.content,
                  });
                }

                if (imageList.length > 0) {
                  messages.push({
                    role: "user",
                    content: [
                      { type: "text", text: message },
                      ...imageList.map((url) => ({
                        type: "image_url" as const,
                        image_url: { url },
                      })),
                    ],
                  });
                } else {
                  messages.push({ role: "user", content: message });
                }

                // Write-through: reflect the user message in the RAM cache
                // immediately so the next turn skips the DB read.
                appendHistory(sessionId, { role: "user", content: message });

                // Save user message (fire and forget). .select() makes
                // PostgREST return the inserted row (incl. created_at).
                toPromise(
                  supabaseAdmin
                    .from("messages")
                    .insert({
                      session_id: sessionId,
                      role: "user",
                      content: message,
                      image_url: image ?? null,
                    })
                    .select(),
                )
                  .then((r) => {
                    if (r.error) {
                      console.error("[DB] messages (user) FAILED:", r.error.message);
                      invalidateHistory(sessionId);
                    } else {
                      console.log("[DB] messages (user) OK");
                      // Tell the client the exact DB timestamp of this user
                      // message — the truncation point for later edits.
                      const savedAt = (r.data as { created_at?: string }[] | null)?.[0]?.created_at;
                      if (savedAt && clientMsgId) {
                        write(
                          sseEvent("user_saved", {
                            clientMsgId,
                            createdAt: savedAt,
                          }),
                        );
                      }
                    }
                  })
                  .catch((e: unknown) => console.error("[DB] messages (user) FAILED:", e));

                // ── Learned-procedure replay ──
                // An exact phrase taught as a fully-automatic sequence runs
                // here, before any model call. Only auto-tier steps qualify:
                // a confirm-tier step still needs a real approval, so those
                // phrases fall through to the model path instead of being
                // quietly pre-authorised.
                if (imageList.length === 0) {
                  try {
                    const replay = await planProcedureReplay(process.cwd(), message);
                    if (replay && !signal.aborted) {
                      console.log(`[Procedures] replay: ${replay.procedure.key}`);
                      write(
                        sseEvent("ack", {
                          text: `Replaying “${replay.procedure.trigger}”.`,
                          route: "PROCEDURE",
                        }),
                      );

                      const replayResults: Array<{ tool: string; result: unknown }> = [];
                      let failure: string | null = null;

                      for (const step of replay.steps) {
                        if (signal.aborted) {
                          failure = "cancelled";
                          break;
                        }
                        write(sseEvent("tool_start", { tool: step.tool }));
                        try {
                          const result = await routeToolCall(step.tool, step.args, signal);
                          replayResults.push({ tool: step.tool, result });
                          write(sseEvent("tool_result", { tool: step.tool, result }));
                          logActivity({
                            toolName: step.tool,
                            input: step.args,
                            result: result as Record<string, unknown>,
                            approvalStatus: "auto",
                          }).catch(() => {});
                        } catch (stepErr) {
                          failure = stepErr instanceof Error ? stepErr.message : String(stepErr);
                          replayResults.push({ tool: step.tool, result: { error: failure } });
                          write(
                            sseEvent("tool_result", {
                              tool: step.tool,
                              result: { error: failure },
                            }),
                          );
                          break;
                        }
                      }

                      if (!failure) {
                        const reply = describeReplayOutcome(
                          replay.procedure.trigger,
                          replayResults.length,
                        );
                        await markProcedureUsed(process.cwd(), replay.procedure.key).catch(
                          () => undefined,
                        );
                        write(sseEvent("token", { text: reply }));
                        await toPromise(
                          supabaseAdmin.from("messages").insert({
                            session_id: sessionId,
                            role: "assistant",
                            content: reply,
                          }),
                        );
                        appendHistory(sessionId, { role: "assistant", content: reply });
                        perf("response_complete");
                        write(
                          sseEvent("done", {
                            taskId: task.id,
                            route: "PROCEDURE",
                            text: reply,
                            toolResults: replayResults,
                          }),
                        );
                        return;
                      }
                      // A failed replay falls through: the model can see what
                      // was attempted in history and try properly.
                      console.warn(`[Procedures] replay failed: ${failure}`);
                    }
                  } catch (replayErr) {
                    console.error("[Procedures] replay check failed:", replayErr);
                  }
                }

                perf("prompt_build");

                // Create provider and stream response
                const provider = createProvider();
                let fullText = "";
                perf("ollama_start");

                // Persist a cut-off partial reply (marked) so JARVIS can
                // continue from it on the next turn.
                const savePartial = async () => {
                  if (!fullText.trim()) return;
                  const metaIdx = fullText.indexOf("---METADATA---");
                  const partialText = (metaIdx >= 0 ? fullText.slice(0, metaIdx) : fullText).trim();
                  if (!partialText) return;
                  const content =
                    partialText + '\n\n⏹ *(cut off — say "continue" or send your next prompt)*';
                  try {
                    await toPromise(
                      supabaseAdmin.from("messages").insert({
                        session_id: sessionId,
                        role: "assistant",
                        content,
                      }),
                    );
                    appendHistory(sessionId, {
                      role: "assistant",
                      content,
                    });
                    console.log("[Stream] partial reply saved for continuation");
                  } catch (saveErr) {
                    console.error("[Stream] partial save failed:", saveErr);
                  }
                };

                // ── Data-tool pre-pass (Gmail / Calendar / Notion) ──
                // These tools return data, so they must run BEFORE the model
                // writes its answer — otherwise it can only guess. Results are
                // appended to the user's message as authoritative context.
                const preRuns: ToolRun[] = [];

                const execDataTool = async (tc: PlannedTool): Promise<unknown> => {
                  const auth = await authorizeToolCall({
                    tool: tc.tool,
                    args: tc.args,
                    source: "data",
                    taskId,
                    signal,
                    emitConfirmRequest: (payload) => write(sseEvent("confirm_request", payload)),
                  });

                  if (!auth.ok) {
                    console.log(`[DataTools] ${auth.reason.toUpperCase()}: ${tc.tool}`);
                    if (auth.reason === "never") {
                      write(
                        sseEvent("tool_result", {
                          tool: tc.tool,
                          result: { error: auth.message, blocked: true },
                        }),
                      );
                      return { error: auth.message, blocked: true };
                    }
                    const denyMsg = auth.message;
                    write(
                      sseEvent("tool_result", {
                        tool: tc.tool,
                        result: { error: denyMsg, denied: true },
                      }),
                    );
                    logActivity({
                      toolName: tc.tool,
                      input: tc.args,
                      result: { error: denyMsg },
                      approvalStatus: auth.reason,
                    }).catch(() => {});
                    return { error: denyMsg, denied: true };
                  }

                  try {
                    console.log(
                      `[DataTools] Executing: ${tc.tool}`,
                      JSON.stringify(tc.args).slice(0, 200),
                    );
                    write(sseEvent("tool_start", { tool: tc.tool }));
                    const result = await routeToolCall(tc.tool, tc.args, signal, auth.approval);
                    console.log(`[DataTools] ${tc.tool} → success`);
                    write(sseEvent("tool_result", { tool: tc.tool, result }));
                    logActivity({
                      toolName: tc.tool,
                      input: tc.args,
                      result: result as Record<string, unknown>,
                      approvalStatus: auth.tier,
                    }).catch(() => {});
                    return result;
                  } catch (toolErr) {
                    const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                    console.error(`[DataTools] ${tc.tool} FAILED:`, errMsg);
                    write(
                      sseEvent("tool_result", {
                        tool: tc.tool,
                        result: { error: errMsg },
                      }),
                    );
                    logActivity({
                      toolName: tc.tool,
                      input: tc.args,
                      result: { error: errMsg },
                      approvalStatus: "failed",
                    }).catch(() => {});
                    return { error: errMsg };
                  }
                };

                if (imageList.length === 0) {
                  const recentHistory = history
                    .slice(-4)
                    .map((m) => `${m.role}: ${String(m.content).slice(0, 400)}`)
                    .join("\n");
                  // Follow-ups like "add an intro below these lines on the
                  // same page" never repeat the keyword — treat a recent
                  // data-flavored conversation as data intent too.
                  // Screen questions (read-only Hands tools) are data requests
                  // too: the observation must happen BEFORE the model answers.
                  const messageIntent =
                    looksLikeDataRequest(message) || looksLikeScreenRequest(message);
                  const dataIntent =
                    messageIntent ||
                    looksLikeDataRequest(recentHistory) ||
                    looksLikeScreenRequest(recentHistory);
                  try {
                    let plan: PlannedTool[] = deterministicPlan(message);
                    const usedRules = plan.length > 0;
                    if (!usedRules && dataIntent) {
                      plan = await planTools({
                        provider,
                        model: routeResult.model,
                        message,
                        recentHistory,
                        runs: preRuns,
                        signal,
                      });
                    }
                    for (let round = 0; round < 3 && plan.length > 0 && !signal.aborted; round++) {
                      for (const tc of plan) {
                        if (signal.aborted) break;
                        preRuns.push({ ...tc, result: await execDataTool(tc) });
                      }
                      if (round === 2) break;
                      // Trust the rules only once every service the message
                      // named has actually run — otherwise keep planning so
                      // tail services (calendar in a "mail and calendar" ask)
                      // are not silently dropped.
                      if (usedRules && !hasUnplannedServices(message, preRuns)) {
                        break;
                      }
                      plan = await planTools({
                        provider,
                        model: routeResult.model,
                        message,
                        recentHistory,
                        runs: preRuns,
                        signal,
                      });
                    }
                  } catch (planErr) {
                    console.error("[DataTools] pre-pass failed:", planErr);
                  }

                  // Hand the real results (or an explicit "nothing fetched"
                  // note) to the answering model via the user's message.
                  const toolContext =
                    preRuns.length > 0
                      ? buildToolContext(preRuns)
                      : messageIntent
                        ? NO_DATA_NOTE
                        : "";
                  if (toolContext) {
                    const last = messages[messages.length - 1];
                    if (last && last.role === "user" && typeof last.content === "string") {
                      last.content = last.content + toolContext;
                    }
                  }
                }

                if (provider.chatStream) {
                  const streamGen = provider.chatStream({
                    messages,
                    model: routeResult.model,
                    signal,
                  });

                  try {
                    let firstChunk = true;
                    let sentLen = 0;
                    for await (const chunk of streamGen) {
                      if (signal.aborted) break;
                      if (firstChunk) {
                        firstChunk = false;
                        perf("first_token");
                      }
                      fullText += chunk;
                      // Forward only the user-visible portion — metadata and
                      // any partial marker are held back so they can never be
                      // displayed or spoken by TTS.
                      const visible = visibleReply(fullText);
                      if (visible.length > sentLen) {
                        write(sseEvent("token", { text: visible.slice(sentLen) }));
                        sentLen = visible.length;
                      }
                    }
                    // Flush the clean tail that was held back for
                    // partial-marker safety (no-op if metadata was found).
                    if (!signal.aborted) {
                      const visibleEnd = visibleReply(fullText);
                      if (visibleEnd.length > sentLen) {
                        write(
                          sseEvent("token", {
                            text: visibleEnd.slice(sentLen),
                          }),
                        );
                      }
                    }
                  } catch (streamErr) {
                    if (signal.aborted) {
                      console.log(
                        `[Stream] Task ${task.id.slice(0, 8)} cancelled during generation`,
                      );
                      updateTaskStatus(task.id, "CANCELLED");
                      await savePartial();
                      write(
                        sseEvent("done", {
                          taskId: task.id,
                          route: routeResult.route,
                          text: cleanReply(fullText),
                          status: "CANCELLED",
                        }),
                      );
                      controller.close();
                      return;
                    }
                    throw streamErr;
                  }
                } else {
                  const result = await provider.chat({
                    messages,
                    model: routeResult.model,
                    signal,
                  });
                  fullText = result.content;
                  write(sseEvent("token", { text: fullText }));
                }
                perf("ollama_complete");

                if (signal.aborted) {
                  updateTaskStatus(task.id, "CANCELLED");
                  await savePartial();
                  write(
                    sseEvent("done", {
                      taskId: task.id,
                      route: routeResult.route,
                      text: fullText,
                      status: "CANCELLED",
                    }),
                  );
                  controller.close();
                  return;
                }

                // Parse metadata from accumulated text
                let metadata: Record<string, unknown> | undefined;
                if ("parseMetadata" in provider) {
                  const parsed = (
                    provider as {
                      parseMetadata: (raw: string) => {
                        text: string;
                        metadata?: unknown;
                      };
                    }
                  ).parseMetadata(fullText);
                  if (parsed.metadata) metadata = parsed.metadata as Record<string, unknown>;
                }

                updateTaskStatus(task.id, "COMPLETED");

                // ── Execute tool calls from metadata ──
                const rawToolCalls = (
                  metadata as {
                    tools?: Array<{
                      tool: string;
                      args: Record<string, unknown>;
                    }>;
                  }
                )?.tools;
                // Data tools already ran in the pre-pass — don't run them twice.
                const toolCalls =
                  rawToolCalls && preRuns.length > 0
                    ? rawToolCalls.filter((tc) => !DATA_TOOLS.has(tc.tool))
                    : rawToolCalls;
                const toolResults: Array<{
                  tool: string;
                  result: unknown;
                }> = [];

                if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
                  for (const tc of toolCalls) {
                    if (signal.aborted) break;

                    // ask_user is answered in the UI, not by the tool agent:
                    // pause this turn until the card comes back.
                    if (tc.tool === "ask_user") {
                      const prompt =
                        typeof tc.args?.["prompt"] === "string" ? tc.args["prompt"] : "";
                      const options = Array.isArray(tc.args?.["options"])
                        ? (tc.args["options"] as unknown[]).filter(
                            (o): o is string => typeof o === "string" && o.trim().length > 0,
                          )
                        : [];
                      if (prompt.trim().length === 0 || options.length === 0) {
                        toolResults.push({
                          tool: "ask_user",
                          result: {
                            error: "invalid_arguments",
                            message: "prompt and non-empty options are required",
                          },
                        });
                        continue;
                      }

                      const pickId = mintPickId();
                      // Aborting mid-card must release the turn immediately
                      // instead of parking it for the 3-minute timeout.
                      const onAbort = () => cancelPick(pickId);
                      signal.addEventListener("abort", onAbort, { once: true });
                      write(sseEvent("pick_request", { pickId, prompt, options }));
                      const outcome = await registerPick({ prompt, options, pickId });
                      signal.removeEventListener("abort", onAbort);
                      if (signal.aborted) break;
                      toolResults.push({ tool: "ask_user", result: outcome });
                      write(sseEvent("tool_result", { tool: "ask_user", result: outcome }));
                      continue;
                    }

                    const auth = await authorizeToolCall({
                      tool: tc.tool,
                      args: tc.args,
                      source: "tool",
                      taskId,
                      signal,
                      emitConfirmRequest: (payload) => write(sseEvent("confirm_request", payload)),
                    });

                    if (!auth.ok) {
                      console.warn(`[Tool] ${auth.reason.toUpperCase()}: ${tc.tool}`);
                      const isBlocked = auth.reason === "never";
                      const resultPayload = isBlocked
                        ? { error: auth.message, blocked: true }
                        : { error: auth.message, denied: true };
                      toolResults.push({ tool: tc.tool, result: resultPayload });
                      write(
                        sseEvent("tool_result", {
                          tool: tc.tool,
                          result: resultPayload,
                        }),
                      );
                      logActivity({
                        toolName: tc.tool,
                        input: tc.args,
                        result: resultPayload,
                        approvalStatus: isBlocked ? "blocked" : auth.reason,
                      }).catch(() => {});
                      continue;
                    }

                    if (auth.tier === "confirm") {
                      logActivity({
                        toolName: tc.tool,
                        input: tc.args,
                        result: null,
                        approvalStatus: "approved",
                      }).catch(() => {});
                    }

                    try {
                      console.log(
                        `[Tool] Executing: ${tc.tool}`,
                        JSON.stringify(tc.args).slice(0, 200),
                      );
                      write(sseEvent("tool_start", { tool: tc.tool }));

                      const result = await routeToolCall(
                        tc.tool,
                        // Bind the current session so the proactive message
                        // lands in this conversation's history
                        tc.tool === "schedule_reminder" && !tc.args["sessionId"]
                          ? { ...tc.args, sessionId }
                          : tc.args,
                        signal,
                        auth.approval,
                      );
                      toolResults.push({ tool: tc.tool, result });

                      console.log(`[Tool] ${tc.tool} → success`);
                      write(sseEvent("tool_result", { tool: tc.tool, result }));
                      logActivity({
                        toolName: tc.tool,
                        input: tc.args,
                        result: result as Record<string, unknown>,
                        approvalStatus: auth.tier,
                      }).catch(() => {});
                    } catch (toolErr) {
                      const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                      console.error(`[Tool] ${tc.tool} FAILED:`, errMsg);
                      toolResults.push({
                        tool: tc.tool,
                        result: { error: errMsg },
                      });
                      write(
                        sseEvent("tool_result", {
                          tool: tc.tool,
                          result: { error: errMsg },
                        }),
                      );
                      logActivity({
                        toolName: tc.tool,
                        input: tc.args,
                        result: { error: errMsg },
                        approvalStatus: "failed",
                      }).catch(() => {});
                    }
                  }
                }

                // Post-stream DB writes
                const writes: Promise<unknown>[] = [];

                writes.push(
                  toPromise(
                    supabaseAdmin.from("messages").insert({
                      session_id: sessionId,
                      role: "assistant",
                      // Stored clean: history feeds back into the next turn's
                      // prompt and the UI transcript, never machine metadata.
                      content: cleanReply(fullText),
                    }),
                  ).then((r) => {
                    if (r.error) {
                      console.error("[DB] messages (assistant) FAILED:", r.error.message);
                      invalidateHistory(sessionId);
                    } else {
                      appendHistory(sessionId, {
                        role: "assistant",
                        content: cleanReply(fullText),
                      });
                      console.log("[DB] messages (assistant) OK");
                    }
                  }),
                );

                writes.push(
                  logActivity({
                    toolName: "chat.respond",
                    input: {
                      message,
                      model: routeResult.model,
                      route: routeResult.route,
                      hasImage: !!image,
                    },
                    result: {
                      responseLength: fullText.length,
                      hasMetadata: !!metadata,
                      toolCount: toolResults.length,
                    },
                  })
                    .then(() => console.log("[DB] activity_log OK"))
                    .catch((e: unknown) => console.error("[DB] activity_log FAILED:", e)),
                );

                const meta = metadata as
                  | {
                      correction?: { behavior?: string };
                      memory?: Array<{
                        fact?: string;
                        category?: string;
                      }>;
                    }
                  | undefined;
                if (meta?.correction?.behavior) {
                  writes.push(
                    toPromise(
                      supabaseAdmin.from("learned_behaviors").insert({
                        behavior: meta.correction.behavior,
                        source: "user_correction",
                      }),
                    ).then((r) => {
                      if (r.error) console.error("[DB] learned_behaviors FAILED:", r.error.message);
                      else {
                        invalidateBehaviors();
                        console.log("[DB] learned_behaviors OK");
                      }
                    }),
                  );
                }

                if (meta?.memory && Array.isArray(meta.memory) && meta.memory.length > 0) {
                  for (const mem of meta.memory) {
                    if (!mem.fact) continue;
                    const memKeywords = extractKeywords(mem.fact);
                    writes.push(
                      toPromise(
                        supabaseAdmin.from("memory").insert({
                          content: mem.fact,
                          category: mem.category ?? "general",
                          relevance_keywords: memKeywords,
                          last_accessed: new Date().toISOString(),
                        }),
                      ).then((r) => {
                        if (r.error) console.error("[DB] memory FAILED:", r.error.message);
                        else {
                          invalidateMemories();
                          console.log("[DB] memory OK:", mem.fact?.substring(0, 50));
                        }
                      }),
                    );
                  }
                }

                await Promise.allSettled(writes);

                perf("response_complete");

                // Send done event (clean — metadata never leaves the server)
                write(
                  sseEvent("done", {
                    taskId: task.id,
                    route: routeResult.route,
                    text: cleanReply(fullText),
                    toolResults,
                  }),
                );

                // Update memory access timestamps
                if (relevantMemories.length > 0) {
                  toPromise(
                    supabaseAdmin
                      .from("memory")
                      .update({ last_accessed: new Date().toISOString() })
                      .in(
                        "id",
                        relevantMemories.map((m) => m.id),
                      ),
                  )
                    .then(() => {})
                    .catch(() => {});
                }
              } catch (err) {
                const errorMsg = err instanceof Error ? err.message : "Unknown error";
                console.error("[Stream] Error:", errorMsg);
                write(sseEvent("error", { error: errorMsg }));
              } finally {
                clearTaskApprovals(taskId);
                controller.close();
              }
            })();
          },
          cancel() {
            // Client disconnected (user interrupted, navigated away, or
            // aborted the fetch) — abort the in-flight LLM request so
            // token generation stops immediately.
            console.log("[Stream] Client cancelled — aborting active task");
            clearTaskApprovals(taskId);
            activeTask?.abortController.abort();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
