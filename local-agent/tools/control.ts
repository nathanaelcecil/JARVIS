/**
 * Hands v2 — computer CONTROL (the mutating half of Hands).
 *
 * This module spawns `native/jarvis-hands-control/bin/jarvis-hands-control`
 * with an argv array via `execFile` (never a shell), which is a SEPARATE
 * binary from the read-only observer (`./hands.ts`):
 *
 *   • `jarvis-hands`          can only look. Its test asserts it contains no
 *                             control API at all.
 *   • `jarvis-hands-control`  can click, type, press keys, scroll, drag, walk
 *                             menus and move windows.
 *
 * Because macOS grants Accessibility per binary, the two permissions are
 * independent: the user can revoke control and still let JARVIS see the screen.
 *
 * Every tool here is `confirm` tier: the bearer secret alone can never satisfy
 * them — a call needs an approval token minted after a real user approval (see
 * src/lib/approval-token.ts and tool-authorization.ts).
 *
 * The helper itself refuses to guess: a label that matches several controls
 * returns `ambiguous` with candidates instead of clicking one.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { handsReadWindow } from "./hands";

/** Override the control helper location (tests substitute a fake). */
export const CONTROL_BIN_ENV = "JARVIS_HANDS_CONTROL_BIN";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_STDOUT_BYTES = 512 * 1024;
/** How long to let the UI settle before a verification read. */
const SETTLE_MS = 260;
const VERIFY_CHARS = 1500;

export interface ControlRunResult {
  status: number;
  stdout: string;
  stderr: string;
  parsed: Record<string, unknown> | null;
}

export function controlBinPath(env: Record<string, string | undefined> = process.env): string {
  const override = env[CONTROL_BIN_ENV];
  if (override && override.trim()) return resolve(override.trim());
  let here: string;
  try {
    here = fileURLToPath(new URL("../", import.meta.url)); // local-agent/
  } catch {
    here = join(process.cwd(), "local-agent");
  }
  return join(here, "..", "native", "jarvis-hands-control", "bin", "jarvis-hands-control");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)} …[truncated]`;
}

/** Run the control helper: argv only, no shell, no interpolation. */
export function runControl(
  args: string[],
  options: { timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<ControlRunResult> {
  const bin = controlBinPath(options.env);
  return new Promise((resolvePromise) => {
    execFile(
      bin,
      args,
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_STDOUT_BYTES,
        windowsHide: true,
        encoding: "utf8",
        shell: false,
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : "";
        const err = typeof stderr === "string" ? stderr : "";
        const status =
          error && typeof (error as NodeJS.ErrnoException).code === "number"
            ? ((error as NodeJS.ErrnoException).code as unknown as number)
            : error
              ? 1
              : 0;
        let parsed: Record<string, unknown> | null = null;
        try {
          const value: unknown = JSON.parse(out.trim());
          if (value && typeof value === "object" && !Array.isArray(value)) {
            parsed = value as Record<string, unknown>;
          }
        } catch {
          parsed = null;
        }
        resolvePromise({ status, stdout: out, stderr: err, parsed });
      },
    );
  });
}

function helperMissing(): Record<string, unknown> {
  return {
    ok: false,
    code: "helper_missing",
    error:
      "the control helper is not built: native/jarvis-hands-control/bin/jarvis-hands-control is missing. Build it with native/jarvis-hands-control/build.command.",
  };
}

function log(tool: string, detail: string): void {
  // Metadata only: never the typed text, never window contents.
  console.log(`[Control] ${tool} ${detail}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface CallOptions {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Read the target window back after acting and include it as `after`. */
  verifyPid?: number;
  verifyWindowIndex?: number;
}

async function callControl(
  tool: string,
  args: string[],
  options: CallOptions = {},
): Promise<unknown> {
  const bin = controlBinPath(options.env);
  if (!existsSync(bin)) {
    log(tool, `→ helper_missing (${bin})`);
    return helperMissing();
  }

  const run = await runControl(args, options);
  if (!run.parsed) {
    log(tool, `→ bad_output status=${run.status}`);
    return {
      ok: false,
      code: "helper_bad_output",
      error: "the control helper did not return valid JSON",
      status: run.status,
      stdout: truncate(run.stdout, 1200),
      stderr: truncate(run.stderr, 800),
    };
  }

  const parsed = run.parsed;
  log(
    tool,
    `→ ok=${String(parsed["ok"])}` +
      (typeof parsed["code"] === "string" ? ` code=${parsed["code"]}` : ""),
  );

  if (options.verifyPid && parsed["ok"] === true) {
    await sleep(SETTLE_MS);
    try {
      const after = await handsReadWindow({
        pid: options.verifyPid,
        ...(options.verifyWindowIndex !== undefined
          ? { windowIndex: options.verifyWindowIndex }
          : {}),
      });
      const record = after as Record<string, unknown>;
      const text = typeof record["text"] === "string" ? record["text"] : "";
      return {
        ...parsed,
        // The window is third-party data even right after an action.
        after: { untrusted: true, text: truncate(text, VERIFY_CHARS) },
      };
    } catch {
      return { ...parsed, after: null };
    }
  }

  return parsed;
}

// ── Tools ─────────────────────────────────────────────────────────────────

/** Click a named control, or an exact screen point. */
export function controlClick(args: {
  pid: number;
  label?: string;
  role?: string;
  near?: string;
  x?: number;
  y?: number;
  double?: boolean;
  right?: boolean;
  windowIndex?: number;
  global?: boolean;
  verify?: boolean;
}): Promise<unknown> {
  const argv = ["click", "--pid", String(args.pid)];
  if (args.label !== undefined) argv.push("--label", args.label);
  if (args.role !== undefined) argv.push("--role", args.role);
  if (args.near !== undefined) argv.push("--near", args.near);
  if (args.x !== undefined) argv.push("--x", String(args.x));
  if (args.y !== undefined) argv.push("--y", String(args.y));
  if (args.double) argv.push("--double");
  if (args.right) argv.push("--right");
  if (args.windowIndex !== undefined) argv.push("--window-index", String(args.windowIndex));
  if (args.global) argv.push("--global");
  return callControl("control_click", argv, {
    ...(args.verify ? { verifyPid: args.pid, verifyWindowIndex: args.windowIndex } : {}),
  });
}

/** Type text, optionally into a named field; optionally press Return. */
export function controlType(args: {
  text: string;
  pid?: number;
  label?: string;
  role?: string;
  windowIndex?: number;
  submit?: boolean;
  global?: boolean;
  verify?: boolean;
}): Promise<unknown> {
  const argv = ["type", "--text", args.text];
  if (args.pid !== undefined) argv.push("--pid", String(args.pid));
  if (args.label !== undefined) argv.push("--label", args.label);
  if (args.role !== undefined) argv.push("--role", args.role);
  if (args.windowIndex !== undefined) argv.push("--window-index", String(args.windowIndex));
  if (args.submit) argv.push("--submit");
  if (args.global) argv.push("--global");
  return callControl("control_type", argv, {
    ...(args.verify && args.pid !== undefined
      ? { verifyPid: args.pid, verifyWindowIndex: args.windowIndex }
      : {}),
  });
}

/** Press a key chord such as "cmd+shift+t", optionally to a specific app. */
export function controlKey(args: {
  combo: string;
  times?: number;
  pid?: number;
  global?: boolean;
  verify?: boolean;
}): Promise<unknown> {
  const argv = ["key", "--combo", args.combo];
  if (args.times !== undefined) argv.push("--times", String(args.times));
  if (args.pid !== undefined) argv.push("--pid", String(args.pid));
  if (args.global) argv.push("--global");
  return callControl("control_key", argv, {
    ...(args.verify && args.pid !== undefined ? { verifyPid: args.pid } : {}),
  });
}

/** Scroll the window under the pointer or at an explicit point. */
export function controlScroll(args: {
  dy?: number;
  dx?: number;
  pid?: number;
  x?: number;
  y?: number;
  global?: boolean;
}): Promise<unknown> {
  const argv = ["scroll"];
  if (args.dy !== undefined) argv.push("--dy", String(args.dy));
  if (args.dx !== undefined) argv.push("--dx", String(args.dx));
  if (args.pid !== undefined) argv.push("--pid", String(args.pid));
  if (args.x !== undefined) argv.push("--x", String(args.x));
  if (args.y !== undefined) argv.push("--y", String(args.y));
  if (args.global) argv.push("--global");
  return callControl("control_scroll", argv);
}

/** Drag from one screen point to another. */
export function controlDrag(args: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  pid?: number;
  global?: boolean;
}): Promise<unknown> {
  const argv = [
    "drag",
    "--from",
    `${args.from.x},${args.from.y}`,
    "--to",
    `${args.to.x},${args.to.y}`,
  ];
  if (args.pid !== undefined) argv.push("--pid", String(args.pid));
  if (args.global) argv.push("--global");
  return callControl("control_drag", argv);
}

/** Activate a menu path such as "File>Export>PDF". */
export function controlMenu(args: {
  pid: number;
  path: string;
  verify?: boolean;
}): Promise<unknown> {
  return callControl("control_menu", ["menu", "--pid", String(args.pid), "--path", args.path], {
    ...(args.verify ? { verifyPid: args.pid } : {}),
  });
}

/** Move/resize a window: left | right | full | fullscreen | center. */
export function controlPlace(args: {
  pid: number;
  where: "left" | "right" | "full" | "fullscreen" | "center";
  screen?: number;
  windowIndex?: number;
}): Promise<unknown> {
  const argv = ["place", "--pid", String(args.pid), "--where", args.where];
  if (args.screen !== undefined) argv.push("--screen", String(args.screen));
  if (args.windowIndex !== undefined) argv.push("--window-index", String(args.windowIndex));
  return callControl("control_place", argv);
}

/** Bring an app (optionally a window whose title has these words) to front. */
export function controlFocus(args: { pid: number; title?: string }): Promise<unknown> {
  const argv = ["focus", "--pid", String(args.pid)];
  if (args.title !== undefined) argv.push("--title", args.title);
  return callControl("control_focus", argv);
}

/** Addressable controls in a window — the model's map for labelled clicks. */
export function controlMap(args: {
  pid: number;
  windowIndex?: number;
}): Promise<unknown> {
  const argv = ["map", "--pid", String(args.pid)];
  if (args.windowIndex !== undefined) argv.push("--window-index", String(args.windowIndex));
  return callControl("control_map", argv);
}

/** Permission report for the control helper (Accessibility / Screen Recording). */
export function controlStatus(): Promise<unknown> {
  return callControl("control_status", ["permissions"]);
}
