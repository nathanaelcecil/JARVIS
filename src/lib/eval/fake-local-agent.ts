/**
 * In-process fake local agent for offline evals.
 *
 * It is the REAL server factory from local-agent/server.ts (real bearer auth,
 * real argument validation, real approval-token verification) listening on an
 * ephemeral 127.0.0.1 port, with fake tool HANDLERS. Nothing here touches
 * Playwright, .agent-secret or .approval-key on disk.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createAgentServer, type ToolHandler } from "../../../local-agent/server";
import type { ToolTier } from "../tool-tiers";

export const EVAL_SECRET = "eval-bearer-secret";
export const EVAL_APPROVAL_KEY = "e".repeat(64);

export interface FakeAgentTool {
  handler: ToolHandler;
  calls: Array<Record<string, unknown>>;
}

export interface FakeLocalAgent {
  url: string;
  secret: string;
  approvalKey: string;
  tools: Record<string, FakeAgentTool>;
  close: () => Promise<void>;
  call: (
    tool: string,
    args: Record<string, unknown>,
    approvalToken?: string,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
}

const fake = (result: unknown): FakeAgentTool => {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    handler: (args) => {
      calls.push(args);
      return result;
    },
  };
};

export async function startFakeLocalAgent(
  options: {
    approvalKey?: string | null;
    tierFor?: (tool: string) => ToolTier;
    tools?: Record<string, FakeAgentTool>;
  } = {},
): Promise<FakeLocalAgent> {
  const tools =
    options.tools ??
    ({
      open_app: fake({ success: true, app: "Safari" }),
      list_directory: fake({ success: true, path: "/tmp", entries: [] }),
      run_command: fake({ success: true, stdout: "ok", exitCode: 0 }),
      get_volume: fake({ success: true, volume: 25 }),
    } satisfies Record<string, FakeAgentTool>);

  const approvalKey = options.approvalKey === undefined ? EVAL_APPROVAL_KEY : options.approvalKey;

  const handlers: Record<string, ToolHandler> = {};
  for (const [name, entry] of Object.entries(tools)) handlers[name] = entry.handler;

  const server: Server = createAgentServer({
    secret: EVAL_SECRET,
    approvalKey,
    tools: handlers,
    log: () => {},
    ...(options.tierFor ? { tierFor: options.tierFor } : {}),
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    secret: EVAL_SECRET,
    approvalKey: approvalKey ?? "",
    tools,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    async call(tool, args, approvalToken) {
      const res = await fetch(`${url}/call`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${EVAL_SECRET}`,
        },
        body: JSON.stringify({
          tool,
          args,
          ...(approvalToken ? { approvalToken } : {}),
        }),
      });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { raw: text };
      }
      return { status: res.status, body };
    },
  };
}
