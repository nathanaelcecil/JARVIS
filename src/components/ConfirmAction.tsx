/**
 * ConfirmAction — amber-themed approval prompt for confirm-tier tool execution.
 */

import { useState } from "react";
import { formatConfirmArgs } from "../lib/confirm-format";

interface ConfirmActionProps {
  tool: string;
  args: Record<string, unknown>;
  onApprove: () => void;
  onDeny: () => void;
  /**
   * Offered only when the server sent a task id: "always allow for this task"
   * skips the prompt for the same tool until this chat turn ends.
   */
  onApproveForTask?: (() => void) | undefined;
}

export function ConfirmAction({
  tool,
  args,
  onApprove,
  onDeny,
  onApproveForTask,
}: ConfirmActionProps) {
  const [decided, setDecided] = useState(false);

  const handleApprove = () => {
    setDecided(true);
    onApprove();
  };
  const handleApproveForTask = () => {
    setDecided(true);
    onApproveForTask?.();
  };
  const handleDeny = () => {
    setDecided(true);
    onDeny();
  };

  if (decided) return null;

  const toolNames: Record<string, string> = {
    open_app: "Open Application",
    quit_app: "Quit Application",
    set_volume: "Set Volume",
    set_brightness: "Set Brightness",
    open_in_finder: "Open in Finder",
    run_command: "Run Command",
    browser_click: "Click Element",
    browser_type: "Type in Field",
    browser_fill_form: "Fill Form",
    browser_download: "Download File",
    control_click: "Click on Screen",
    control_type: "Type on Screen",
    control_key: "Press Keys",
    control_scroll: "Scroll Window",
    control_drag: "Drag on Screen",
    control_menu: "Use Menu",
    control_place: "Move Window",
    control_focus: "Bring App to Front",
    gh_create_branch: "Create Branch",
    gh_create_file: "Create/Update File",
    gh_create_issue: "Create Issue",
    gh_create_pr: "Create Pull Request",
    gh_create_comment: "Add Comment",
  };

  const friendlyName = toolNames[tool] ?? tool.replace(/_/g, " ");

  // The command is shown in its own block: full, untruncated, whitespace
  // preserved. Everything else goes one argument per line.
  const { command, fields } = formatConfirmArgs(tool, args);

  return (
    <div className="border border-hud-edge/40 bg-hud-panel/60 rounded-lg p-3 my-2 max-w-sm">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-hud-amber text-sm font-mono">CONFIRM</span>
        <span className="text-white/90 text-sm font-medium">{friendlyName}</span>
      </div>
      {command !== null ? (
        <div className="mb-3">
          <pre
            data-testid="confirm-command"
            className="text-white/80 text-xs font-mono whitespace-pre overflow-x-auto bg-black/30 border border-white/10 rounded p-2 max-h-64 overflow-y-auto"
          >
            {command}
          </pre>
          {fields.length > 0 && (
            <pre className="text-white/50 text-xs font-mono whitespace-pre-wrap mt-2">
              {fields.map((field) => `${field.key}: ${field.value}`).join("\n")}
            </pre>
          )}
        </div>
      ) : (
        <pre className="text-white/60 text-xs font-mono whitespace-pre-wrap mb-3">
          {fields.map((field) => `${field.key}: ${field.value}`).join("\n")}
        </pre>
      )}
      <div className="flex gap-2">
        <button
          onClick={handleApprove}
          className="flex-1 px-3 py-1.5 bg-hud-amber/20 hover:bg-hud-amber/30 text-hud-amber border border-hud-amber/40 rounded text-sm font-medium transition-colors"
        >
          Approve
        </button>
        <button
          onClick={handleDeny}
          className="flex-1 px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white/60 border border-white/20 rounded text-sm font-medium transition-colors"
        >
          Deny
        </button>
      </div>
      {onApproveForTask && (
        <button
          onClick={handleApproveForTask}
          data-testid="confirm-allow-task"
          className="mt-2 w-full px-3 py-1.5 bg-transparent hover:bg-white/5 text-white/50 hover:text-white/70 border border-white/10 rounded text-xs font-mono transition-colors"
        >
          Always allow “{friendlyName}” for this task
        </button>
      )}
    </div>
  );
}
