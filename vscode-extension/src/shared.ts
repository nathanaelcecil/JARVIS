/**
 * Protocol types and pure helpers shared by the JARVIS VS Code extension.
 *
 * Everything here is free of `vscode` imports so it can be unit-tested in the
 * root vitest suite (vscode-extension/src/*.test.ts).
 */

// ── Protocol payloads (mirror /api/agent responses) ────────

export interface AgentEventPublic {
  at: number;
  phase: string;
  kind: string;
  text: string;
  detail?: string;
}

export interface CheckResultPublic {
  name: string;
  command: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

export interface CheckReportPublic {
  at: number;
  results: CheckResultPublic[];
  allPassed: boolean;
}

export interface PendingApprovalPublic {
  tool: string;
  args: Record<string, unknown>;
  description: string;
  state: "pending" | "approved" | "denied" | "expired";
  at: number;
}

export interface AgentTaskPublic {
  id: string;
  title: string;
  repoRoot: string;
  phase: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  iterations: number;
  maxIterations: number;
  steps: Array<{ at: number; phase: string; summary: string }>;
  events: AgentEventPublic[];
  changedFiles: string[];
  baseline: CheckReportPublic | null;
  verificationRuns: CheckReportPublic[];
  approval: PendingApprovalPublic | null;
  finalReport?: string;
  error?: string;
  interrupted?: boolean;
  snapshotFiles: string[];
}

export interface DiffPayload {
  created: boolean;
  diff: string;
}

export interface StatusResponse {
  task?: AgentTaskPublic;
  diffs?: Record<string, DiffPayload>;
  active?: AgentTaskPublic | null;
  recent?: AgentTaskPublic[];
}

export interface ListResponse {
  repoRoot: string;
  activeTaskId: string | null;
  tasks: AgentTaskPublic[];
}

export interface MemoryEntryPublic {
  id: string;
  kind: string;
  content: string;
  fileRefs: string[];
  updatedAt: number;
  stale?: boolean;
}

export type Tone = "work" | "wait" | "done" | "error";

// ── Phase presentation ──────────────────────────────────────

const ACTIVE_PHASES = new Set([
  "IDLE",
  "UNDERSTANDING",
  "INVESTIGATING",
  "PLANNING",
  "IMPLEMENTING",
  "TESTING",
  "CORRECTING",
  "NEEDS_APPROVAL",
]);

export function isActivePhase(phase: string): boolean {
  return ACTIVE_PHASES.has(phase);
}

export function isTerminalPhase(phase: string): boolean {
  return phase === "COMPLETED" || phase === "FAILED" || phase === "CANCELLED";
}

export function phasePresentation(phase: string): { label: string; tone: Tone } {
  switch (phase) {
    case "UNDERSTANDING":
      return { label: "Understanding", tone: "work" };
    case "INVESTIGATING":
      return { label: "Investigating", tone: "work" };
    case "PLANNING":
      return { label: "Planning", tone: "work" };
    case "IMPLEMENTING":
      return { label: "Implementing", tone: "work" };
    case "TESTING":
      return { label: "Testing", tone: "work" };
    case "CORRECTING":
      return { label: "Correcting", tone: "work" };
    case "NEEDS_APPROVAL":
      return { label: "Approval needed", tone: "wait" };
    case "COMPLETED":
      return { label: "Completed", tone: "done" };
    case "FAILED":
      return { label: "Failed", tone: "error" };
    case "CANCELLED":
      return { label: "Cancelled", tone: "error" };
    default:
      return { label: phase, tone: "wait" };
  }
}

// ── HTML helpers ────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a unified-style diff as HTML. Repo content is untrusted: every line
 * is escaped before styling, so a file containing `</script>` cannot escape
 * the webview.
 */
export function renderDiffHtml(diff: string, maxLines = 400): string {
  const lines = diff.split("\n").slice(0, maxLines);
  const html = lines
    .map((l) => {
      const cls = l.startsWith("+")
        ? "add"
        : l.startsWith("-")
          ? "del"
          : l.startsWith("@@")
            ? "hunk"
            : l.startsWith("(")
              ? "meta"
              : "";
      return `<div class="dl ${cls}">${escapeHtml(l) || "&nbsp;"}</div>`;
    })
    .join("");
  const omitted = diff.split("\n").length - lines.length;
  return html + (omitted > 0 ? `<div class="dl meta">… ${omitted} more lines</div>` : "");
}

// ── Token file ──────────────────────────────────────────────

/** Parse the agent token file: hex, at least 32 chars, trimmed. */
export function parseTokenFile(raw: string): string | null {
  const t = raw.trim();
  if (t.length < 32) return null;
  if (!/^[a-f0-9]+$/i.test(t)) return null;
  return t;
}

// ── Context capping (never ship the whole workspace) ───────

export interface DiagnosticPublic {
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface EditorContext {
  file?: string;
  languageId?: string;
  selection?: string;
  fileText?: string;
  diagnostics?: DiagnosticPublic[];
  workspaceRoot?: string;
}

export const CAPS = {
  selectionChars: 2000,
  fileTextChars: 4000,
  maxDiagnostics: 20,
  maxDiagnosticChars: 300,
} as const;

/**
 * Enforce transmission caps BEFORE anything leaves the machine: only the
 * active file, the selection, and capped diagnostics — never the whole repo.
 */
export function capContext(ctx: EditorContext): EditorContext {
  const out: EditorContext = {};
  if (ctx.file !== undefined) out.file = ctx.file.slice(0, 500);
  if (ctx.languageId !== undefined) out.languageId = ctx.languageId.slice(0, 60);
  if (ctx.selection !== undefined) out.selection = ctx.selection.slice(0, CAPS.selectionChars);
  if (ctx.fileText !== undefined) out.fileText = ctx.fileText.slice(0, CAPS.fileTextChars);
  if (ctx.diagnostics !== undefined)
    out.diagnostics = ctx.diagnostics.slice(0, CAPS.maxDiagnostics).map((d) => ({
      line: Math.max(1, Math.floor(d.line)),
      severity: d.severity,
      message: d.message.slice(0, CAPS.maxDiagnosticChars),
    }));
  if (ctx.workspaceRoot !== undefined) out.workspaceRoot = ctx.workspaceRoot.slice(0, 500);
  return out;
}

/** Compose the agent task prompt from an editor context + user instruction. */
export function buildTaskPrompt(
  intent: "explain_selection" | "explain_file" | "fix_problems" | "freeform",
  instruction: string,
  ctx: EditorContext,
): string {
  const capped = capContext(ctx);
  const parts: string[] = [instruction.trim()];

  if (capped.file) parts.push(`File: ${capped.file}`);
  if (capped.languageId) parts.push(`Language: ${capped.languageId}`);
  if (capped.selection) {
    parts.push("Selected code:\n```\n" + capped.selection + "\n```");
  } else if (intent === "explain_file" && capped.fileText) {
    parts.push("File content:\n```\n" + capped.fileText + "\n```");
  }
  if (intent === "fix_problems" && capped.diagnostics?.length) {
    parts.push(
      "Problems reported by the editor:\n" +
        capped.diagnostics.map((d) => `- line ${d.line} [${d.severity}] ${d.message}`).join("\n"),
    );
  }
  return parts.filter(Boolean).join("\n\n").slice(0, 8000);
}

// ── Server URL validation ───────────────────────────────────

/**
 * Only loopback http(s) backends are accepted: the extension must not be
 * pointed at arbitrary remote hosts that could receive workspace context.
 */
export function validateServerUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname;
  const loopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!loopback) return null;
  return url.toString().replace(/\/$/, "");
}

export const DEFAULT_POLL_MS = 800;
export const DEFAULT_TIMEOUT_MS = 15_000;
