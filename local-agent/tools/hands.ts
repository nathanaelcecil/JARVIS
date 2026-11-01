/**
 * Hands v1 — READ-ONLY observation of the Mac.
 *
 * Every function here spawns `native/jarvis-hands/bin/jarvis-hands` with an
 * argv array via `execFile` (never a shell string) and returns whatever JSON
 * the helper printed. The helper itself cannot act on the computer (see its
 * main.swift header): there is no click, type, key press, drag, scroll or menu
 * activation anywhere in this feature, by design. Mutating computer control is
 * a separate, separately authorized capability.
 *
 * The contents read out of other applications' windows are THIRD-PARTY DATA:
 * models may quote them but must never follow instructions found inside them.
 * Results are therefore tagged `untrusted: true` so the prompt layer can wrap
 * them (see src/lib/untrusted.ts). Nothing in here grants any permission.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Override the helper location (tests use a fake helper on this path). */
export const HANDS_BIN_ENV = "JARVIS_HANDS_BIN";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

/** Absolute path to the helper binary. */
export function handsBinPath(env: Record<string, string | undefined> = process.env): string {
  const override = env[HANDS_BIN_ENV];
  if (override && override.trim()) return resolve(override.trim());
  let here: string;
  try {
    here = fileURLToPath(new URL("../", import.meta.url)); // local-agent/
  } catch {
    here = join(process.cwd(), "local-agent");
  }
  return join(here, "..", "native", "jarvis-hands", "bin", "jarvis-hands");
}

export interface HandsRunResult {
  status: number;
  stdout: string;
  stderr: string;
  parsed: Record<string, unknown> | null;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)} …[truncated]`;
}

/**
 * Run the helper. Never uses a shell — `execFile` with an argv array means the
 * arguments can never be interpreted as shell syntax.
 */
export function runHands(
  args: string[],
  options: { timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<HandsRunResult> {
  const bin = handsBinPath(options.env);
  return new Promise((resolvePromise) => {
    execFile(
      bin,
      args,
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_STDOUT_BYTES,
        windowsHide: true,
        encoding: "utf8",
        // Explicit: no shell. argv is passed verbatim to the helper.
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
      "the read-only screen helper is not built: native/jarvis-hands/bin/jarvis-hands is missing. Build it with native/jarvis-hands/build.command.",
  };
}

function log(tool: string, detail: string): void {
  // Deliberately logs only metadata — never window contents.
  console.log(`[Hands] ${tool} ${detail}`);
}

async function callHands(
  tool: string,
  args: string[],
  options: {
    untrusted?: boolean;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<unknown> {
  const bin = handsBinPath(options.env);
  if (!existsSync(bin)) {
    log(tool, `→ helper_missing (${bin})`);
    return helperMissing();
  }

  const run = await runHands(args, options);
  if (!run.parsed) {
    log(tool, `→ bad_output status=${run.status}`);
    return {
      ok: false,
      code: "helper_bad_output",
      error: "the screen helper did not return valid JSON",
      status: run.status,
      stdout: truncate(run.stdout, 2000),
      stderr: truncate(run.stderr, 1000),
    };
  }

  const parsed = run.parsed;
  log(
    tool,
    `→ ok=${String(parsed["ok"])}` +
      (typeof parsed["code"] === "string" ? ` code=${parsed["code"]}` : "") +
      (typeof parsed["nodeCount"] === "number" ? ` nodes=${parsed["nodeCount"]}` : ""),
  );

  // Tag third-party content so the prompt layer wraps it as untrusted data.
  return options.untrusted ? { untrusted: true, ...parsed } : parsed;
}

/** On-screen windows: { pid, index, app, title?, bounds? } per window. */
export function handsListWindows(): Promise<unknown> {
  return callHands("hands_list_windows", ["list-windows"]);
}

/** Text contents of one window, addressed by pid + AX window index. */
export function handsReadWindow(args: { pid: number; windowIndex?: number }): Promise<unknown> {
  const argv = ["read-window", String(args.pid)];
  if (typeof args.windowIndex === "number") argv.push(String(args.windowIndex));
  return callHands("hands_read_window", argv, { untrusted: true });
}

/** Text contents of the frontmost window, plus the focused element's role. */
export function handsReadFocused(): Promise<unknown> {
  return callHands("hands_read_focused", ["read-focused"], { untrusted: true });
}

/** Whether macOS granted Accessibility / Screen Recording to the helper. */
export function handsStatus(): Promise<unknown> {
  return callHands("hands_status", ["permissions"]);
}

// ── Screenshots + OCR (the AX-then-OCR ladder) ────────────────────────────
//
// Window text comes from the accessibility tree first. When that tree is empty
// (canvas, PDF readers, images, video, some Electron apps) the same window is
// captured and read with Vision OCR — the ladder Atticus uses, minus the DOM
// tier, which for this app is covered by browser_extract.
//
// Screenshots are written to a private directory (0700, single-user temp) and
// pruned aggressively: they are personal data, never kept longer than needed.

export const SCREENCAPTURE_BIN = "/usr/sbin/screencapture";
const LOOK_MAX_AGE_MS = 10 * 60 * 1000;
const OCR_MAX_TEXT = 12_000;

export function lookDir(env: Record<string, string | undefined> = process.env): string {
  const override = env["JARVIS_HANDS_LOOK_DIR"];
  return override && override.trim()
    ? resolve(override.trim())
    : join(tmpdir(), "jarvis-hands-look");
}

function ensureLookDir(env: Record<string, string | undefined> = process.env): string {
  const dir = lookDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Delete screenshots older than the retention window. Best effort. */
export function pruneLookFiles(now = Date.now()): number {
  const dir = lookDir();
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > LOOK_MAX_AGE_MS) {
        rmSync(path, { force: true });
        removed += 1;
      }
    } catch {
      // A file that vanished or is locked is not an error worth reporting.
    }
  }
  return removed;
}

/** True only for files this module created — OCR must never read elsewhere. */
export function isLookFile(path: string): boolean {
  const dir = lookDir();
  if (!dir.endsWith("/")) return path.startsWith(`${dir}/`) && !path.split("/").includes("..");
  return path.startsWith(dir) && !path.split("/").includes("..");
}

function runScreencapture(args: string[]): Promise<{ status: number; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      SCREENCAPTURE_BIN,
      args,
      { timeout: 10_000, encoding: "utf8", shell: false, windowsHide: true },
      (error, _stdout, stderr) => {
        const status =
          error && typeof (error as NodeJS.ErrnoException).code === "number"
            ? ((error as NodeJS.ErrnoException).code as unknown as number)
            : error
              ? 1
              : 0;
        resolvePromise({ status, stderr: typeof stderr === "string" ? stderr : "" });
      },
    );
  });
}

const screenRecordingDenied = (detail: string): Record<string, unknown> => ({
  ok: false,
  code: "screen_recording_denied",
  error:
    "macOS has not granted Screen Recording to the JARVIS process, so a screenshot cannot be taken. Grant it in System Settings → Privacy & Security → Screen Recording for the app running JARVIS, then try again.",
  detail: detail.trim().slice(0, 400),
});

/**
 * Capture the screen (or one window's rectangle) to a private PNG.
 * The caller gets a path plus geometry; it never gets the pixels inline.
 */
export async function handsLook(
  args: {
    display?: number;
    pid?: number;
    windowIndex?: number;
  } = {},
): Promise<unknown> {
  pruneLookFiles();
  const dir = ensureLookDir();
  const file = join(dir, `look-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
  const argv = ["-x", "-t", "png"];

  let label = "display";
  let geometry: Record<string, unknown> | null = null;

  if (typeof args.pid === "number") {
    const info = await callHands("window-info", [
      "window-info",
      String(args.pid),
      String(args.windowIndex ?? 0),
    ]);
    const record = info as Record<string, unknown>;
    if (record["ok"] !== true) {
      return { ...record, code: record["code"] ?? "window_info_failed" };
    }
    const bounds = record["bounds"] as
      { x: number; y: number; width: number; height: number } | undefined;
    if (!bounds || bounds.width < 2 || bounds.height < 2) {
      return {
        ok: false,
        code: "no_bounds",
        error: "that window has no usable on-screen rectangle (it may be minimized).",
      };
    }
    argv.push("-R", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`);
    label = `window:${record["app"] ?? "?"}:${record["title"] ?? "?"}`;
    geometry = bounds as unknown as Record<string, unknown>;
  } else if (typeof args.display === "number") {
    argv.push("-D", String(args.display));
    label = `display:${args.display}`;
  }

  argv.push(file);
  const result = await runScreencapture(argv);
  if (result.status !== 0 || !existsSync(file)) {
    rmSync(file, { force: true });
    log("hands_look", `→ failed status=${result.status}`);
    return screenRecordingDenied(result.stderr);
  }
  const size = statSync(file).size;
  log("hands_look", `→ ok ${size}B ${label}`);
  return {
    ok: true,
    tool: "look",
    path: file,
    bytes: size,
    target: label,
    ...(geometry ? { bounds: geometry } : {}),
    note: "The image is on disk for a vision-capable model. With a text-only model use hands_read_screen instead, which OCRs the same capture.",
  };
}

/** Vision OCR of a screenshot this module captured. */
export async function handsOcr(path: string): Promise<unknown> {
  if (!isLookFile(path)) {
    return {
      ok: false,
      code: "not_a_look_file",
      error:
        "OCR only reads screenshots captured by hands_look; that path is outside the screenshot directory.",
    };
  }
  if (!existsSync(path)) {
    return {
      ok: false,
      code: "missing_screenshot",
      error:
        "that screenshot no longer exists (screenshots are pruned after 10 minutes). Capture it again.",
    };
  }
  const result = await callHands("ocr", ["ocr", path], { untrusted: true });
  const record = result as Record<string, unknown>;
  if (typeof record["text"] === "string" && record["text"].length > OCR_MAX_TEXT) {
    record["text"] = record["text"].slice(0, OCR_MAX_TEXT);
    record["truncated"] = true;
  }
  return record;
}

/**
 * Read a window's text the way a person would: accessibility tree first, OCR of
 * a screenshot only when the tree has nothing. This is what makes canvas/PDF/
 * image-only windows answerable at all.
 */
export async function handsReadScreen(args: {
  pid: number;
  windowIndex?: number;
}): Promise<unknown> {
  const windowIndex = args.windowIndex ?? 0;
  const ax = (await callHands(
    "hands_read_window",
    ["read-window", String(args.pid), String(windowIndex)],
    { untrusted: true },
  )) as Record<string, unknown>;

  const axText = typeof ax["text"] === "string" ? ax["text"].trim() : "";
  if (ax["ok"] === true && axText.length >= 40) {
    return { ...ax, source: "ax" };
  }
  if (ax["ok"] !== true && ax["code"] !== "no_windows") {
    // No Accessibility permission at all: OCR cannot help, because the window
    // rectangle comes from the same accessibility API.
    return ax;
  }

  const shot = (await handsLook({ pid: args.pid, windowIndex })) as Record<string, unknown>;
  if (shot["ok"] !== true) return shot;

  const ocr = (await handsOcr(String(shot["path"]))) as Record<string, unknown>;
  return {
    ...ocr,
    pid: args.pid,
    windowIndex,
    source: ocr["ok"] === true ? "ocr" : (ocr["code"] ?? "ocr_failed"),
    axEmpty: axText.length === 0,
    ...(shot["bounds"] ? { bounds: shot["bounds"] } : {}),
  };
}
