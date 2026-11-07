/**
 * One authorization policy for every tool call.
 *
 * Before this module, stream.ts repeated the same tier check + confirm prompt
 * at three call sites and the coding agent had a fourth copy. They now share
 * `decideToolTier()` (the decision) and `authorizeToolCall()` (the decision
 * plus the approval interaction).
 *
 * Tiers still come from guardrails.ts (`toolPermissionCategory` +
 * `checkPermission`), so behavior is unchanged: auto runs, confirm asks, never
 * is refused, unknown tools default to confirm, and `promoteTool()` still
 * cannot promote a never-tier tool.
 *
 * Approval transport differs by call site but is injected:
 *   - chat stream: SSE `confirm_request` + POST /api/confirm
 *   - coding agent: its own task-store approval (polled by /api/agent)
 * A confirm-tier LOCAL-AGENT tool additionally gets a short-lived HMAC
 * approval token, minted only here, after a real "approved" decision.
 */

import { join } from "node:path";
import { checkPermission, toolPermissionCategory, type Permission } from "./guardrails";
import {
  cancelConfirmation,
  mintConfirmId,
  registerConfirmation,
  type ConfirmDecision,
} from "./confirmations";
import { TOOL_TIERS } from "./tool-tiers";
import { mintApprovalToken, readApprovalKey } from "../../local-agent/approval";
import { isToolAllowedForTask } from "./task-approvals";

export type AuthorizationSource = "fast" | "data" | "tool" | "engine" | "background";

export type AuthorizationFailureReason =
  "never" | "denied" | "expired" | "cancelled" | "invalid_args";

export interface ConfirmRequestPayload {
  tool: string;
  args: Record<string, unknown>;
  confirmId: string;
  /** Present when the UI may offer "always allow this tool for this task". */
  taskId?: string | undefined;
}

export interface AuthorizeToolParams {
  tool: string;
  args: Record<string, unknown>;
  source: AuthorizationSource;
  /** Chat turn id: enables "always allow for this task" and its reuse. */
  taskId?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Emit the SSE `confirm_request` (or an equivalent UI prompt). */
  emitConfirmRequest?: ((payload: ConfirmRequestPayload) => void) | undefined;
  /** Custom approval transport; defaults to the shared confirmation registry. */
  requestApproval?:
    | ((params: {
        tool: string;
        args: Record<string, unknown>;
        confirmId: string;
        signal?: AbortSignal | undefined;
      }) => Promise<ConfirmDecision>)
    | undefined;
}

export type AuthorizationResult =
  | { ok: true; tier: Permission; approval?: string }
  | { ok: false; reason: AuthorizationFailureReason; message: string; tier: Permission };

export interface ToolTierDecision {
  allowed: boolean;
  tier: Permission;
  /** Message used for the never tier (unchanged from the previous call sites). */
  message: string;
}

/** The single tier decision. Never-tier tools are refused here. */
export function decideToolTier(tool: string): ToolTierDecision {
  const category = toolPermissionCategory(tool);
  const { allowed, permission } = checkPermission(category);
  return {
    allowed,
    tier: permission,
    message: `Tool blocked by security policy: ${tool} (tier: ${permission})`,
  };
}

const APPROVAL_KEY_FILE_ENV = "JARVIS_APPROVAL_KEY_FILE";

function approvalKeyPath(): string {
  return process.env[APPROVAL_KEY_FILE_ENV] ?? join(process.cwd(), "local-agent", ".approval-key");
}

let warnedMissingKey = false;

/**
 * Mint an approval token for a local-agent tool. Server-side/in-process tools
 * (Gmail, Calendar, Notion, repo tools) are not in TOOL_TIERS and need none.
 */
function mintLocalAgentApproval(tool: string, args: Record<string, unknown>): string | undefined {
  if (!(tool in TOOL_TIERS)) return undefined;
  const key = readApprovalKey(approvalKeyPath());
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn(
        "[Auth] local-agent approval key is missing; confirm-tier local tools will be refused " +
          "(start the local agent once to create local-agent/.approval-key)",
      );
    }
    return undefined;
  }
  return mintApprovalToken({ key, tool, args });
}

function failureMessage(
  tool: string,
  reason: AuthorizationFailureReason,
  neverMessage: string,
): string {
  switch (reason) {
    case "never":
      return neverMessage;
    case "denied":
      return `Action denied by user: ${tool}`;
    case "expired":
      return `Confirmation timed out after 3 minutes: ${tool} — nothing was executed. Ask me again to retry.`;
    case "cancelled":
      return `Confirmation cancelled: ${tool} — nothing was executed.`;
    case "invalid_args":
      return `Invalid arguments for ${tool}: arguments must be a plain JSON object.`;
  }
}

/**
 * Await an already-registered confirmation, cancelling it if the signal fires.
 * Registration happens before the prompt is emitted so an immediate click can
 * never race an unregistered id.
 */
async function awaitRegisteredConfirmation(params: {
  pending: Promise<ConfirmDecision>;
  confirmId: string;
  signal?: AbortSignal | undefined;
}): Promise<ConfirmDecision> {
  if (params.signal?.aborted) {
    cancelConfirmation(params.confirmId);
    return "cancelled";
  }
  const onAbort = () => cancelConfirmation(params.confirmId);
  params.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await params.pending;
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Authorize one tool call. Emits the confirmation prompt (when applicable)
 * BEFORE awaiting the decision, preserving the previous event order.
 */
export async function authorizeToolCall(params: AuthorizeToolParams): Promise<AuthorizationResult> {
  if (params.args === null || typeof params.args !== "object" || Array.isArray(params.args)) {
    return {
      ok: false,
      reason: "invalid_args",
      message: failureMessage(params.tool, "invalid_args", ""),
      tier: "confirm",
    };
  }

  const decision = decideToolTier(params.tool);

  if (!decision.allowed) {
    return {
      ok: false,
      reason: "never",
      message: decision.message,
      tier: decision.tier,
    };
  }

  if (decision.tier === "auto") {
    return { ok: true, tier: "auto" };
  }

  // The user already said "always allow this tool for this task": skip the
  // prompt, but still mint a fresh single-use approval token below.
  if (isToolAllowedForTask(params.taskId, params.tool)) {
    const preApproved = mintLocalAgentApproval(params.tool, params.args);
    return preApproved === undefined
      ? { ok: true, tier: decision.tier }
      : { ok: true, tier: decision.tier, approval: preApproved };
  }

  const confirmId = mintConfirmId();
  // Register BEFORE emitting so a click that lands immediately after the
  // prompt can always find the pending entry.
  const registered = params.requestApproval
    ? null
    : registerConfirmation({
        tool: params.tool,
        args: params.args,
        confirmId,
        taskId: params.taskId,
      });

  params.emitConfirmRequest?.({
    tool: params.tool,
    args: params.args,
    confirmId,
    ...(params.taskId ? { taskId: params.taskId } : {}),
  });

  const outcome = registered
    ? await awaitRegisteredConfirmation({
        pending: registered,
        confirmId,
        signal: params.signal,
      })
    : await params.requestApproval!({
        tool: params.tool,
        args: params.args,
        confirmId,
        signal: params.signal,
      });

  if (outcome !== "approved") {
    const reason: AuthorizationFailureReason =
      outcome === "expired" ? "expired" : outcome === "cancelled" ? "cancelled" : "denied";
    return {
      ok: false,
      reason,
      message: failureMessage(params.tool, reason, decision.message),
      tier: decision.tier,
    };
  }

  const approval = mintLocalAgentApproval(params.tool, params.args);
  return approval === undefined
    ? { ok: true, tier: decision.tier }
    : { ok: true, tier: decision.tier, approval };
}
