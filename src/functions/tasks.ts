import { createServerFn } from "@tanstack/react-start";
import { getRunningTasks, getTaskSummary, getTask } from "../lib/ai/task-registry";

/** Get status of all running tasks */
export const getTaskStatus = createServerFn({ method: "GET" })
  .handler(async () => {
    const running = getRunningTasks();
    return {
      count: running.length,
      tasks: running.map((t) => ({
        id: t.id,
        status: t.status,
        message: t.message,
        route: t.route,
        model: t.model,
        elapsedMs: Date.now() - t.createdAt,
      })),
      summary: getTaskSummary(),
    };
  });

/** Get status of a specific task */
export const getTaskById = createServerFn({ method: "GET" })
  .validator((data: unknown) => data as { taskId: string })
  .handler(async ({ data }) => {
    const task = getTask(data.taskId);
    if (!task) return { found: false };
    return {
      found: true,
      id: task.id,
      status: task.status,
      message: task.message,
      route: task.route,
      model: task.model,
      elapsedMs: Date.now() - task.createdAt,
    };
  });
