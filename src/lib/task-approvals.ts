/**
 * Task-scoped tool approvals — "always allow this tool for this task".
 *
 * A normal confirmation covers ONE call: approve it and the next identical
 * call asks again. That is right for a one-off action but tedious in the middle
 * of a task that needs the same tool repeatedly (e.g. typing into several
 * fields). This registry remembers, per chat turn ("task"), which tools the
 * user already allowed.
 *
 * Rules that keep it safe:
 * - Scope is a single task id handed out per stream request; it never survives
 *   the turn (the stream clears it when it ends or is aborted).
 * - Only the tool name is remembered, never arguments, and only after an
 *   explicit "allow for this task" click — a plain Approve does not widen scope.
 * - A remembered tool still mints a fresh approval token per call, so the
 *   local agent's single-use nonce/args-hash protection is unchanged.
 * - `never`-tier tools never reach this registry; the tier decision happens
 *   first.
 */

const allowedToolsByTask = new Map<string, Set<string>>();

/** Remember that `tool` was allowed for the rest of `taskId`. */
export function allowToolForTask(taskId: string, tool: string): void {
  if (!taskId || !tool) return;
  const existing = allowedToolsByTask.get(taskId);
  if (existing) {
    existing.add(tool);
    return;
  }
  allowedToolsByTask.set(taskId, new Set([tool]));
}

/** True when the user already allowed this tool for this task. */
export function isToolAllowedForTask(taskId: string | undefined, tool: string): boolean {
  if (!taskId) return false;
  return allowedToolsByTask.get(taskId)?.has(tool) === true;
}

/** List the tools allowed for a task (ordering is insertion order). */
export function toolsAllowedForTask(taskId: string): string[] {
  return [...(allowedToolsByTask.get(taskId) ?? [])];
}

/** Drop a task's scope entirely. Called when the stream ends or aborts. */
export function clearTaskApprovals(taskId: string): void {
  allowedToolsByTask.delete(taskId);
}

/** Test/diagnostic aid. */
export function clearAllTaskApprovals(): void {
  allowedToolsByTask.clear();
}

/** Number of tasks with at least one allowed tool (diagnostic aid). */
export function taskApprovalScopeCount(): number {
  return allowedToolsByTask.size;
}
