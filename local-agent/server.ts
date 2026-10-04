/**
 * JARVIS Local Agent Server
 *
 * A lightweight HTTP server that provides filesystem, desktop-control,
 * and system tools to the JARVIS web app. Bound to 127.0.0.1 only.
 *
 * Auth: shared secret (LOCAL_AGENT_SECRET env var, generated on first run).
 * All requests must include: Authorization: Bearer <secret>
 *
 * Usage: node local-agent/server.ts
 * Port:  3008 (configurable via LOCAL_AGENT_PORT env var)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

// ── Import tool implementations ──
import { listDirectory, searchFiles, openInFinder, getFileMetadata } from "./tools/filesystem";
import { openApp, quitApp, listRunningApps } from "./tools/desktop";
import { getVolume, setVolume, getBrightness, getBattery, getRAM, getStorage } from "./tools/system";
import { runCommand, classifyShellCommand } from "./tools/terminal";
import {
  listRepos, getFile, listIssues, listPullRequests,
  listWorkflowRuns, getWorkflowRunLogs, createBranch,
  createOrUpdateFile, createIssue, createPullRequest,
  createComment, getDiff,
} from "./tools/github";
import {
  browserNavigate, browserExtract, browserScreenshot,
  browserClick, browserType, browserFillForm, browserDownload, browserClose,
} from "./tools/browser";
import { notify, runBackground, getJob, listJobs } from "./tools/proactive";

// ── Configuration ──
const PORT = parseInt(process.env["LOCAL_AGENT_PORT"] ?? "3008", 10);
const HOST = "127.0.0.1";
const SECRET_FILE = join(import.meta.dirname ?? process.cwd(), ".agent-secret");

// ── Shared secret management ──
function getOrCreateSecret(): string {
  if (existsSync(SECRET_FILE)) {
    return readFileSync(SECRET_FILE, "utf-8").trim();
  }
  const secret = randomBytes(32).toString("hex");
  writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  console.log(`[Agent] Generated new shared secret → ${SECRET_FILE}`);
  return secret;
}

const SECRET = getOrCreateSecret();

// ── Tool registry ──
type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal) => unknown;

const TOOLS: Record<string, ToolHandler> = {
  // Filesystem
  list_directory: (args) => listDirectory(args as { path: string }),
  search_files: (args) => searchFiles(args as { path: string; pattern: string; maxResults?: number }),
  open_in_finder: (args) => openInFinder(args as { path: string }),
  get_file_metadata: (args) => getFileMetadata(args as { path: string }),

  // Desktop control
  open_app: (args) => openApp(args as { name: string }),
  quit_app: (args) => quitApp(args as { name: string }),
  list_running_apps: () => listRunningApps(),

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
  run_background: (args) => runBackground(args as { command: string; cwd?: string; label?: string }),
  get_job: (args) => getJob(args as { jobId: string }),
  list_jobs: () => listJobs(),
  notify: (args) => notify(args as { message: string; title?: string }),

  // GitHub (read-only = auto, write = confirm, destructive = confirm with diff)
  gh_list_repos: (args) => listRepos(args as { owner?: string; type?: string; sort?: string; per_page?: number }),
  gh_get_file: (args) => getFile(args as { owner: string; repo: string; path: string; ref?: string }),
  gh_list_issues: (args) => listIssues(args as { owner: string; repo: string; state?: string; per_page?: number }),
  gh_list_prs: (args) => listPullRequests(args as { owner: string; repo: string; state?: string; per_page?: number }),
  gh_list_runs: (args) => listWorkflowRuns(args as { owner: string; repo: string; per_page?: number }),
  gh_run_logs: (args) => getWorkflowRunLogs(args as { owner: string; repo: string; run_id: number }),
  gh_get_diff: (args) => getDiff(args as { owner: string; repo: string; base: string; head: string }),
  gh_create_branch: (args) => createBranch(args as { owner: string; repo: string; branch: string; from?: string }),
  gh_create_file: (args) => createOrUpdateFile(args as { owner: string; repo: string; path: string; message: string; content: string; branch?: string; sha?: string }),
  gh_create_issue: (args) => createIssue(args as { owner: string; repo: string; title: string; body?: string; labels?: string[] }),
  gh_create_pr: (args) => createPullRequest(args as { owner: string; repo: string; title: string; body?: string; head: string; base?: string }),
  gh_create_comment: (args) => createComment(args as { owner: string; repo: string; issue_number: number; body: string }),

  // Browser automation
  browser_navigate: (args) => browserNavigate(args as { url: string; waitFor?: number }),
  browser_extract: (args) => browserExtract(args as { url?: string }),
  browser_screenshot: (args) => browserScreenshot(args as { path?: string; fullPage?: boolean }),
  browser_click: (args) => browserClick(args as { selector: string; timeout?: number }),
  browser_type: (args) => browserType(args as { selector: string; text: string; clear?: boolean; pressEnter?: boolean }),
  browser_fill_form: (args) => browserFillForm(args as { fields: Array<{ selector: string; value: string }>; submitSelector?: string }),
  browser_download: (args) => browserDownload(args as { url: string; destination?: string }),
  browser_close: () => browserClose(),
};

// ── Request handling ──
function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function checkAuth(req: IncomingMessage): boolean {
  const auth = req.headers["authorization"];
  if (!auth) return false;
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  return token === SECRET;
}

const server = createServer(async (req, res) => {
  // CORS headers for local development
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check (no auth required)
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { status: "ok", tools: Object.keys(TOOLS).length });
    return;
  }

  // Auth check for all other endpoints
  if (!checkAuth(req)) {
    sendJson(res, 401, { error: "Unauthorized — invalid or missing shared secret" });
    return;
  }

  // POST /call — the main tool-calling endpoint
  if (req.method === "POST" && req.url === "/call") {
    try {
      const body = await parseBody(req);
      const tool = body["tool"] as string;
      const args = (body["args"] as Record<string, unknown>) ?? {};

      if (!tool) {
        sendJson(res, 400, { error: "Missing 'tool' field in request body" });
        return;
      }

      const handler = TOOLS[tool];
      if (!handler) {
        sendJson(res, 404, { error: `Unknown tool: ${tool}` });
        return;
      }

      // Create AbortController — abort when client disconnects
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      req.on("close", onAbort);

      console.log(`[Agent] ${tool}`, JSON.stringify(args).slice(0, 200));
      let result: unknown;
      try {
        result = await Promise.resolve(handler(args, controller.signal));
      } finally {
        req.removeListener("close", onAbort);
      }
      console.log(`[Agent] ${tool} →`, JSON.stringify(result).slice(0, 300));

      sendJson(res, 200, result);
    } catch (err) {
      console.error("[Agent] Error:", err);
      sendJson(res, 500, { error: `Internal error: ${err instanceof Error ? err.message : err}` });
    }
    return;
  }

  // Unknown route
  sendJson(res, 404, { error: "Not found — POST /call or GET /health" });
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  ╔══════════════════════════════════════════╗");
  console.log("  ║  JARVIS Local Agent — Running            ║");
  console.log(`  ║  http://${HOST}:${PORT}                  ║`);
  console.log(`  ║  ${Object.keys(TOOLS).length} tools available                         ║`);
  console.log("  ╚══════════════════════════════════════════╝");
  console.log("");
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
