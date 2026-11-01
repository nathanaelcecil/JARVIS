/**
 * JARVIS Local Agent Server
 *
 * A lightweight HTTP server that provides filesystem, desktop-control,
 * and system tools to the JARVIS web app. Bound to 127.0.0.1 only.
 *
 * Auth is two-layered:
 *   1. Bearer secret in local-agent/.agent-secret (mode 0600, generated on
 *      first run). Authorizes the HTTP request.
 *   2. Approval token (HMAC under local-agent/.approval-key) for every
 *      confirm-tier tool. The server mints one only after a real human
 *      approval; the bearer secret alone can never run a confirm-tier tool.
 *
 * Usage: bun local-agent/server.ts
 * Port:  3008 (configurable via LOCAL_AGENT_PORT env var)
 *
 * `createAgentServer()` is exported for tests: importing this module binds no
 * port, writes no secret files and does not load Playwright.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";

// ── Import tool implementations ──
import { listDirectory, searchFiles, openInFinder, getFileMetadata } from "./tools/filesystem";
import { openApp, quitApp, listRunningApps } from "./tools/desktop";
import {
  handsListWindows,
  handsReadWindow,
  handsReadFocused,
  handsStatus,
  handsLook,
  handsReadScreen,
} from "./tools/hands";
import { spotlightSearch, contactsSearch, spotifyControl, spotifyStatus } from "./tools/mac";
import {
  controlClick,
  controlType,
  controlKey,
  controlScroll,
  controlDrag,
  controlMenu,
  controlPlace,
  controlFocus,
  controlMap,
  controlStatus,
} from "./tools/control";
import {
  getVolume,
  setVolume,
  getBrightness,
  getBattery,
  getRAM,
  getStorage,
} from "./tools/system";
import { runCommand, classifyShellCommand } from "./tools/terminal";
import {
  listRepos,
  getFile,
  listIssues,
  listPullRequests,
  listWorkflowRuns,
  getWorkflowRunLogs,
  createBranch,
  createOrUpdateFile,
  createIssue,
  createPullRequest,
  createComment,
  getDiff,
} from "./tools/github";
import { notify, runBackground, getJob, listJobs } from "./tools/proactive";

// ── Shared policy ──
import { tierForTool } from "../src/lib/tool-tiers";
import { assertToolSpecsCoverTools, validateToolArgs } from "./validate";
import {
  NonceStore,
  getOrCreateApprovalKey,
  verifyApprovalToken,
  type ApprovalCheck,
} from "./approval";

// ── Configuration ──
const DEFAULT_PORT = 3008;
const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

export type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal) => unknown;

/** Browser tools load Playwright lazily so importing this module stays cheap. */
const browserNavigateTool: ToolHandler = async (args) => {
  const { browserNavigate } = await import("./tools/browser");
  return browserNavigate(args as { url: string; waitFor?: number });
};
const browserExtractTool: ToolHandler = async (args) => {
  const { browserExtract } = await import("./tools/browser");
  return browserExtract(args as { url?: string });
};
const browserScreenshotTool: ToolHandler = async (args) => {
  const { browserScreenshot } = await import("./tools/browser");
  return browserScreenshot(args as { path?: string; fullPage?: boolean });
};
const browserClickTool: ToolHandler = async (args) => {
  const { browserClick } = await import("./tools/browser");
  return browserClick(args as { selector: string; timeout?: number });
};
const browserTypeTool: ToolHandler = async (args) => {
  const { browserType } = await import("./tools/browser");
  return browserType(
    args as { selector: string; text: string; clear?: boolean; pressEnter?: boolean },
  );
};
const browserFillFormTool: ToolHandler = async (args) => {
  const { browserFillForm } = await import("./tools/browser");
  return browserFillForm(
    args as { fields: Array<{ selector: string; value: string }>; submitSelector?: string },
  );
};
const browserDownloadTool: ToolHandler = async (args) => {
  const { browserDownload } = await import("./tools/browser");
  return browserDownload(args as { url: string; destination?: string });
};
const browserCloseTool: ToolHandler = async (): Promise<unknown> => {
  const { browserClose } = await import("./tools/browser");
  return browserClose();
};

// ── Tool registry ──
export const TOOLS: Record<string, ToolHandler> = {
  // Filesystem
  list_directory: (args) => listDirectory(args as { path: string }),
  search_files: (args) =>
    searchFiles(args as { path: string; pattern: string; maxResults?: number }),
  open_in_finder: (args) => openInFinder(args as { path: string }),
  get_file_metadata: (args) => getFileMetadata(args as { path: string }),

  // Desktop control
  open_app: (args) => openApp(args as { name: string }),
  quit_app: (args) => quitApp(args as { name: string }),
  list_running_apps: () => listRunningApps(),

  // Hands v1 — read-only observation of the screen. These tools can only look:
  // the helper they spawn has no click/type/key/menu capability at all.
  hands_list_windows: () => handsListWindows(),
  hands_read_window: (args) => handsReadWindow(args as { pid: number; windowIndex?: number }),
  hands_read_focused: () => handsReadFocused(),
  hands_status: () => handsStatus(),
  hands_look: (args) => handsLook(args as { display?: number; pid?: number; windowIndex?: number }),
  hands_read_screen: (args) => handsReadScreen(args as { pid: number; windowIndex?: number }),

  // Hands v2 — computer CONTROL. Every one of these is confirm-tier: the local
  // agent refuses the call without an approval token, so the bearer secret
  // alone can never click, type or press a key.
  control_click: (args) => controlClick(args as Parameters<typeof controlClick>[0]),
  control_type: (args) => controlType(args as Parameters<typeof controlType>[0]),
  control_key: (args) => controlKey(args as Parameters<typeof controlKey>[0]),
  control_scroll: (args) => controlScroll(args as Parameters<typeof controlScroll>[0]),
  control_drag: (args) => controlDrag(args as Parameters<typeof controlDrag>[0]),
  control_menu: (args) => controlMenu(args as Parameters<typeof controlMenu>[0]),
  control_place: (args) => controlPlace(args as Parameters<typeof controlPlace>[0]),
  control_focus: (args) => controlFocus(args as Parameters<typeof controlFocus>[0]),
  control_map: (args) => controlMap(args as Parameters<typeof controlMap>[0]),
  control_status: () => controlStatus(),

  // macOS integrations
  spotlight_search: (args) =>
    spotlightSearch(args as { query: string; path?: string; maxResults?: number }),
  contacts_search: (args) => contactsSearch(args as { query: string; maxResults?: number }),
  spotify_control: (args) =>
    spotifyControl(
      args as {
        action: Parameters<typeof spotifyControl>[0]["action"];
        volume?: number;
        uri?: string;
      },
    ),
  spotify_status: () => spotifyStatus(),

  // System
  get_volume: () => getVolume(),
  set_volume: (args) => setVolume(args as { level: number }),
  get_brightness: () => getBrightness(),
  get_battery: () => getBattery(),
  get_ram: () => getRAM(),
  get_storage: () => getStorage(),

  // Terminal
  run_command: (args) => runCommand(args as { command: string; cwd?: string; timeout?: number }),
  classify_command: (args) => classifyShellCommand((args as { command: string }).command),

  // Proactive JARVIS
  run_background: (args) =>
    runBackground(args as { command: string; cwd?: string; label?: string }),
  get_job: (args) => getJob(args as { jobId: string }),
  list_jobs: () => listJobs(),
  notify: (args) => notify(args as { message: string; title?: string }),

  // GitHub (read-only = auto, write = confirm, destructive = confirm with diff)
  gh_list_repos: (args) =>
    listRepos(args as { owner?: string; type?: string; sort?: string; per_page?: number }),
  gh_get_file: (args) =>
    getFile(args as { owner: string; repo: string; path: string; ref?: string }),
  gh_list_issues: (args) =>
    listIssues(args as { owner: string; repo: string; state?: string; per_page?: number }),
  gh_list_prs: (args) =>
    listPullRequests(args as { owner: string; repo: string; state?: string; per_page?: number }),
  gh_list_runs: (args) =>
    listWorkflowRuns(args as { owner: string; repo: string; per_page?: number }),
  gh_run_logs: (args) =>
    getWorkflowRunLogs(args as { owner: string; repo: string; run_id: number }),
  gh_get_diff: (args) =>
    getDiff(args as { owner: string; repo: string; base: string; head: string }),
  gh_create_branch: (args) =>
    createBranch(args as { owner: string; repo: string; branch: string; from?: string }),
  gh_create_file: (args) =>
    createOrUpdateFile(
      args as {
        owner: string;
        repo: string;
        path: string;
        message: string;
        content: string;
        branch?: string;
        sha?: string;
      },
    ),
  gh_create_issue: (args) =>
    createIssue(
      args as { owner: string; repo: string; title: string; body?: string; labels?: string[] },
    ),
  gh_create_pr: (args) =>
    createPullRequest(
      args as {
        owner: string;
        repo: string;
        title: string;
        body?: string;
        head: string;
        base?: string;
      },
    ),
  gh_create_comment: (args) =>
    createComment(args as { owner: string; repo: string; issue_number: number; body: string }),

  // Browser automation
  browser_navigate: browserNavigateTool,
  browser_extract: browserExtractTool,
  browser_screenshot: browserScreenshotTool,
  browser_click: browserClickTool,
  browser_type: browserTypeTool,
  browser_fill_form: browserFillFormTool,
  browser_download: browserDownloadTool,
  browser_close: browserCloseTool,
};

// ── Request handling ──
class BodyTooLargeError extends Error {}

function parseBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Keep draining so the response can still be written, but stop
        // buffering — the limit is about memory, not about the socket.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new BodyTooLargeError("request body too large"));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("body must be a JSON object"));
          return;
        }
        resolvePromise(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

/**
 * Only loopback origins may read responses from a browser. Anything else gets
 * no `Access-Control-Allow-Origin`, so the browser blocks the read.
 *
 * The legitimate path (JARVIS server → local agent) is server-to-server and
 * ignores CORS entirely, so this cannot break tool calls; it only stops an
 * arbitrary web page from using a stolen secret against 127.0.0.1:3008.
 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" || u.protocol === "https:"
      ? u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]"
      : false;
  } catch {
    return false;
  }
}

export interface AgentServerConfig {
  /** Bearer secret. Required — tests pass one directly. */
  secret: string;
  /**
   * Approval HMAC key. When absent, confirm-tier tools are refused outright
   * (fail closed) rather than running on the bearer secret alone.
   */
  approvalKey?: string | null;
  /** Tool table override for tests. */
  tools?: Record<string, ToolHandler>;
  /** Injected clock for token tests. */
  now?: () => number;
  /** Tier lookup override (tests/evals). Defaults to the shared table. */
  tierFor?: (tool: string) => ReturnType<typeof tierForTool>;
  /** Sink for lifecycle log lines (defaults to console.log). */
  log?: (message: string) => void;
  maxBodyBytes?: number;
}

function checkAuth(req: IncomingMessage, secret: string): boolean {
  const auth = req.headers["authorization"];
  if (!auth) return false;
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  // Length-check first (timingSafeEqual throws on a length mismatch), then a
  // constant-time compare so the shared secret can't be probed byte-by-byte.
  if (token.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(token, "utf8"), Buffer.from(secret, "utf8"));
}

function authorizeCall(params: {
  tool: string;
  args: Record<string, unknown>;
  token: string | undefined;
  approvalKey: string | null;
  nonces: NonceStore;
  now: () => number;
  tierFor: (tool: string) => ReturnType<typeof tierForTool>;
}): ApprovalCheck {
  const tier = params.tierFor(params.tool);

  if (tier === "never") {
    return {
      ok: false,
      code: "tool_forbidden",
      status: 403,
      message: `tool ${params.tool} is in the never tier and cannot be executed`,
    };
  }
  if (tier === "auto") return { ok: true };

  // confirm tier
  if (!params.approvalKey) {
    return {
      ok: false,
      code: "approval_required",
      status: 401,
      message:
        "approval key not configured — confirm-tier tools are disabled until local-agent/.approval-key exists",
    };
  }
  if (typeof params.token !== "string" || params.token.length === 0) {
    return {
      ok: false,
      code: "approval_required",
      status: 401,
      message: `tool ${params.tool} requires a user approval token`,
    };
  }
  return verifyApprovalToken({
    key: params.approvalKey,
    token: params.token,
    tool: params.tool,
    args: params.args,
    now: params.now(),
    nonces: params.nonces,
  });
}

/** Build the HTTP server. Does not listen; the caller decides when to bind. */
export function createAgentServer(config: AgentServerConfig): Server {
  const tools = config.tools ?? TOOLS;
  const log = config.log ?? ((message: string) => console.log(message));
  const now = config.now ?? (() => Date.now());
  const maxBodyBytes = config.maxBodyBytes ?? MAX_BODY_BYTES;
  const nonces = new NonceStore();
  const tierFor = config.tierFor ?? tierForTool;

  assertToolSpecsCoverTools(Object.keys(tools), { requireAll: config.tools === undefined });

  return createServer(async (req, res) => {
    try {
      // CORS: only loopback origins are echoed back; all others receive no
      // Access-Control-Allow-Origin header (browser blocks the cross-origin read).
      const origin = req.headers["origin"];
      if (isLoopbackOrigin(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin!);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health check (no auth required)
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { status: "ok", tools: Object.keys(tools).length });
        return;
      }

      // Auth check for all other endpoints
      if (!checkAuth(req, config.secret)) {
        sendJson(res, 401, { error: "Unauthorized — invalid or missing shared secret" });
        return;
      }

      if (req.method === "POST" && req.url === "/call") {
        let body: Record<string, unknown>;
        try {
          body = await parseBody(req, maxBodyBytes);
        } catch (err) {
          const status = err instanceof BodyTooLargeError ? 413 : 400;
          sendJson(res, status, {
            error: "invalid_arguments",
            message: err instanceof Error ? err.message : "invalid request body",
          });
          return;
        }

        const tool = body["tool"];
        if (typeof tool !== "string" || tool.length === 0) {
          sendJson(res, 400, {
            error: "invalid_arguments",
            message: "missing or invalid 'tool' field",
          });
          return;
        }

        const handler = tools[tool];
        if (!handler) {
          sendJson(res, 404, { error: `Unknown tool: ${tool}` });
          return;
        }

        const argsInput = body["args"] ?? {};
        const validation = validateToolArgs(tool, argsInput);
        if (!validation.ok) {
          const payload: Record<string, unknown> = {
            error: "invalid_arguments",
            message: validation.failure.message,
          };
          if (validation.failure.field) payload["field"] = validation.failure.field;
          sendJson(res, 400, payload);
          return;
        }
        const args = validation.value;

        const headerToken = req.headers["x-jarvis-approval"];
        const approvalToken =
          typeof body["approvalToken"] === "string"
            ? body["approvalToken"]
            : typeof headerToken === "string"
              ? headerToken
              : undefined;

        const approval = authorizeCall({
          tool,
          args,
          token: approvalToken,
          approvalKey: config.approvalKey ?? null,
          nonces,
          now,
          tierFor,
        });
        if (!approval.ok) {
          sendJson(res, approval.status ?? 403, {
            error: approval.code ?? "approval_invalid",
            message: approval.message ?? "approval refused",
          });
          return;
        }

        // Create AbortController — abort when client disconnects
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        req.on("close", onAbort);

        log(`[Agent] ${tool} tier=${tierFor(tool)}`);
        let result: unknown;
        try {
          result = await Promise.resolve(handler(args, controller.signal));
        } finally {
          req.removeListener("close", onAbort);
        }
        log(`[Agent] ${tool} → ${result === undefined ? "ok" : "done"}`);

        sendJson(res, 200, result);
        return;
      }

      // Unknown route
      sendJson(res, 404, { error: "Not found — POST /call or GET /health" });
    } catch (err) {
      console.error("[Agent] Error:", err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: "internal_error",
          message: "the local agent failed to handle the request",
        });
      } else {
        res.end();
      }
    }
  });
}

// ── CLI entry point ─────────────────────────────────────────

function agentDir(): string {
  return import.meta.dirname ?? process.cwd();
}

export function getOrCreateSecret(secretFile: string): string {
  if (existsSync(secretFile)) {
    return readFileSync(secretFile, "utf-8").trim();
  }
  const secret = randomBytes(32).toString("hex");
  writeFileSync(secretFile, secret, { mode: 0o600, flag: "wx" });
  console.log(`[Agent] Generated new shared secret → ${secretFile}`);
  return secret;
}

function isEntryPoint(): boolean {
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (typeof meta.main === "boolean") return meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

export function startFromEnv(): Server {
  const port = parseInt(process.env["LOCAL_AGENT_PORT"] ?? String(DEFAULT_PORT), 10);
  const dir = agentDir();
  const secret = getOrCreateSecret(join(dir, ".agent-secret"));
  const approvalKey = getOrCreateApprovalKey(join(dir, ".approval-key"));

  const server = createAgentServer({
    secret,
    approvalKey,
    log: (message) => console.log(message),
  });

  server.listen(port, HOST, () => {
    console.log("");
    console.log("  ╔══════════════════════════════════════════╗");
    console.log("  ║  JARVIS Local Agent — Running            ║");
    console.log(`  ║  http://${HOST}:${port}                  ║`);
    console.log(`  ║  ${Object.keys(TOOLS).length} tools available                         ║`);
    console.log("  ╚══════════════════════════════════════════╝");
    console.log("");
    console.log(
      `[Agent] Tool call timeout: ${DEFAULT_TIMEOUT_MS}ms; approval required for confirm tier`,
    );
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("[Agent] Shutting down...");
    server.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });

  return server;
}

if (isEntryPoint()) {
  startFromEnv();
}
