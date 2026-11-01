/**
 * Procedure replay — the part that makes a learned phrase instant.
 *
 * A replay is only allowed when every step is `auto` tier. That is the whole
 * safety argument: a confirm-tier step needs an approval decision, and the
 * honest place for that decision is the normal model path (which shows a card
 * and mints a token). Rather than silently auto-approving a taught sequence,
 * this refuses the shortcut and lets the model handle the request properly.
 *
 * The match itself is exact after normalisation (see procedures.ts), so a
 * near-miss phrase never replays the wrong sequence.
 */

import { matchProcedure, type Procedure, type ProcedureStep } from "./procedures";
import { tierForTool } from "../tool-tiers";

export interface ReplayPlan {
  procedure: Procedure;
  steps: ProcedureStep[];
}

/**
 * Return a replayable plan for this exact phrase, or null to let the model
 * answer normally.
 */
export async function planProcedureReplay(
  root: string,
  message: string,
): Promise<ReplayPlan | null> {
  const procedure = await matchProcedure(root, message);
  if (!procedure || procedure.steps.length === 0) return null;
  const automatic = procedure.steps.every((step) => tierForTool(step.tool) === "auto");
  return automatic ? { procedure, steps: procedure.steps } : null;
}

/** The spoken answer for a successful replay. Deliberately plain. */
export function describeReplayOutcome(trigger: string, stepCount: number): string {
  const steps = `${stepCount} ${stepCount === 1 ? "step" : "steps"}`;
  return `Done, sir — replayed “${trigger}” (${steps}), without troubling a model.`;
}

/** The answer when a replay was attempted but a step failed. */
export function describeReplayFailure(trigger: string, error: string): string {
  return `The saved “${trigger}” sequence did not complete: ${error}. Nothing else was run.`;
}
