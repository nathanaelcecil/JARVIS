/**
 * Per-request task registry.
 * Each in-flight request gets its own AbortController, status, and metadata.
 * Replaces the single global AbortController that existed before.
 */

export type TaskStatus =
  | "QUEUED"
  | "RUNNING"
  | "CANCELLING"
  | "CANCELLED"
  | "COMPLETED"
  | "FAILED";

export interface TaskEntry {
  id: string;
  status: TaskStatus;
  abortController: AbortController;
  message: string;
  route: string;
  model: string;
  createdAt: number;
  completedAt?: number;
}

// ── In-memory store (server-side only) ──

const tasks = new Map<string, TaskEntry>();

export function registerTask(params: {
  message: string;
  route: string;
  model: string;
}): TaskEntry {
  const id = crypto.randomUUID();
  const entry: TaskEntry = {
    id,
    status: "QUEUED",
    abortController: new AbortController(),
    message: params.message.slice(0, 100),
    route: params.route,
    model: params.model,
    createdAt: Date.now(),
  };
  tasks.set(id, entry);
  return entry;
}

export function updateTaskStatus(id: string, status: TaskStatus): void {
  const task = tasks.get(id);
  if (task) {
    task.status = status;
    if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") {
      task.completedAt = Date.now();
    }
  }
}

export function cancelTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) return false;
  if (task.status === "COMPLETED" || task.status === "FAILED" || task.status === "CANCELLED") {
    return false;
  }
  task.status = "CANCELLING";
  task.abortController.abort();
  task.status = "CANCELLED";
  task.completedAt = Date.now();
  return true;
}

export function cancelAllTasks(): number {
  let count = 0;
  for (const [id, task] of tasks) {
    if (task.status === "QUEUED" || task.status === "RUNNING") {
      task.status = "CANCELLING";
      task.abortController.abort();
      task.status = "CANCELLED";
      task.completedAt = Date.now();
      count++;
    }
  }
  return count;
}

export function getTask(id: string): TaskEntry | undefined {
  return tasks.get(id);
}

export function getRunningTasks(): TaskEntry[] {
  const running: TaskEntry[] = [];
  for (const task of tasks.values()) {
    if (task.status === "QUEUED" || task.status === "RUNNING") {
      running.push(task);
    }
  }
  return running;
}

/** Get task summary for the "what are you doing?" response */
export function getTaskSummary(): string {
  const running = getRunningTasks();
  if (running.length === 0) return "No active tasks at the moment, sir.";

  return running
    .map((t) => {
      const elapsed = ((Date.now() - t.createdAt) / 1000).toFixed(0);
      return `Task ${t.id.slice(0, 8)}: ${t.status} — "${t.message}" (${t.route} route, ${elapsed}s elapsed)`;
    })
    .join("\n");
}

/** Clean up completed tasks older than 5 minutes */
export function cleanupOldTasks(): void {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, task] of tasks) {
    if (
      (task.status === "COMPLETED" || task.status === "FAILED" || task.status === "CANCELLED") &&
      task.completedAt &&
      task.completedAt < cutoff
    ) {
      tasks.delete(id);
    }
  }
}
