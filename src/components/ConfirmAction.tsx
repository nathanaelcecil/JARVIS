/**
 * ConfirmAction — amber-themed approval prompt for confirm-tier tool execution.
 */

import { useState } from "react";

interface ConfirmActionProps {
  tool: string;
  args: Record<string, unknown>;
  onApprove: () => void;
  onDeny: () => void;
}

export function ConfirmAction({ tool, args, onApprove, onDeny }: ConfirmActionProps) {
  const [decided, setDecided] = useState(false);

  const handleApprove = () => { setDecided(true); onApprove(); };
  const handleDeny = () => { setDecided(true); onDeny(); };

  if (decided) return null;

  const toolNames: Record<string, string> = {
    open_app: "Open Application", quit_app: "Quit Application",
    set_volume: "Set Volume", set_brightness: "Set Brightness",
    open_in_finder: "Open in Finder", run_command: "Run Command",
    browser_click: "Click Element", browser_type: "Type in Field",
    browser_fill_form: "Fill Form", browser_download: "Download File",
    gh_create_branch: "Create Branch", gh_create_file: "Create/Update File",
    gh_create_issue: "Create Issue", gh_create_pr: "Create Pull Request",
    gh_create_comment: "Add Comment",
  };

  const friendlyName = toolNames[tool] ?? tool.replace(/_/g, " ");

  const formatArgs = (a: Record<string, unknown>): string => {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(a)) {
      if (key === "signal") continue;
      const val = typeof value === "string" ? value : JSON.stringify(value);
      parts.push(key + ": " + val);
    }
    return parts.join(", ");
  };

  return (
    <div className="border border-hud-edge/40 bg-hud-panel/60 rounded-lg p-3 my-2 max-w-sm">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-hud-amber text-sm font-mono">CONFIRM</span>
        <span className="text-white/90 text-sm font-medium">{friendlyName}</span>
      </div>
      <pre className="text-white/60 text-xs font-mono whitespace-pre-wrap mb-3">
        {formatArgs(args)}
      </pre>
      <div className="flex gap-2">
        <button onClick={handleApprove} className="flex-1 px-3 py-1.5 bg-hud-amber/20 hover:bg-hud-amber/30 text-hud-amber border border-hud-amber/40 rounded text-sm font-medium transition-colors">Approve</button>
        <button onClick={handleDeny} className="flex-1 px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white/60 border border-white/20 rounded text-sm font-medium transition-colors">Deny</button>
      </div>
    </div>
  );
}
