/**
 * Unit tests for task-registry.ts — task lifecycle
 */
import { describe, it, expect, beforeEach } from "vitest";
import { registerTask, updateTaskStatus, cancelTask, cancelAllTasks, getRunningTasks, getTaskSummary, cleanupOldTasks } from "./task-registry";

describe("task lifecycle", () => {
  it("registers a new task with QUEUED status", () => {
    const task = registerTask({ message: "test message", route: "FAST", model: "glm-4.7-flash" });
    expect(task.status).toBe("QUEUED");
    expect(task.message).toBe("test message");
    expect(task.route).toBe("FAST");
    expect(task.abortController).toBeInstanceOf(AbortController);
  });

  it("updates task status", () => {
    const task = registerTask({ message: "test", route: "SMART", model: "glm-4.7" });
    updateTaskStatus(task.id, "RUNNING");
    expect(task.status).toBe("RUNNING");
    expect(task.completedAt).toBeUndefined();
  });

  it("sets completedAt on terminal states", () => {
    const task = registerTask({ message: "test", route: "FAST", model: "glm-4.7-flash" });
    updateTaskStatus(task.id, "COMPLETED");
    expect(task.status).toBe("COMPLETED");
    expect(task.completedAt).toBeDefined();
  });

  it("cancels a running task", () => {
    const task = registerTask({ message: "test", route: "FAST", model: "glm-4.7-flash" });
    updateTaskStatus(task.id, "RUNNING");
    const result = cancelTask(task.id);
    expect(result).toBe(true);
    expect(task.status).toBe("CANCELLED");
    expect(task.abortController.signal.aborted).toBe(true);
  });

  it("does not cancel an already-completed task", () => {
    const task = registerTask({ message: "test", route: "FAST", model: "glm-4.7-flash" });
    updateTaskStatus(task.id, "COMPLETED");
    const result = cancelTask(task.id);
    expect(result).toBe(false);
  });

  it("cancels all running tasks", () => {
    const before = getRunningTasks().length;
    const t1 = registerTask({ message: "test1", route: "FAST", model: "glm-4.7-flash" });
    const t2 = registerTask({ message: "test2", route: "SMART", model: "glm-4.7" });
    updateTaskStatus(t1.id, "RUNNING");
    updateTaskStatus(t2.id, "RUNNING");
    const count = cancelAllTasks();
    expect(count).toBeGreaterThanOrEqual(2);
    expect(t1.status).toBe("CANCELLED");
    expect(t2.status).toBe("CANCELLED");
  });

  it("returns running tasks", () => {
    const t1 = registerTask({ message: "test1", route: "FAST", model: "glm-4.7-flash" });
    const t2 = registerTask({ message: "test2", route: "SMART", model: "glm-4.7" });
    updateTaskStatus(t1.id, "RUNNING");
    updateTaskStatus(t2.id, "COMPLETED");
    const running = getRunningTasks();
    expect(running).toHaveLength(1);
    expect(running[0]?.id).toBe(t1.id);
  });

  it("generates a task summary", () => {
    const summary = getTaskSummary();
    expect(typeof summary).toBe("string");
  });
});
