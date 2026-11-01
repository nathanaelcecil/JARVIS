/**
 * Shared types for the coding-agent engine and its task store.
 * Kept in their own module so engine.ts and task-store.ts can both import
 * without a circular dependency.
 */

export type AgentPhase =
  | "IDLE"
  | "UNDERSTANDING"
  | "INVESTIGATING"
  | "PLANNING"
  | "IMPLEMENTING"
  | "TESTING"
  | "CORRECTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "NEEDS_APPROVAL";

export type AgentEventKind =
  "phase" | "tool_start" | "tool_result" | "approval" | "check" | "note" | "error" | "report";

export interface AgentEvent {
  at: number;
  phase: AgentPhase;
  kind: AgentEventKind;
  /** One-line human/voice-readable summary. */
  text: string;
  /** Optional detail (tool args, output tail, diff snippet). */
  detail?: string;
}

export interface AgentStep {
  at: number;
  phase: AgentPhase;
  summary: string;
}

/** Result of one verification command (test/lint/…). */
export interface CheckResult {
  name: string;
  command: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  /** Tail of combined output, bounded. */
  outputTail: string;
}

export interface CheckReport {
  at: number;
  results: CheckResult[];
  /** exitCode 0 across the board. */
  allPassed: boolean;
}

export interface PendingApproval {
  tool: string;
  args: Record<string, unknown>;
  description: string;
  state: "pending" | "approved" | "denied" | "expired";
  at: number;
}

/** One chat turn inside the agent transcript. */
export interface TranscriptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentTaskRecord {
  id: string;
  /** The task as stated by the user (voice or typed). */
  title: string;
  repoRoot: string;
  phase: AgentPhase;
  model: string;
  createdAt: number;
  updatedAt: number;
  iterations: number;
  maxIterations: number;
  /** Milestones already achieved — resume must not redo these. */
  steps: AgentStep[];
  events: AgentEvent[];
  changedFiles: string[];
  /** rel path → original content (null = file did not exist). */
  snapshots: Record<string, string | null>;
  baseline: CheckReport | null;
  verificationRuns: CheckReport[];
  transcript: TranscriptMessage[];
  approval: PendingApproval | null;
  finalReport?: string;
  error?: string;
  interrupted?: boolean;
}
