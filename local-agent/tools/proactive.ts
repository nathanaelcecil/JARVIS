/**
 * Proactive tools for the local agent:
 *  - notify:            macOS notification banner (osascript)
 *  - runBackground:     start a long-running command as a tracked background job
 *  - getJob:            inspect a job's status / exit code / output
 *
 * When a background job finishes, the agent POSTs to the web app's
 * /api/proactive endpoint so JARVIS can proactively report the real result
 * (in-chat + voice + banner).
 */

import { execFile, spawn, type ChildProcess } from "child_process";
import { classifyShellCommand } from "./terminal";

// ── notify ──────────────────────────────────────────────────

export function notify(args: {
  message: string;
  title?: string;
}): Promise<{ success: boolean; error?: string }> {
  const message = (args.message ?? "").trim();
  if (!message) return Promise.resolve({ success: false, error: "message must not be empty" });

  const safe = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const title = safe(args.title ?? "JARVIS");
  const script = `display notification "${safe(message.slice(0, 300))}" with title "${title}" sound name "Glass"`;

  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", script],
      { timeout: 5000 },
      (err) => {
        if (err) resolve({ success: false, error: err.message });
        else resolve({ success: true });
      }
    );
  });
}

// ── Background jobs ─────────────────────────────────────────

export interface BackgroundJob {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "completed" | "failed" | "blocked";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

const MAX_OUTPUT = 20_000; // keep the last 20KB of each stream
const jobs = new Map<string, BackgroundJob>();
const children = new Map<string, ChildProcess>();

// Web app URL for the task-done callback (vite dev server port)
const WEB_URL = process.env["JARVIS_WEB_URL"] ?? "http://127.0.0.1:3000";

/**
 * Start a command in the background. Returns immediately with a job id.
 * NEVER-classified commands are refused up front.
 */
export function runBackground(args: {
  command: string;
  cwd?: string;
  label?: string;
}): BackgroundJob {
  const command = args.command ?? "";
  const cwd = args.cwd ?? process.cwd();
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const classification = classifyShellCommand(command);
  if (classification.classification === "never") {
    const job: BackgroundJob = {
      id,
      command,
      cwd,
      status: "blocked",
      exitCode: null,
      stdout: "",
      stderr: `BLOCKED: ${classification.reason}`,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
    };
    jobs.set(id, job);
    return job;
  }

  const startedMs = Date.now();
  const job: BackgroundJob = {
    id,
    command,
    cwd,
    status: "running",
    exitCode: null,
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
  };
  jobs.set(id, job);

  const child = spawn("bash", ["-c", command], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TERM: "dumb" },
    detached: false,
  });
  children.set(id, child);

  child.stdout?.on("data", (d: Buffer) => {
    job.stdout = (job.stdout + d.toString()).slice(-MAX_OUTPUT);
  });
  child.stderr?.on("data", (d: Buffer) => {
    job.stderr = (job.stderr + d.toString()).slice(-MAX_OUTPUT);
  });

  child.on("close", (code) => {
    children.delete(id);
    job.exitCode = code;
    job.status = code === 0 ? "completed" : "failed";
    job.finishedAt = new Date().toISOString();
    job.durationMs = Date.now() - startedMs;
    console.log(
      `[Agent] background ${id} → ${job.status} (exit ${code}): ${command.slice(0, 120)}`
    );

    // Proactive callback: JARVIS reports the result to the user
    reportCompletion(job, args.label ?? command);
  });

  child.on("error", (err) => {
    children.delete(id);
    job.status = "failed";
    job.exitCode = -1;
    job.stderr = (job.stderr + `\nspawn error: ${err.message}`).slice(-MAX_OUTPUT);
    job.finishedAt = new Date().toISOString();
    job.durationMs = Date.now() - startedMs;
    reportCompletion(job, args.label ?? command);
  });

  return job;
}

function reportCompletion(job: BackgroundJob, label: string): void {
  const summary =
    job.stdout.trim().split("\n").slice(-3).join("\n").slice(0, 500) ||
    job.stderr.trim().slice(0, 500) ||
    undefined;

  try {
    fetch(`${WEB_URL}/api/proactive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: job.id,
        label,
        exitCode: job.exitCode ?? -1,
        summary,
      }),
    }).catch((err) =>
      console.warn(`[Agent] task-done callback failed for ${job.id}:`, err)
    );
  } catch (err) {
    console.warn("[Agent] task-done callback threw:", err);
  }
}

/** Inspect a background job. */
export function getJob(args: { jobId: string }): {
  found: boolean;
  job?: BackgroundJob;
} {
  const job = jobs.get(args.jobId);
  if (!job) return { found: false };
  return { found: true, job };
}

/** List all tracked background jobs. */
export function listJobs(): { jobs: BackgroundJob[] } {
  return { jobs: Array.from(jobs.values()) };
}
