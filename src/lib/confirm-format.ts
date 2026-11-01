/**
 * Formatting for the approval card.
 *
 * The user must be able to read EXACTLY what they are approving. A shell
 * command is therefore rendered as one untruncated block with whitespace
 * preserved — never joined onto a single line where a trailing `; rm -rf ...`
 * could scroll out of sight.
 */

const SHELL_COMMAND_TOOLS = new Set(["run_command", "run_background"]);

export interface FormattedConfirmArg {
  key: string;
  value: string;
}

export interface FormattedConfirmArgs {
  /** Full, untruncated shell command, when the tool takes one. */
  command: string | null;
  /** Remaining arguments, values rendered for display. */
  fields: FormattedConfirmArg[];
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatConfirmArgs(
  tool: string,
  args: Record<string, unknown>,
): FormattedConfirmArgs {
  let command: string | null = null;
  const fields: FormattedConfirmArg[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (key === "signal") continue;
    if (SHELL_COMMAND_TOOLS.has(tool) && key === "command" && typeof value === "string") {
      command = value;
      continue;
    }
    fields.push({ key, value: renderValue(value) });
  }

  return { command, fields };
}
