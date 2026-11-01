/**
 * /api/agent — authenticated control plane for the coding agent.
 *
 * Used by the VS Code extension (and any local client). Every request
 * requires `Authorization: Bearer <token>` where the token lives in
 * .jarvis/agent-token (mode 0600, generated on first use) — no hardcoded
 * credentials, nothing sent anywhere but loopback.
 *
 * GET  ?list=1            → recent tasks (no transcripts/snapshots)
 * GET  ?memory=1          → stored project memory (inspect)
 * GET  ?taskId=…          → task status + review diffs
 * GET  ?taskId=…&snapshot=<relPath>
 *                         → pre-change content of one file the task changed
 *                           (for side-by-side review); null = task created it
 * POST {action}           → start | cancel | approve | resume | revert
 *                          | memory_update | memory_delete
 */

import { createFileRoute } from "@tanstack/react-router";
import { promises as fs } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  startCodingAgent,
  cancelAgentTask,
  resumeAgent,
  resolveAgentApproval,
} from "../../lib/agent/engine";
import { loadTask, listTasks, findActiveTask, saveTask } from "../../lib/agent/task-store";
import { listMemory, updateMemoryEntry, deleteMemoryEntry } from "../../lib/agent/memory";
import { createWorkspace, resolveWorkspacePath } from "../../lib/agent/workspace";
import { simpleDiff } from "../../lib/agent/repo-tools";
import type { AgentTaskRecord } from "../../lib/agent/engine-types";

const TOKEN_FILE = path.join(process.cwd(), ".jarvis", "agent-token");

/** Generated on first auth attempt; 32 random bytes, owner-readable only. */
async function getOrCreateToken(): Promise<string> {
  try {
    const existing = (await fs.readFile(TOKEN_FILE, "utf-8")).trim();
    if (existing.length >= 32) {
      // `mode` only applies at creation — enforce 0600 on an existing file too,
      // so a token created by an older/looser path can't stay group/world-readable.
      await fs.chmod(TOKEN_FILE, 0o600).catch(() => {});
      return existing;
    }
  } catch {
    // fall through and create
  }
  const token = randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  // 'wx' avoids racing two first requests into overwriting each other's token.
  try {
    await fs.writeFile(TOKEN_FILE, token, { encoding: "utf-8", mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Lost the race — use the token the other request just wrote.
    return (await fs.readFile(TOKEN_FILE, "utf-8")).trim();
  }
  return token;
}

function tokenMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Returns a 401 Response when unauthorized, null when the caller may proceed. */
export async function requireAgentAuth(request: Request): Promise<Response | null> {
  const expected = await getOrCreateToken();
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !tokenMatches(token, expected)) {
    return Response.json(
      { error: "Unauthorized — send Authorization: Bearer <.jarvis/agent-token>" },
      { status: 401 },
    );
  }
  return null;
}

function resolveRoot(raw: string | undefined): string {
  if (!raw || raw.trim() === "") return process.cwd();
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(process.cwd(), raw);
}

/** Status payload: everything useful, nothing huge (no transcript/snapshots). */
function publicTask(
  t: AgentTaskRecord,
): Omit<AgentTaskRecord, "transcript" | "snapshots"> & { snapshotFiles: string[] } {
  const copy = { ...t } as Record<string, unknown>;
  delete copy["transcript"];
  delete copy["snapshots"];
  return {
    ...(copy as unknown as Omit<AgentTaskRecord, "transcript" | "snapshots">),
    snapshotFiles: Object.keys(t.snapshots),
  };
}

/** Review diffs: snapshot → current content per changed file. */
async function buildDiffs(
  t: AgentTaskRecord,
): Promise<Record<string, { created: boolean; diff: string }>> {
  const out: Record<string, { created: boolean; diff: string }> = {};
  for (const rel of t.changedFiles.slice(0, 20)) {
    const snap = t.snapshots[rel];
    try {
      const abs = await resolveWorkspacePath({ root: t.repoRoot }, rel, "read");
      const current = await fs.readFile(abs, "utf-8");
      if (snap === null || snap === undefined) {
        out[rel] = { created: true, diff: `(new file)\n${current.slice(0, 8000)}` };
      } else {
        out[rel] = { created: false, diff: simpleDiff(snap, current) };
      }
    } catch (err) {
      out[rel] = {
        created: false,
        diff: `diff unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return out;
}

const PostBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    task: z.string().min(3).max(4000),
    repoRoot: z.string().optional(),
    maxIterations: z.number().int().min(3).max(40).optional(),
  }),
  z.object({ action: z.literal("cancel"), taskId: z.string().min(1) }),
  z.object({
    action: z.literal("approve"),
    taskId: z.string().min(1),
    approved: z.boolean(),
  }),
  z.object({
    action: z.literal("resume"),
    taskId: z.string().min(1),
    repoRoot: z.string().optional(),
  }),
  z.object({
    action: z.literal("revert"),
    taskId: z.string().min(1),
    repoRoot: z.string().optional(),
  }),
  z.object({
    action: z.literal("memory_update"),
    taskId: z.string().optional(),
    repoRoot: z.string().optional(),
    id: z.string().min(1),
    content: z.string().optional(),
    kind: z
      .enum([
        "architecture",
        "decision",
        "convention",
        "bug",
        "fix",
        "failed_approach",
        "task_status",
        "note",
      ])
      .optional(),
  }),
  z.object({
    action: z.literal("memory_delete"),
    repoRoot: z.string().optional(),
    id: z.string().min(1),
  }),
]);

function isBusy(err: unknown): err is Error & { code: "AGENT_BUSY" } {
  return err instanceof Error && (err as { code?: string }).code === "AGENT_BUSY";
}

export const Route = createFileRoute("/api/agent")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAgentAuth(request);
        if (auth) return auth;

        const url = new URL(request.url);
        const root = resolveRoot(url.searchParams.get("repoRoot") ?? undefined);

        try {
          if (url.searchParams.get("memory") === "1") {
            await createWorkspace(root);
            const entries = await listMemory(root);
            return Response.json({ repoRoot: root, entries });
          }

          if (url.searchParams.get("list") === "1") {
            const tasks = await listTasks(root);
            const active = await findActiveTask(root);
            return Response.json({
              repoRoot: root,
              activeTaskId: active?.id ?? null,
              tasks: tasks.slice(0, 20).map(publicTask),
            });
          }

          const taskId = url.searchParams.get("taskId");
          if (taskId) {
            const task = await loadTask(root, taskId);
            if (!task) {
              return Response.json({ error: `Task not found: ${taskId}` }, { status: 404 });
            }
            const snapshotPath = url.searchParams.get("snapshot");
            if (snapshotPath !== null) {
              // Only files the task itself changed — never an arbitrary read.
              if (!task.changedFiles.includes(snapshotPath)) {
                return Response.json(
                  { error: `Not a changed file of this task: ${snapshotPath}` },
                  { status: 404 },
                );
              }
              const before = task.snapshots[snapshotPath];
              return Response.json({
                path: snapshotPath,
                before: before === undefined ? null : before,
              });
            }
            return Response.json({
              task: publicTask(task),
              diffs: await buildDiffs(task),
            });
          }

          const active = await findActiveTask(root);
          if (!active) {
            const recent = (await listTasks(root)).slice(0, 5);
            return Response.json({
              active: null,
              recent: recent.map(publicTask),
            });
          }
          return Response.json({
            task: publicTask(active),
            diffs: await buildDiffs(active),
          });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      },

      POST: async ({ request }) => {
        const auth = await requireAgentAuth(request);
        if (auth) return auth;

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const parsed = PostBody.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: "Invalid request", issues: parsed.error.issues },
            { status: 400 },
          );
        }
        const input = parsed.data;

        try {
          switch (input.action) {
            case "start": {
              const root = resolveRoot(input.repoRoot);
              try {
                const { record } = await startCodingAgent({
                  repoRoot: root,
                  title: input.task,
                  ...(input.maxIterations ? { maxIterations: input.maxIterations } : {}),
                });
                return Response.json(
                  { started: true, taskId: record.id, phase: record.phase },
                  { status: 201 },
                );
              } catch (err) {
                if (isBusy(err)) {
                  return Response.json({ error: err.message, busy: true }, { status: 409 });
                }
                throw err;
              }
            }

            case "cancel": {
              const cancelled = cancelAgentTask(input.taskId);
              return Response.json({ cancelled });
            }

            case "approve": {
              const resolved = resolveAgentApproval(input.taskId, input.approved);
              if (!resolved) {
                return Response.json(
                  { error: "No pending approval for this task" },
                  { status: 404 },
                );
              }
              return Response.json({ resolved, approved: input.approved });
            }

            case "resume": {
              const root = resolveRoot(input.repoRoot);
              try {
                const { record } = await resumeAgent(root, input.taskId);
                return Response.json({ resumed: true, taskId: record.id });
              } catch (err) {
                if (isBusy(err)) {
                  return Response.json({ error: err.message, busy: true }, { status: 409 });
                }
                throw err;
              }
            }

            case "revert": {
              const root = resolveRoot(input.repoRoot);
              const task = await loadTask(root, input.taskId);
              if (!task) {
                return Response.json({ error: `Task not found: ${input.taskId}` }, { status: 404 });
              }
              const active = await findActiveTask(root);
              if (active && active.id === task.id) {
                return Response.json(
                  { error: "Task is still running — cancel it before reverting" },
                  { status: 409 },
                );
              }
              const results: Record<string, string> = {};
              for (const rel of task.changedFiles) {
                try {
                  const abs = await resolveWorkspacePath({ root: task.repoRoot }, rel, "write");
                  const snap = task.snapshots[rel];
                  if (snap === null || snap === undefined) {
                    await fs.rm(abs, { force: true });
                    results[rel] = "deleted (file was created by the task)";
                  } else {
                    await fs.mkdir(path.dirname(abs), { recursive: true });
                    await fs.writeFile(abs, snap, "utf-8");
                    results[rel] = "restored";
                  }
                } catch (err) {
                  results[rel] = `error: ${err instanceof Error ? err.message : String(err)}`;
                }
              }
              task.events.push({
                at: Date.now(),
                phase: task.phase,
                kind: "note",
                text: "Reverted task changes at user request",
                detail: JSON.stringify(results).slice(0, 1000),
              });
              await saveTask(task);
              return Response.json({ reverted: results });
            }

            case "memory_update": {
              const root = resolveRoot(input.repoRoot);
              const entry = await updateMemoryEntry(root, input.id, {
                ...(input.content !== undefined ? { content: input.content } : {}),
                ...(input.kind ? { kind: input.kind } : {}),
              });
              return Response.json({ entry });
            }

            case "memory_delete": {
              const root = resolveRoot(input.repoRoot);
              await deleteMemoryEntry(root, input.id);
              return Response.json({ deleted: input.id });
            }
          }
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
        return Response.json({ error: "Unhandled action" }, { status: 400 });
      },
    },
  },
});
