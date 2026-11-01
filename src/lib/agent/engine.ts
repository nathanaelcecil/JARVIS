/**
 * Bounded coding-agent execution engine.
 *
 * State machine: IDLE → UNDERSTANDING → INVESTIGATING → PLANNING →
 * IMPLEMENTING → TESTING → CORRECTING → COMPLETED, plus FAILED, CANCELLED
 * and NEEDS_APPROVAL.
 *
 * Guarantees:
 *  - Hard iteration cap and wall-clock deadline — never an uncontrolled loop.
 *  - One active task per workspace: duplicate starts are rejected.
 *  - Baseline checks are captured BEFORE the first edit so verification can
 *    separate pre-existing failures from regressions the task introduced.
 *  - No completion claim without evidence: if the task changed files, the
 *    engine itself runs the checks and refuses COMPLETED while new failures
 *    remain (feeding the real output back for CORRECTING rounds).
 *  - Cancellation (AbortSignal) finalizes as CANCELLED at the next step.
 *  - Every state/tool/decision is persisted through the task store, so work
 *    resumes after a restart instead of being repeated.
 */

import path from "node:path";
import { createWorkspace, type WorkspacePolicy } from "./workspace";
import {
  getProjectOverview,
  listProjectScripts,
  readSourceFile,
  listRepoTree,
  searchRepoContent,
  findSymbols,
  gitStatus,
  gitDiff,
  gitLog,
  writeRepoFile,
  editRepoFile,
  runProjectScript,
} from "./repo-tools";
import { buildAgentPrompt } from "./prompt";
import { recallMemory, saveMemory, type MemoryKind } from "./memory";
import {
  appendEvent,
  appendStep,
  findActiveTask,
  loadTask,
  recoverTasks,
  saveTask,
} from "./task-store";
import type {
  AgentPhase,
  AgentTaskRecord,
  CheckReport,
  CheckResult,
  TranscriptMessage,
} from "./engine-types";
import { logActivity } from "../guardrails";
import { authorizeToolCall, decideToolTier } from "../tool-authorization";
import { createProvider, type AIProvider } from "../ai/provider";
import { getModelForRoute } from "../ai/router";
import { routeToolCall } from "../mcp/registry";

// ── Configuration ───────────────────────────────────────────

const MAX_ITERATIONS = clampInt(process.env["JARVIS_AGENT_MAX_ITERATIONS"], 3, 40, 10);
const DEADLINE_MS = clampInt(
  process.env["JARVIS_AGENT_TIMEOUT_MS"],
  30_000,
  60 * 60_000,
  12 * 60_000,
);
const MAX_CORRECTION_ROUNDS = 3;
const APPROVAL_TIMEOUT_MS = 180_000;
const MAX_TOOLS_PER_BLOCK = 6;
const MAX_TRANSCRIPT_MESSAGES = 60;
const MAX_TOOL_RESULT_CHARS = 6000;
/** Scripts the engine treats as verification, when declared. */
const VERIFY_SCRIPTS = ["test", "typecheck", "check", "lint"];

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ── Phase machinery ─────────────────────────────────────────

const FLOW_PHASES: string[] = [
  "UNDERSTANDING",
  "INVESTIGATING",
  "PLANNING",
  "IMPLEMENTING",
  "TESTING",
  "CORRECTING",
];

/** Model tools → the phase they belong to (when the model omits "state"). */
function phaseForTool(tool: string): AgentPhase {
  if (tool === "write_file" || tool === "edit_file") return "IMPLEMENTING";
  if (tool === "run_script" || tool === "run_command") return "TESTING";
  if (tool === "remember") return "PLANNING";
  return "INVESTIGATING";
}

function modelForPhase(phase: AgentPhase): string {
  switch (phase) {
    case "IMPLEMENTING":
    case "CORRECTING":
    case "TESTING":
      return getModelForRoute("CODING");
    case "UNDERSTANDING":
    case "INVESTIGATING":
    case "PLANNING":
      return getModelForRoute("SMART");
    default:
      return getModelForRoute("AGENT");
  }
}

// ── Metadata parsing (tools / state / memory from a turn) ───

export interface AgentTurnMeta {
  text: string;
  tools: Array<{ tool: string; args: Record<string, unknown> }>;
  state?: string;
  memories: Array<{ kind: string; content: string }>;
  /** A ---METADATA--- delimiter was present but its JSON body was invalid. */
  metaFailed?: boolean;
}

const VALID_MEMORY_KINDS: string[] = [
  "architecture",
  "decision",
  "convention",
  "bug",
  "fix",
  "failed_approach",
  "task_status",
  "note",
];

function buildMeta(obj: Record<string, unknown>, text: string): AgentTurnMeta {
  const tools: AgentTurnMeta["tools"] = [];
  if (Array.isArray(obj["tools"])) {
    // Weak models sometimes emit a parallel args array instead of per-tool
    // objects: {"tools":["read_file"],"args":[{"path":"a.ts"}]}.
    const pairedArgs = Array.isArray(obj["args"]) ? obj["args"] : [];
    const list = obj["tools"].slice(0, MAX_TOOLS_PER_BLOCK);
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (typeof t === "string" && t.length > 0) {
        const a = pairedArgs[i];
        tools.push({
          tool: t,
          args:
            a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : {},
        });
        continue;
      }
      if (!t || typeof t !== "object") continue;
      const tt = t as { tool?: unknown; args?: unknown };
      if (typeof tt.tool !== "string" || tt.tool.length === 0) continue;
      const args =
        tt.args && typeof tt.args === "object" && !Array.isArray(tt.args)
          ? (tt.args as Record<string, unknown>)
          : {};
      tools.push({ tool: tt.tool, args });
    }
  }

  const memories: AgentTurnMeta["memories"] = [];
  if (Array.isArray(obj["memory"])) {
    for (const m of obj["memory"].slice(0, 5)) {
      if (!m || typeof m !== "object") continue;
      const mm = m as { kind?: unknown; content?: unknown };
      if (typeof mm.content !== "string" || mm.content.length === 0) continue;
      memories.push({
        kind: typeof mm.kind === "string" ? mm.kind : "note",
        content: mm.content,
      });
    }
  }

  const state = typeof obj["state"] === "string" ? obj["state"] : undefined;
  return { text, tools, memories, ...(state ? { state } : {}) };
}

function tryMetaFromJson(candidate: string, text: string): AgentTurnMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  // A metadata object carries a tools array, a state, a memory list — or is
  // exactly {} ("nothing to do"). Unknown extra keys are tolerated because
  // weak models bolt on things like a parallel "args" array.
  const keys = Object.keys(obj);
  const looksMeta =
    keys.length === 0 || Array.isArray(obj["tools"]) || "state" in obj || "memory" in obj;
  if (!looksMeta) return null;
  return buildMeta(obj, text);
}

export function parseAgentMetadata(raw: string): AgentTurnMeta {
  // 1) Delimited block. Tolerate sloppy delimiters (models occasionally
  //    write "---" and "METADATA---" on separate lines). The LAST match wins
  //    because the real block is the one at the end of the reply.
  const re = /-{2,}\s*METADATA\s*-{2,}/gi;
  let idx = -1;
  let end = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    idx = m.index;
    end = idx + m[0].length;
  }
  if (idx !== -1) {
    const text = raw.slice(0, idx).trim();
    const tail = raw.slice(end).trim();
    const built = tryMetaFromJson(tail, text);
    if (built) return built;
    return { text, tools: [], memories: [], metaFailed: true };
  }

  // 2) No delimiter at all: some models skip it and emit the bare JSON
  //    object. Mistaking it for the final report would "complete" tasks
  //    with raw JSON as the deliverable, so accept it as a block when it
  //    carries meta keys (tools/state/memory).
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const built = tryMetaFromJson(trimmed, "");
    if (built) return built;
  }
  // Prose followed by a line-leading JSON object (no delimiter).
  const starts: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{" && (i === 0 || raw[i - 1] === "\n")) starts.push(i);
  }
  for (let s = starts.length - 1; s >= 0; s--) {
    const start = starts[s]!;
    const built = tryMetaFromJson(raw.slice(start).trim(), raw.slice(0, start).trim());
    if (built) return built;
  }

  // Plain prose — a genuine final answer.
  return { text: trimmed, tools: [], memories: [] };
}

// ── Check running & comparison ──────────────────────────────

async function declaredVerifyScripts(policy: WorkspacePolicy): Promise<string[]> {
  try {
    const { scripts } = await listProjectScripts(policy);
    return VERIFY_SCRIPTS.filter((s) => Object.prototype.hasOwnProperty.call(scripts, s));
  } catch {
    return [];
  }
}

async function runChecks(policy: WorkspacePolicy, scripts: string[]): Promise<CheckReport> {
  const results: CheckResult[] = [];
  for (const script of scripts) {
    try {
      const r = await runProjectScript(policy, { script, tailChars: 3000 });
      results.push({
        name: script,
        command: r.command,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        outputTail: `${r.stdout}\n${r.stderr}`.trim().slice(-3000),
      });
    } catch (err) {
      results.push({
        name: script,
        command: `run ${script}`,
        exitCode: -1,
        timedOut: false,
        durationMs: 0,
        outputTail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    at: Date.now(),
    results,
    allPassed: results.every((r) => r.exitCode === 0),
  };
}

/**
 * Failures present NOW that were passing (or absent) in the baseline.
 * A script that already failed before the first edit is pre-existing.
 */
export function newFailures(baseline: CheckReport | null, run: CheckReport): CheckResult[] {
  return run.results.filter((r) => {
    if (r.exitCode === 0) return false;
    const b = baseline?.results.find((x) => x.name === r.name);
    return !b || b.exitCode === 0;
  });
}

// ── Approvals ───────────────────────────────────────────────

interface ApprovalWaiter {
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
}

const approvalWaiters = new Map<
  string,
  { waiter: ApprovalWaiter; resolve: (approved: boolean) => void }
>();

/**
 * Resolve a pending agent approval (called by POST /api/agent or the
 * VS Code extension). Returns false when nothing is pending.
 */
export function resolveAgentApproval(taskId: string, approved: boolean): boolean {
  const entry = approvalWaiters.get(taskId);
  if (!entry) return false;
  settleApproval(taskId, approved);
  return true;
}

function settleApproval(taskId: string, approved: boolean): void {
  const entry = approvalWaiters.get(taskId);
  if (!entry || entry.waiter.settled) return;
  entry.waiter.settled = true;
  clearTimeout(entry.waiter.timer);
  approvalWaiters.delete(taskId);
  entry.resolve(approved);
}

function waitForApproval(record: AgentTaskRecord, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const resolveViaMap = () => {
      const e = approvalWaiters.get(record.id);
      if (e && !e.waiter.settled) {
        e.waiter.settled = true;
        clearTimeout(e.waiter.timer);
        approvalWaiters.delete(record.id);
        e.resolve(false);
      }
    };
    const entry: {
      waiter: ApprovalWaiter;
      resolve: (ok: boolean) => void;
    } = {
      waiter: {
        settled: false,
        timer: setTimeout(() => {
          if (record.approval && record.approval.state === "pending") {
            record.approval.state = "expired";
          }
          resolveViaMap();
        }, APPROVAL_TIMEOUT_MS),
      },
      resolve,
    };
    if (signal) {
      const onAbort = () => settleApproval(record.id, false);
      signal.addEventListener("abort", onAbort, { once: true });
      entry.waiter.abortListener = onAbort;
    }
    approvalWaiters.set(record.id, entry);
  });
}

// ── Running-task registry (in-memory controllers) ──────────

const controllers = new Map<string, AbortController>();
const recoveredRoots = new Set<string>();

async function ensureRecovered(repoRoot: string): Promise<void> {
  const key = path.resolve(repoRoot);
  if (recoveredRoots.has(key)) return;
  recoveredRoots.add(key);
  await recoverTasks(key);
}

export function isAgentRunning(taskId: string): boolean {
  return controllers.has(taskId);
}

// ── Dependencies (injectable for tests) ────────────────────

export interface AgentDeps {
  chat(params: {
    messages: TranscriptMessage[];
    model: string;
    signal?: AbortSignal | undefined;
  }): Promise<{ content: string }>;
  executeTool(
    tool: string,
    args: Record<string, unknown>,
    ctx: {
      policy: WorkspacePolicy;
      record: AgentTaskRecord;
      signal?: AbortSignal | undefined;
      /** HMAC token for local-agent confirm-tier tools (minted after approval). */
      approval?: string | undefined;
    },
  ): Promise<unknown>;
  now(): number;
}

let sharedProvider: AIProvider | null = null;

/** Default tool executor: repo tools in-process, others via MCP registry. */
function buildDefaultExecutor(): AgentDeps["executeTool"] {
  return async (tool, args, ctx) => {
    const { policy } = ctx;
    switch (tool) {
      case "overview":
        return getProjectOverview(policy);
      case "read_file":
        return readSourceFile(policy, args as { path: string; offset?: number; limit?: number });
      case "list_tree":
        return listRepoTree(policy, args as { path?: string; depth?: number; maxEntries?: number });
      case "search":
        return searchRepoContent(
          policy,
          args as {
            query: string;
            path?: string;
            regex?: boolean;
            caseSensitive?: boolean;
            extensions?: string[];
            maxResults?: number;
          },
        );
      case "find_symbol":
        return findSymbols(policy, args as { name: string; maxResults?: number });
      case "git_status":
        return gitStatus(policy);
      case "git_diff":
        return gitDiff(policy, args as { staged?: boolean; path?: string });
      case "git_log":
        return gitLog(policy, args as { limit?: number });
      case "write_file":
        return writeRepoFile(policy, args as { path: string; content: string });
      case "edit_file":
        return editRepoFile(
          policy,
          args as {
            path: string;
            oldString: string;
            newString: string;
            replaceAll?: boolean;
          },
        );
      case "run_script":
        return runProjectScript(policy, args as { script: string; timeoutMs?: number });
      case "remember":
        return saveMemory(policy.root, {
          kind: (VALID_MEMORY_KINDS.includes(String(args["kind"]))
            ? String(args["kind"])
            : "note") as MemoryKind,
          content: String(args["content"] ?? ""),
          source: ctx.record.id,
        });
      default:
        // Passthrough to the existing MCP registry (run_command,
        // classify_command, local-agent tools, …). The engine already decided
        // the tier; the approval token (when minted) is required by the local
        // agent for confirm-tier tools.
        return routeToolCall(tool, args, ctx.signal, ctx.approval);
    }
  };
}

function defaultDeps(): AgentDeps {
  if (!sharedProvider) sharedProvider = createProvider();
  const provider = sharedProvider;
  const executeTool = buildDefaultExecutor();
  return {
    async chat({ messages, model, signal }) {
      const res = await provider.chat({
        messages,
        model,
        // The engine parses the ---METADATA--- block itself — never strip it.
        raw: true,
        // Grown transcripts prefill slowly on a local 14b model; the
        // provider's default 120s hard timeout aborted live runs.
        timeoutMs: 240_000,
        ...(signal ? { signal } : {}),
      });
      return { content: res.content };
    },
    executeTool,
    now: () => Date.now(),
  };
}

// ── The loop ────────────────────────────────────────────────

export interface RunLoopOptions {
  record: AgentTaskRecord;
  deps: AgentDeps;
  signal?: AbortSignal | undefined;
  deadlineMs?: number;
}

function clipText(s: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`;
}

function pushMessage(record: AgentTaskRecord, msg: TranscriptMessage): void {
  record.transcript.push(msg);
  // Keep the system prompt (index 0) and a bounded tail.
  if (record.transcript.length > MAX_TRANSCRIPT_MESSAGES) {
    const head = record.transcript.slice(0, 1);
    const tail = record.transcript.slice(-MAX_TRANSCRIPT_MESSAGES + 1);
    record.transcript = [...head, ...tail];
  }
}

/** Tools that touch nothing — safe to run concurrently in one block. */
const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_tree",
  "search",
  "find_symbol",
  "git_status",
  "git_diff",
  "git_log",
  "overview",
  "classify_command",
  "coding_task_status",
]);

/**
 * Every tool the coding agent may call. Unknown names (the model inventing
 * "cat"/"git") get a corrective result listing the real names instead of
 * falling into a bogus approval flow or the MCP registry.
 */
const KNOWN_AGENT_TOOLS = new Set([
  "overview",
  "read_file",
  "list_tree",
  "search",
  "find_symbol",
  "git_status",
  "git_diff",
  "git_log",
  "write_file",
  "edit_file",
  "run_script",
  "run_command",
  "classify_command",
  "remember",
  "coding_task_status",
]);

const MAX_METADATA_NUDGES = 2;
const MAX_REPORT_NUDGES = 2;

export async function runAgentLoop(opts: RunLoopOptions): Promise<AgentTaskRecord> {
  const { record, deps, signal } = opts;
  const deadline = deps.now() + (opts.deadlineMs ?? DEADLINE_MS);
  const policy = await createWorkspace(record.repoRoot);
  let correctionRounds = 0;
  let metadataNudges = 0;
  let reportNudges = 0;
  let conclusionNudged = false;
  let toolsRunTotal = 0;

  const setPhase = async (phase: AgentPhase, note?: string): Promise<void> => {
    record.phase = phase;
    record.updatedAt = deps.now();
    await saveTask(record);
    await appendEvent(record, {
      phase,
      kind: "phase",
      text: note ?? phaseLabel(phase),
    });
  };

  const finalize = async (phase: AgentPhase, report: string, error?: string): Promise<void> => {
    record.phase = phase;
    record.finalReport = report;
    if (error) record.error = error;
    record.updatedAt = deps.now();
    controllers.delete(record.id);
    await saveTask(record);
    await appendEvent(record, {
      phase,
      kind: phase === "COMPLETED" ? "report" : "error",
      text:
        phase === "COMPLETED"
          ? "Task completed"
          : phase === "CANCELLED"
            ? "Task cancelled"
            : `Task failed${error ? `: ${error}` : ""}`,
      detail: clipText(report, 4000),
    });
  };

  // Seed transcript: system prompt first, then the task.
  const memory = await recallMemory(policy.root, record.title, 6);
  const overview = (await getProjectOverview(policy)) as Record<string, unknown>;
  const systemPrompt = buildAgentPrompt({ task: record, overview, memory });
  if (record.transcript.length === 0) {
    record.transcript.push({ role: "system", content: systemPrompt });
    pushMessage(record, {
      role: "user",
      content:
        "Begin the task now. Call overview() first unless you already know this codebase, " +
        "then investigate. End this turn with your ---METADATA--- block.",
    });
  } else {
    // Refresh system prompt (memory/baseline/steps evolve) but keep history.
    record.transcript[0] = { role: "system", content: systemPrompt };
    pushMessage(record, {
      role: "user",
      content:
        "Resuming this task. Continue from the history below; do not redo completed work. " +
        "End this turn with your ---METADATA--- block.",
    });
  }

  if (record.phase === "IDLE" || record.phase === "CANCELLED") {
    await setPhase("UNDERSTANDING", "Understanding the task");
  }

  while (true) {
    if (signal?.aborted) {
      await finalize("CANCELLED", lastReport(record));
      return record;
    }
    if (deps.now() > deadline) {
      await finalize(
        "FAILED",
        lastReport(record),
        `Deadline exceeded (${Math.round(DEADLINE_MS / 1000)}s limit)`,
      );
      return record;
    }
    if (record.iterations >= record.maxIterations) {
      await finalize(
        "FAILED",
        lastReport(record),
        `Iteration limit reached (${record.maxIterations})`,
      );
      return record;
    }

    // ── Model turn ──
    const model = modelForPhase(record.phase);
    record.model = model;
    let content: string;
    try {
      const res = await deps.chat({
        messages: record.transcript,
        model,
        signal,
      });
      content = res.content;
    } catch (err) {
      if (signal?.aborted) {
        await finalize("CANCELLED", lastReport(record));
        return record;
      }
      await finalize(
        "FAILED",
        lastReport(record),
        `Model call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return record;
    }
    if (signal?.aborted) {
      await finalize("CANCELLED", lastReport(record));
      return record;
    }

    record.iterations++;
    pushMessage(record, { role: "assistant", content });
    const meta = parseAgentMetadata(content);

    // Malformed ---METADATA--- JSON: nudge the model to resend instead of
    // treating the garbage as a final report (it previously "completed"
    // tasks with the raw metadata block as the deliverable).
    if (meta.metaFailed && metadataNudges < MAX_METADATA_NUDGES) {
      metadataNudges++;
      await appendEvent(record, {
        phase: record.phase,
        kind: "error",
        text: `Malformed ---METADATA--- block (nudge ${metadataNudges}/${MAX_METADATA_NUDGES})`,
        detail: clipText(content, 400),
      });
      pushMessage(record, {
        role: "user",
        content:
          `Your ---METADATA--- block was not valid JSON. Reply again: brief prose (if any), ` +
          `then exactly ---METADATA--- on ONE line immediately followed by a single JSON ` +
          `object — e.g. ---METADATA--- {"tools": [{"tool": "read_file", "args": {"path": "…"}}]} ` +
          `or ---METADATA--- {} for a final answer with no tool calls.`,
      });
      continue;
    }

    // Persist memories the model asked to store (secret-screened inside).
    for (const m of meta.memories) {
      try {
        await saveMemory(policy.root, {
          kind: (VALID_MEMORY_KINDS.includes(m.kind) ? m.kind : "note") as MemoryKind,
          content: m.content,
          source: record.id,
        });
      } catch (err) {
        await appendEvent(record, {
          phase: record.phase,
          kind: "note",
          text: `Memory refused: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Phase declaration — validated, ignored when bogus.
    if (meta.state && FLOW_PHASES.includes(meta.state)) {
      if (meta.state !== record.phase) {
        await setPhase(meta.state as AgentPhase, phaseLabel(meta.state as AgentPhase));
      }
    }

    // ── No tools → completion path ──
    if (meta.tools.length === 0) {
      if (record.changedFiles.length === 0) {
        // A placeholder reply ("Done.", "ok") after zero investigation is
        // not a deliverable — nudge instead of "completing" with nothing.
        const trivial = meta.text.trim().length < 30;
        if (trivial && toolsRunTotal === 0 && reportNudges < MAX_REPORT_NUDGES) {
          reportNudges++;
          await appendEvent(record, {
            phase: record.phase,
            kind: "error",
            text: `Placeholder-only reply nudged (attempt ${reportNudges}/${MAX_REPORT_NUDGES})`,
            detail: clipText(meta.text, 200),
          });
          pushMessage(record, {
            role: "user",
            content:
              `That reply is not a deliverable. If the task is worth doing, first run the ` +
              `relevant tools (overview, read_file, search, …) and then report your actual ` +
              `findings with specifics. If you genuinely cannot proceed, say exactly what ` +
              `information you are missing instead of replying "Done."`,
          });
          continue;
        }
        // Findings were stored to memory but no prose report was produced —
        // ask for the actual report before accepting an empty deliverable.
        if (trivial && meta.memories.length > 0 && reportNudges < MAX_REPORT_NUDGES) {
          reportNudges++;
          await appendEvent(record, {
            phase: record.phase,
            kind: "error",
            text: `Memory-only findings nudged into a report (attempt ${reportNudges}/${MAX_REPORT_NUDGES})`,
            detail: clipText(meta.memories.map((mm) => mm.content).join(" | "), 300),
          });
          pushMessage(record, {
            role: "user",
            content:
              `You recorded findings in memory but produced no report. End your next ` +
              `reply with the actual report in prose (files examined, findings, evidence) — ` +
              `the user must be able to read it directly.`,
          });
          continue;
        }
        // Read-only task: the reply itself is the deliverable.
        const fallbackReport =
          meta.text.trim() ||
          (meta.memories.length > 0
            ? `Findings recorded:\n${meta.memories.map((mm) => `- ${mm.content}`).join("\n")}`
            : "(No report produced.)");
        await finalize("COMPLETED", fallbackReport);
        return record;
      }

      // Evidence gate: changed files ⇒ engine-run verification.
      await setPhase("TESTING", "Verifying changes with project checks");
      const scripts = await declaredVerifyScripts(policy);
      if (scripts.length === 0) {
        await appendEvent(record, {
          phase: "TESTING",
          kind: "check",
          text: "No verification scripts declared (test/typecheck/check/lint) — reporting changes without automated checks",
        });
        await finalize(
          "COMPLETED",
          `${meta.text}\n\nFiles changed: ${record.changedFiles.join(", ")}. No project checks are declared, so correctness was not machine-verified.`,
        );
        return record;
      }
      if (!record.baseline) {
        // Shouldn't happen (captured before first write) but stay safe.
        record.baseline = await runChecks(policy, scripts);
        await saveTask(record);
      }
      const run = await runChecks(policy, scripts);
      record.verificationRuns.push(run);
      await saveTask(record);
      const fails = newFailures(record.baseline, run);

      if (fails.length > 0 && correctionRounds < MAX_CORRECTION_ROUNDS) {
        correctionRounds++;
        await setPhase("CORRECTING", `Correcting ${fails.length} new check failure(s)`);
        const detail = fails
          .map(
            (f) =>
              `### ${f.command} → exit ${f.exitCode}${f.timedOut ? " (TIMED OUT)" : ""}\n${f.outputTail}`,
          )
          .join("\n\n");
        pushMessage(record, {
          role: "user",
          content: clipText(
            `VERIFICATION FAILED — your changes introduced NEW failures ` +
              `(baseline had them passing or absent):\n\n${detail}\n\n` +
              `Diagnose the root cause from the real output above, fix it, and end your ` +
              `next turn with tools (or a final reply once verified). Do not weaken or delete tests.`,
          ),
        });
        await appendStep(record, {
          phase: "CORRECTING",
          summary: `Verification found ${fails.length} new failure(s); corrective round ${correctionRounds}/${MAX_CORRECTION_ROUNDS}`,
        });
        continue;
      }

      if (fails.length > 0) {
        const detail = fails.map((f) => `${f.command}: exit ${f.exitCode}`).join("; ");
        await finalize(
          "FAILED",
          `${meta.text}\n\nVerification: ${detail} — new failures were NOT resolved within ${MAX_CORRECTION_ROUNDS} correction round(s). Baseline failures (pre-existing, not caused by this task): ${
            (record.baseline?.results ?? [])
              .filter((b) => b.exitCode !== 0)
              .map((b) => `${b.name}=exit ${b.exitCode}`)
              .join(", ") || "none"
          }`,
          `Unresolved new check failures: ${detail}`,
        );
        return record;
      }

      const evidence = run.results
        .map((r) => `${r.command} → exit ${r.exitCode} (${r.durationMs}ms)`)
        .join("\n");
      await appendStep(record, {
        phase: "TESTING",
        summary: `Verified: ${evidence}`,
      });
      await finalize(
        "COMPLETED",
        `${meta.text}\n\nVerification evidence:\n${evidence}\nFiles changed: ${record.changedFiles.join(", ")}`,
      );
      return record;
    }

    // ── Execute the block's tools ──
    // Independent read-only investigations run concurrently (reconciled into
    // the transcript in block order); anything that writes, edits, or runs
    // commands executes strictly sequentially so effects never interleave.
    const allReadOnly = meta.tools.every((t) => READ_ONLY_TOOLS.has(t.tool));
    if (allReadOnly && meta.tools.length > 1) {
      const messages = await Promise.all(
        meta.tools.map((t) => executeOne(t.tool, t.args, { record, deps, policy, signal })),
      );
      for (const m of messages) {
        if (m) pushMessage(record, { role: "user", content: m });
      }
    } else {
      for (const t of meta.tools) {
        if (signal?.aborted) break;
        const m = await executeOne(t.tool, t.args, {
          record,
          deps,
          policy,
          signal,
        });
        if (m) pushMessage(record, { role: "user", content: m });
      }
    }
    toolsRunTotal += meta.tools.length;

    // approaching the iteration budget → tell the model to conclude.
    if (
      !conclusionNudged &&
      record.iterations >= record.maxIterations - 2 &&
      record.maxIterations >= 4
    ) {
      conclusionNudged = true;
      pushMessage(record, {
        role: "user",
        content:
          `You are approaching the iteration budget ` +
          `(${record.iterations}/${record.maxIterations}). Wrap up now: end your next ` +
          `reply with the FINAL report (files examined, findings, evidence) and NO more ` +
          `tool calls unless something is strictly missing.`,
      });
    }

    await saveTask(record);
  }

  // Only reachable via abort inside the tool loop.
  await finalize("CANCELLED", lastReport(record));
  return record;
}

// ── Single tool execution (permissions, approval, events) ───

async function executeOne(
  tool: string,
  args: Record<string, unknown>,
  ctx: {
    record: AgentTaskRecord;
    deps: AgentDeps;
    policy: WorkspacePolicy;
    signal?: AbortSignal | undefined;
  },
): Promise<string | null> {
  const { record, deps, policy, signal } = ctx;

  if (!KNOWN_AGENT_TOOLS.has(tool)) {
    const msg =
      `Unknown tool "${tool}". Available tools: ${[...KNOWN_AGENT_TOOLS].join(", ")}. ` +
      `Call one of these exact names instead.`;
    await appendEvent(record, {
      phase: record.phase,
      kind: "error",
      text: `Unknown tool: ${tool}`,
    });
    return `TOOL ${tool} RESULT:\n${clipText(
      JSON.stringify({ error: msg, available: [...KNOWN_AGENT_TOOLS] }, null, 1),
    )}`;
  }

  // Shared tier decision — identical table to the chat stream.
  const tierDecision = decideToolTier(tool);
  if (!tierDecision.allowed) {
    const blockMsg = tierDecision.message;
    await appendEvent(record, {
      phase: record.phase,
      kind: "error",
      text: blockMsg,
    });
    return `TOOL ${tool} RESULT:\n${clipText(JSON.stringify({ error: blockMsg, blocked: true }))}`;
  }

  // Baseline BEFORE the first modification — separates regressions from
  // pre-existing failures.
  if ((tool === "write_file" || tool === "edit_file") && !record.baseline) {
    const scripts = await declaredVerifyScripts(policy);
    if (scripts.length > 0) {
      await appendEvent(record, {
        phase: record.phase,
        kind: "check",
        text: `Capturing baseline before first edit: ${scripts.join(", ")}`,
      });
      record.baseline = await runChecks(policy, scripts);
      await saveTask(record);
    }
  }

  // Snapshot original content before modification (enables revert).
  if (tool === "write_file" || tool === "edit_file") {
    const target = String(args["path"] ?? "");
    if (target && record.snapshots[target] === undefined) {
      try {
        const { resolveWorkspacePath } = await import("./workspace");
        const abs = await resolveWorkspacePath(policy, target, "read");
        const fs = await import("node:fs/promises");
        record.snapshots[target] = await fs.readFile(abs, "utf-8");
      } catch {
        record.snapshots[target] = null; // did not exist → created by task
      }
    }
  }

  // Approval flow, delegated to the shared authorization policy. The approval
  // TRANSPORT stays the engine's own task-store approval (polled by
  // POST /api/agent) — only the decision logic is shared.
  let approvalNote: string = tierDecision.tier;
  const auth = await authorizeToolCall({
    tool,
    args,
    source: "engine",
    signal,
    requestApproval: async () => {
      const prevPhase = record.phase;
      // Register the resolver BEFORE the pending state becomes visible in the
      // store, so an approval can never observe a pending record that nobody
      // can resolve.
      const approvalDone = waitForApproval(record, signal);
      record.approval = {
        tool,
        args,
        description: describeApproval(tool, args),
        state: "pending",
        at: deps.now(),
      };
      record.phase = "NEEDS_APPROVAL";
      await saveTask(record);
      await appendEvent(record, {
        phase: "NEEDS_APPROVAL",
        kind: "approval",
        text: `Approval required: ${tool}`,
        detail: JSON.stringify(args).slice(0, 800),
      });
      const approved = await approvalDone;
      // waitForApproval's timer marks the state "expired" before resolving;
      // do not overwrite that with "denied" (they mean different things).
      const expired = !approved && record.approval?.state === "expired";
      record.approval.state = approved ? "approved" : expired ? "expired" : "denied";
      record.phase = prevPhase;
      await saveTask(record);
      approvalNote = record.approval.state;
      return approved ? "approved" : expired ? "expired" : "denied";
    },
  });

  if (!auth.ok) {
    const state = record.approval?.state ?? "denied";
    const denyMsg =
      auth.reason === "never"
        ? auth.message
        : `Approval ${state} for ${tool} — the action was NOT performed. Do not retry it; report this to the user.`;
    await appendEvent(record, {
      phase: record.phase,
      kind: auth.reason === "never" ? "error" : "approval",
      text: auth.reason === "never" ? denyMsg : `Approval ${state}: ${tool}`,
    });
    record.approval = null;
    return `TOOL ${tool} RESULT:\n${clipText(JSON.stringify({ error: denyMsg, blocked: auth.reason === "never" }))}`;
  }
  if (auth.tier === "confirm") record.approval = null;

  if (signal?.aborted) return null;

  await appendEvent(record, {
    phase: record.phase,
    kind: "tool_start",
    text: tool,
    detail: clipText(JSON.stringify(args), 600),
  });

  let result: unknown;
  let errorMessage: string | null = null;
  try {
    result = await deps.executeTool(tool, args, {
      policy,
      record,
      signal,
      approval: auth.approval,
    });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    result = { error: errorMessage };
  }

  // Track file changes + progress for edits.
  const changedPath =
    tool === "write_file" || tool === "edit_file" ? String(args["path"] ?? "") : null;
  if (changedPath && !errorMessage) {
    const rel = (result as { path?: string })?.path ?? changedPath;
    if (!record.changedFiles.includes(rel)) record.changedFiles.push(rel);
    await appendStep(record, {
      phase: "IMPLEMENTING",
      summary: `${tool} → ${rel}`,
    });
    await appendEvent(record, {
      phase: "IMPLEMENTING",
      kind: "tool_result",
      text: `Changed ${rel}`,
      detail: clipText(String((result as { diff?: string })?.diff ?? ""), 1200),
    });
  } else {
    await appendEvent(record, {
      phase: record.phase,
      kind: "tool_result",
      text: errorMessage ? `${tool} failed` : `${tool} ok`,
      detail: clipText(errorMessage ?? JSON.stringify(result ?? null), 800),
    });
  }

  logActivity({
    toolName: `agent.${tool}`,
    input: args,
    result:
      result && typeof result === "object"
        ? (result as Record<string, unknown>)
        : { value: String(result) },
    approvalStatus: approvalNote,
  }).catch(() => {});

  return `TOOL ${tool} RESULT:\n${clipText(JSON.stringify(result ?? null, null, 1))}`;
}

function describeApproval(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "write_file":
      return `Write file ${String(args["path"] ?? "?")}`;
    case "edit_file":
      return `Edit file ${String(args["path"] ?? "?")}`;
    case "run_script":
      return `Run project script "${String(args["script"] ?? "?")}"`;
    case "run_command":
      return `Run command: ${String(args["command"] ?? "?")}`;
    default:
      return `${tool} ${JSON.stringify(args).slice(0, 200)}`;
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "UNDERSTANDING":
      return "Understanding the task";
    case "INVESTIGATING":
      return "Investigating the codebase";
    case "PLANNING":
      return "Planning the change";
    case "IMPLEMENTING":
      return "Implementing changes";
    case "TESTING":
      return "Running checks";
    case "CORRECTING":
      return "Correcting failures";
    case "NEEDS_APPROVAL":
      return "Waiting for approval";
    default:
      return phase;
  }
}

function lastReport(record: AgentTaskRecord): string {
  if (record.finalReport) return record.finalReport;
  const assistants = record.transcript.filter((m) => m.role === "assistant");
  const last = assistants[assistants.length - 1];
  if (!last) return "No report produced.";
  return parseAgentMetadata(last.content).text || "No report produced.";
}

// ── Public lifecycle API ────────────────────────────────────

export interface StartAgentParams {
  repoRoot: string;
  title: string;
  maxIterations?: number;
  /** Override the initial phase model (else route-derived). */
  model?: string;
}

export interface StartedAgent {
  record: AgentTaskRecord;
  /** Resolves when the loop finishes (any terminal phase). */
  done: Promise<AgentTaskRecord>;
}

/**
 * Start a coding task. Rejects when another task is already active in this
 * workspace (duplicate/conflicting execution prevention) or when the loop
 * fails to launch.
 */
export async function startCodingAgent(
  params: StartAgentParams,
  depsOverride?: Partial<AgentDeps>,
): Promise<StartedAgent> {
  const repoRoot = path.resolve(params.repoRoot);
  await ensureRecovered(repoRoot);

  const existing = await findActiveTask(repoRoot);
  if (existing) {
    throw Object.assign(
      new Error(
        `A coding task is already active (${existing.id}: "${existing.title}", phase ${existing.phase}). Cancel it first or wait for it to finish.`,
      ),
      { code: "AGENT_BUSY" },
    );
  }

  const title = params.title.trim();
  if (!title) throw new Error("Task title must be non-empty");

  const record: AgentTaskRecord = {
    id: `agt-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
    title,
    repoRoot,
    phase: "IDLE",
    model: params.model ?? getModelForRoute("AGENT"),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    iterations: 0,
    maxIterations: Math.max(3, Math.min(40, params.maxIterations ?? MAX_ITERATIONS)),
    steps: [],
    events: [],
    changedFiles: [],
    snapshots: {},
    baseline: null,
    verificationRuns: [],
    transcript: [],
    approval: null,
  };
  await saveTask(record);

  await createWorkspace(repoRoot); // must exist before the task starts
  const deps: AgentDeps = {
    ...defaultDeps(),
    ...depsOverride,
  };

  const controller = new AbortController();
  controllers.set(record.id, controller);

  const done = runAgentLoop({
    record,
    deps,
    signal: controller.signal,
  })
    .catch((err: unknown) => {
      record.phase = "FAILED";
      record.error = err instanceof Error ? err.message : String(err);
      controllers.delete(record.id);
      saveTask(record).catch(() => {});
      return record;
    })
    .finally(() => {
      controllers.delete(record.id);
    });

  return { record, done };
}

/** Cancel a running task. True when an active loop was signalled. */
export function cancelAgentTask(taskId: string): boolean {
  const c = controllers.get(taskId);
  if (!c) return false;
  c.abort();
  return true;
}

/** Resume an interrupted/cancelled/failed task without redoing completed steps. */
export async function resumeAgent(
  repoRoot: string,
  taskId: string,
  depsOverride?: Partial<AgentDeps>,
): Promise<StartedAgent> {
  const root = path.resolve(repoRoot);
  await ensureRecovered(root);
  const existing = await findActiveTask(root);
  if (existing && existing.id !== taskId) {
    throw Object.assign(new Error(`Another task is active (${existing.id}) — cancel it first.`), {
      code: "AGENT_BUSY",
    });
  }
  const record = await loadTask(root, taskId);
  if (!record) throw new Error(`Task not found: ${taskId}`);
  if (!["CANCELLED", "FAILED"].includes(record.phase)) {
    throw new Error(
      `Task ${taskId} is ${record.phase} — only cancelled/failed tasks can be resumed`,
    );
  }
  if (controllers.has(taskId)) {
    throw Object.assign(new Error(`Task ${taskId} is already running`), {
      code: "AGENT_BUSY",
    });
  }

  record.interrupted = false;
  delete record.error;
  record.phase = "IDLE";
  record.updatedAt = Date.now();
  await saveTask(record);

  await createWorkspace(root); // must exist before resuming
  const deps: AgentDeps = {
    ...defaultDeps(),
    ...depsOverride,
  };
  const controller = new AbortController();
  controllers.set(record.id, controller);

  const done = runAgentLoop({
    record,
    deps,
    signal: controller.signal,
  })
    .catch((err: unknown) => {
      record.phase = "FAILED";
      record.error = err instanceof Error ? err.message : String(err);
      controllers.delete(record.id);
      saveTask(record).catch(() => {});
      return record;
    })
    .finally(() => {
      controllers.delete(record.id);
    });

  return { record, done };
}
