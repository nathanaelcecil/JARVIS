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
import { supabaseAdmin } from "../../lib/supabase-server";
import {
  isKillSwitchActive,
  logActivity,
  checkPermission,
} from "../../lib/guardrails";
import { routeRequest } from "../../lib/ai/router";
import {
  registerTask,
  updateTaskStatus,
  cleanupOldTasks,
} from "../../lib/ai/task-registry";
import { routeToolCall } from "../../lib/mcp/registry";
import { registerConfirmation } from "./confirm";
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
    "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
    "they", "them", "is", "am", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "shall", "can", "need", "dare",
    "a", "an", "the", "and", "or", "but", "if", "then", "so", "for",
    "of", "in", "to", "at", "by", "on", "with", "from", "that", "this",
    "these", "those", "not", "no", "nor", "as", "what", "which", "who",
    "how", "when", "where", "why", "all", "each", "every", "both",
    "few", "more", "most", "other", "some", "such", "than", "too",
    "very", "just", "about", "above", "after", "again", "also", "any",
    "before", "between", "come", "don't", "get", "got", "here", "into",
    "know", "let", "like", "make", "much", "new", "now", "only",
    "out", "over", "really", "right", "said", "same", "see", "tell",
    "think", "thing", "time", "two", "up", "us", "want", "way",
    "well", "give", "going", "back", "still", "even", "though",
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
  const openMatch = msg.match(
    /^(?:open|launch|start|run)\s+(.+?)(?:\s+for\s+me)?$/i
  );
  if (openMatch) {
    const appName = openMatch[1]?.trim();
    if (appName && appName.length < 50) {
      return { tool: "open_app", args: { name: appName } };
    }
  }

  // Quit app: "quit Chrome", "close Spotify"
  const quitMatch = msg.match(
    /^(?:quit|close|exit|kill)\s+(.+?)(?:\s+app)?$/i
  );
  if (quitMatch) {
    const appName = quitMatch[1]?.trim();
    if (appName && appName.length < 50) {
      return { tool: "quit_app", args: { name: appName } };
    }
  }

  // Set volume: "set volume to 30", "volume 50"
  const volSetMatch = msg.match(
    /^(?:set\s+)?volume\s+(?:to\s+)?(\d+)(?:%|\s*percent)?$/i
  );
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
    /^what(?:s|ever)?\s+(?:apps?|applications?)\s+(?:are|is)\s+running/i.test(
      msg
    ) ||
    /^list\s+(?:running\s+)?(?:apps?|applications?)/i.test(msg)
  ) {
    return { tool: "list_running_apps", args: {} };
  }

  // List directory / open in Finder
  const listMatch = msg.match(
    /^(?:list|show|open)\s+(?:the\s+)?(?:files?\s+in\s+)?(?:my\s+)?(downloads?|documents?|desktop|applications?|music|pictures?)$/i
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

/** Map tool name to its permission category in guardrails.ts */
function toolPermissionCategory(toolName: string): string {
  const map: Record<string, string> = {
    list_directory: "filesystem.list_directory",
    search_files: "filesystem.search_files",
    open_in_finder: "filesystem.open_in_finder",
    get_file_metadata: "filesystem.get_metadata",
    open_app: "desktop.open_app",
    quit_app: "desktop.quit_app",
    list_running_apps: "desktop.list_running_apps",
    get_volume: "system.get_volume",
    set_volume: "system.set_volume",
    get_brightness: "system.get_brightness",
    get_battery: "system.get_battery",
    get_ram: "system.get_ram",
    get_storage: "system.get_storage",
    run_command: "terminal.run_command",
    classify_command: "terminal.classify_command",
    run_background: "terminal.run_background",
    get_job: "terminal.get_job",
    list_jobs: "terminal.list_jobs",
    gh_list_repos: "github.list_repos",
    gh_get_file: "github.get_file",
    gh_list_issues: "github.list_issues",
    gh_list_prs: "github.list_prs",
    gh_list_runs: "github.list_runs",
    gh_run_logs: "github.run_logs",
    gh_get_diff: "github.get_diff",
    gh_create_branch: "github.create_branch",
    gh_create_file: "github.create_file",
    gh_create_issue: "github.create_issue",
    gh_create_pr: "github.create_pr",
    gh_create_comment: "github.create_comment",
    browser_navigate: "browser.navigate",
    browser_extract: "browser.extract",
    browser_screenshot: "browser.screenshot",
    browser_click: "browser.click",
    browser_type: "browser.type",
    browser_fill_form: "browser.fill_form",
    browser_download: "browser.download",
    // Gmail (read-only)
    gmail_search: "gmail.gmail_search",
    gmail_read: "gmail.gmail_read",
    gmail_list_recent: "gmail.gmail_list_recent",
    // Calendar (read-only)
    calendar_list_events: "calendar.calendar_list_events",
    calendar_search_events: "calendar.calendar_search_events",
    // Notion
    notion_search: "notion.notion_search",
    notion_read_page: "notion.notion_read_page",
    notion_query_database: "notion.notion_query_database",
    notion_create_page: "notion.notion_create_page",
    notion_update_page: "notion.notion_update_page",
    notion_archive_page: "notion.notion_archive_page",
    // Proactive JARVIS
    schedule_reminder: "proactive.schedule_reminder",
    cancel_reminder: "proactive.cancel_reminder",
    set_checkin_time: "proactive.set_checkin_time",
    list_reminders: "proactive.list_reminders",
    // Local agent notification
    notify: "notify.banner",
  };
  return map[toolName] ?? toolName;
}

/** Wrap a Supabase PromiseLike into a real Promise for Promise.all */
function toPromise<T>(
  thenable: { then: (fn: (r: T) => T) => unknown }
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (thenable as any).then(
      (r: T) => resolve(r),
      (e: unknown) => reject(e)
    );
  });
}

export const Route = createFileRoute("/api/stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const t0 = Date.now();
        const body = await request.json();
        const { message, sessionId, image, images, clientMsgId, truncateAfter } =
          body as {
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
          const { ensureProactiveScheduler } = await import(
            "../../lib/proactive/scheduler"
          );
          ensureProactiveScheduler();
        } catch (schedErr) {
          console.error("[Proactive] scheduler start failed:", schedErr);
        }

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
                    })
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
                        .gte("created_at", truncateAfter)
                    );
                    if (del.error)
                      console.error("[Edit] truncate FAILED:", del.error.message);
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
                    JSON.stringify(fastPath.args)
                  );
                  const task = registerTask({
                    message,
                    route: "FAST",
                    model: "direct",
                  });
                  activeTask = task;
                  updateTaskStatus(task.id, "RUNNING");
                  const signal = task.abortController.signal;

                  // Check permission
                  const permCategory = toolPermissionCategory(fastPath.tool);
                  const { allowed, permission } = checkPermission(permCategory);

                  if (!allowed) {
                    const blockMsg = `Tool blocked by security policy: ${fastPath.tool} (tier: ${permission})`;
                    write(
                      sseEvent("done", {
                        taskId: task.id,
                        route: "FAST",
                        text: blockMsg,
                        error: true,
                      })
                    );
                    updateTaskStatus(task.id, "FAILED");
                    controller.close();
                    return;
                  }

                  // Confirm tier for fast path
                  if (permission === "confirm") {
                    console.log(
                      `[FastPath] CONFIRM tier: ${fastPath.tool} — requesting approval`
                    );
                    const confirmId = crypto.randomUUID().slice(0, 8);
                    write(
                      sseEvent("confirm_request", {
                        tool: fastPath.tool,
                        args: fastPath.args,
                        confirmId,
                      })
                    );
                    const approved = await registerConfirmation({
                      tool: fastPath.tool,
                      args: fastPath.args,
                      confirmId,
                    });
                    if (!approved) {
                      write(
                        sseEvent("done", {
                          taskId: task.id,
                          route: "FAST",
                          text: "Action denied.",
                          error: true,
                        })
                      );
                      updateTaskStatus(task.id, "FAILED");
                      controller.close();
                      return;
                    }
                  }

                  try {
                    write(
                      sseEvent("ack", {
                        text: "One moment, sir.",
                        route: "FAST",
                      })
                    );
                    write(sseEvent("tool_start", { tool: fastPath.tool }));
                    const result = await routeToolCall(
                      fastPath.tool,
                      fastPath.args,
                      signal
                    );
                    write(
                      sseEvent("tool_result", { tool: fastPath.tool, result })
                    );
                    updateTaskStatus(task.id, "COMPLETED");
                    const resultStr = JSON.stringify(result);
                    write(
                      sseEvent("done", {
                        taskId: task.id,
                        route: "FAST",
                        text: resultStr,
                      })
                    );
                  } catch (toolErr) {
                    const errMsg =
                      toolErr instanceof Error
                        ? toolErr.message
                        : String(toolErr);
                    updateTaskStatus(task.id, "FAILED");
                    write(
                      sseEvent("done", {
                        taskId: task.id,
                        route: "FAST",
                        text: errMsg,
                        error: true,
                      })
                    );
                  }
                  controller.close();
                  return;
                }

                // Accept images[] (multi-image / video frames) plus the
                // legacy single image param; only real data URLs go forward.
                const imageList: string[] = [];
                for (const candidate of [
                  ...(images ?? []),
                  ...(image ? [image] : []),
                ]) {
                  if (
                    typeof candidate === "string" &&
                    candidate.startsWith("data:")
                  ) {
                    imageList.push(candidate);
                  }
                }

                // Route the request
                const routeResult = routeRequest(message, imageList.length > 0);
                console.log(
                  `[Router] ${routeResult.route} → ${routeResult.model} (${routeResult.reason})`
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
                    })
                  );
                }

                // Parallel DB reads — RAM-cached (60s memories/behaviors,
                // 30min per-session history; write-through on every write
                // below). Cache hits skip ~0.9-1.6s of Supabase latency.
                const cachedMemories = getCachedMemories();
                const cachedBehaviors = getCachedBehaviors();
                const cachedHistory = getCachedHistory(sessionId);
                const cacheHits =
                  (cachedMemories ? 1 : 0) +
                  (cachedBehaviors ? 1 : 0) +
                  (cachedHistory ? 1 : 0);
                perf("db_start");

                const [memoriesData, behaviorsData, historyChrono] =
                  await Promise.all([
                    cachedMemories
                      ? Promise.resolve(cachedMemories)
                      : toPromise(
                          supabaseAdmin
                            .from("memory")
                            .select("*")
                            .order("last_accessed", { ascending: false })
                            .limit(50)
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
                            .order("created_at", { ascending: true })
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
                            .limit(20)
                        ).then((r) => {
                          const chrono = (
                            [...(r.data ?? [])] as CachedMessage[]
                          ).reverse();
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
                const systemPrompt = buildSystemPrompt({
                  memories: relevantMemories,
                  learnedBehaviors,
                  timeOfDay: getTimeOfDay(),
                });

                const messages: ChatMessage[] = [
                  { role: "system", content: systemPrompt },
                ];
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
                  supabaseAdmin.from("messages").insert({
                    session_id: sessionId,
                    role: "user",
                    content: message,
                    image_url: image ?? null,
                  }).select()
                )
                  .then((r) => {
                    if (r.error) {
                      console.error(
                        "[DB] messages (user) FAILED:",
                        r.error.message
                      );
                      invalidateHistory(sessionId);
                    } else {
                      console.log("[DB] messages (user) OK");
                      // Tell the client the exact DB timestamp of this user
                      // message — the truncation point for later edits.
                      const savedAt = (
                        r.data as { created_at?: string }[] | null
                      )?.[0]?.created_at;
                      if (savedAt && clientMsgId) {
                        write(
                          sseEvent("user_saved", {
                            clientMsgId,
                            createdAt: savedAt,
                          })
                        );
                      }
                    }
                  })
                  .catch((e: unknown) =>
                    console.error("[DB] messages (user) FAILED:", e)
                  );

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
                  const partialText = (
                    metaIdx >= 0 ? fullText.slice(0, metaIdx) : fullText
                  ).trim();
                  if (!partialText) return;
                  const content =
                    partialText +
                    '\n\n⏹ *(cut off — say "continue" or send your next prompt)*';
                  try {
                    await toPromise(
                      supabaseAdmin.from("messages").insert({
                        session_id: sessionId,
                        role: "assistant",
                        content,
                      })
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
                        write(
                          sseEvent("token", { text: visible.slice(sentLen) })
                        );
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
                          })
                        );
                      }
                    }
                  } catch (streamErr) {
                    if (signal.aborted) {
                      console.log(
                        `[Stream] Task ${task.id.slice(0, 8)} cancelled during generation`
                      );
                      updateTaskStatus(task.id, "CANCELLED");
                      await savePartial();
                      write(
                        sseEvent("done", {
                          taskId: task.id,
                          route: routeResult.route,
                          text: cleanReply(fullText),
                          status: "CANCELLED",
                        })
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
                    })
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
                  if (parsed.metadata)
                    metadata = parsed.metadata as Record<string, unknown>;
                }

                updateTaskStatus(task.id, "COMPLETED");

                // ── Execute tool calls from metadata ──
                const toolCalls = (
                  metadata as {
                    tools?: Array<{
                      tool: string;
                      args: Record<string, unknown>;
                    }>;
                  }
                )?.tools;
                const toolResults: Array<{
                  tool: string;
                  result: unknown;
                }> = [];

                if (
                  toolCalls &&
                  Array.isArray(toolCalls) &&
                  toolCalls.length > 0
                ) {
                  for (const tc of toolCalls) {
                    if (signal.aborted) break;

                    const permCategory = toolPermissionCategory(tc.tool);
                    const { allowed, permission } =
                      checkPermission(permCategory);

                    if (!allowed) {
                      const blockMsg = `Tool blocked by security policy: ${tc.tool} (tier: ${permission})`;
                      console.warn(
                        `[Tool] BLOCKED: ${tc.tool} — ${permission} tier`
                      );
                      toolResults.push({
                        tool: tc.tool,
                        result: { error: blockMsg, blocked: true },
                      });
                      write(
                        sseEvent("tool_result", {
                          tool: tc.tool,
                          result: { error: blockMsg, blocked: true },
                        })
                      );
                      logActivity({
                        toolName: tc.tool,
                        input: tc.args,
                        result: { error: blockMsg },
                        approvalStatus: "blocked",
                      }).catch(() => {});
                      continue;
                    }

                    if (permission === "confirm") {
                      console.log(
                        `[Tool] CONFIRM tier: ${tc.tool} — requesting approval`
                      );
                      const confirmId = crypto.randomUUID().slice(0, 8);
                      write(
                        sseEvent("confirm_request", {
                          tool: tc.tool,
                          args: tc.args,
                          confirmId,
                        })
                      );

                      const approved = await registerConfirmation({
                        tool: tc.tool,
                        args: tc.args,
                        confirmId,
                      });
                      if (!approved) {
                        const denyMsg = `Action denied by user: ${tc.tool}`;
                        console.log(`[Tool] DENIED: ${tc.tool}`);
                        toolResults.push({
                          tool: tc.tool,
                          result: { error: denyMsg, denied: true },
                        });
                        write(
                          sseEvent("tool_result", {
                            tool: tc.tool,
                            result: { error: denyMsg, denied: true },
                          })
                        );
                        logActivity({
                          toolName: tc.tool,
                          input: tc.args,
                          result: { error: denyMsg },
                          approvalStatus: "denied",
                        }).catch(() => {});
                        continue;
                      }
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
                        JSON.stringify(tc.args).slice(0, 200)
                      );
                      write(sseEvent("tool_start", { tool: tc.tool }));

                      const result = await routeToolCall(
                        tc.tool,
                        // Bind the current session so the proactive message
                        // lands in this conversation's history
                        tc.tool === "schedule_reminder" &&
                          !tc.args["sessionId"]
                          ? { ...tc.args, sessionId }
                          : tc.args,
                        signal
                      );
                      toolResults.push({ tool: tc.tool, result });

                      console.log(`[Tool] ${tc.tool} → success`);
                      write(
                        sseEvent("tool_result", { tool: tc.tool, result })
                      );
                      logActivity({
                        toolName: tc.tool,
                        input: tc.args,
                        result: result as Record<string, unknown>,
                        approvalStatus: permission,
                      }).catch(() => {});
                    } catch (toolErr) {
                      const errMsg =
                        toolErr instanceof Error
                          ? toolErr.message
                          : String(toolErr);
                      console.error(`[Tool] ${tc.tool} FAILED:`, errMsg);
                      toolResults.push({
                        tool: tc.tool,
                        result: { error: errMsg },
                      });
                      write(
                        sseEvent("tool_result", {
                          tool: tc.tool,
                          result: { error: errMsg },
                        })
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
                    })
                  ).then((r) => {
                    if (r.error) {
                      console.error(
                        "[DB] messages (assistant) FAILED:",
                        r.error.message
                      );
                      invalidateHistory(sessionId);
                    } else {
                      appendHistory(sessionId, {
                        role: "assistant",
                        content: cleanReply(fullText),
                      });
                      console.log("[DB] messages (assistant) OK");
                    }
                  })
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
                    .catch((e: unknown) =>
                      console.error("[DB] activity_log FAILED:", e)
                    )
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
                      })
                    ).then((r) => {
                      if (r.error)
                        console.error(
                          "[DB] learned_behaviors FAILED:",
                          r.error.message
                        );
                      else {
                        invalidateBehaviors();
                        console.log("[DB] learned_behaviors OK");
                      }
                    })
                  );
                }

                if (
                  meta?.memory &&
                  Array.isArray(meta.memory) &&
                  meta.memory.length > 0
                ) {
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
                        })
                      ).then((r) => {
                        if (r.error)
                          console.error(
                            "[DB] memory FAILED:",
                            r.error.message
                          );
                        else {
                          invalidateMemories();
                          console.log(
                            "[DB] memory OK:",
                            mem.fact?.substring(0, 50)
                          );
                        }
                      })
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
                  })
                );

                // Update memory access timestamps
                if (relevantMemories.length > 0) {
                  toPromise(
                    supabaseAdmin
                      .from("memory")
                      .update({ last_accessed: new Date().toISOString() })
                      .in(
                        "id",
                        relevantMemories.map((m) => m.id)
                      )
                  )
                    .then(() => {})
                    .catch(() => {});
                }
              } catch (err) {
                const errorMsg =
                  err instanceof Error ? err.message : "Unknown error";
                console.error("[Stream] Error:", errorMsg);
                write(sseEvent("error", { error: errorMsg }));
              } finally {
                controller.close();
              }
            })();
          },
          cancel() {
            // Client disconnected (user interrupted, navigated away, or
            // aborted the fetch) — abort the in-flight LLM request so
            // token generation stops immediately.
            console.log("[Stream] Client cancelled — aborting active task");
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
