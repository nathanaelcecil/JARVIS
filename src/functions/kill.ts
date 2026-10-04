import { createServerFn } from "@tanstack/react-start";
import { activateKillSwitch, resetKillSwitch } from "../lib/guardrails";
import { cancelTask as registryCancelTask, cancelAllTasks } from "../lib/ai/task-registry";

export const killSwitch = createServerFn({ method: "POST" })
  .validator(
    (data: unknown) => data as { action: "activate" | "reset" | "cancel"; taskId?: string }
  )
  .handler(async ({ data }) => {
    if (data.action === "activate") {
      activateKillSwitch();
      return { status: "active", message: "Kill switch activated. All operations halted." };
    } else if (data.action === "cancel" && data.taskId) {
      const cancelled = registryCancelTask(data.taskId);
      return {
        status: cancelled ? "cancelled" : "not_found",
        message: cancelled
          ? `Task ${data.taskId.slice(0, 8)} cancelled.`
          : `Task ${data.taskId.slice(0, 8)} not found or already finished.`,
      };
    } else {
      resetKillSwitch();
      cancelAllTasks();
      return { status: "reset", message: "Kill switch reset. Operations resumed." };
    }
  });
