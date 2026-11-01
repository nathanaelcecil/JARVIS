/**
 * Injection tests for the local-agent tool layer.
 *
 * `node:child_process` is mocked, so these tests prove what WOULD have been
 * executed. No hostile payload ever reaches a real shell. A temp sentinel file
 * is used as a tripwire: if any payload were interpreted, it would appear.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execFile: vi.fn(),
  spawn: vi.fn(),
  exec: vi.fn(),
}));

import { openApp, quitApp, listRunningApps, resolveAppTarget } from "./desktop";
import { openInFinder } from "./filesystem";
import { setVolume } from "./system";

const root = mkdtempSync(join(tmpdir(), "jarvis-inject-"));
const sentinel = join(root, "SENTINEL");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue("42");
});

const HOSTILE_APP_VALUES = [
  `Safari"; touch ${sentinel}; echo "`,
  `$(touch ${sentinel})`,
  `\`touch ${sentinel}\``,
  "Safari\nquit",
  "-a Safari",
  "Safari | cat",
  "Safari && touch x",
  "Safari > /tmp/out",
  "Safari < /etc/passwd",
  `Safari\\"`,
  "x".repeat(101),
];

describe("desktop tools reject hostile app names", () => {
  for (const value of HOSTILE_APP_VALUES) {
    it(`refuses ${JSON.stringify(value).slice(0, 40)} without spawning`, () => {
      const opened = openApp({ name: value });
      expect(opened.success).toBe(false);
      expect(opened.error).toBeTruthy();

      const quit = quitApp({ name: value });
      expect(quit.success).toBe(false);
      expect(quit.error).toBeTruthy();

      expect(execFileSyncMock).not.toHaveBeenCalled();
      expect(existsSync(sentinel)).toBe(false);
    });
  }

  it("opens a plain app name via argv, never a shell string", () => {
    const result = openApp({ name: "Safari" });
    expect(result.success).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [file, args] = execFileSyncMock.mock.calls[0] as [string, string[]];
    expect(file).toBe("open");
    expect(args).toEqual(["-a", "Safari"]);
  });

  it("accepts a bundle id", () => {
    expect(openApp({ name: "com.apple.Safari" }).success).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "open",
      ["-a", "com.apple.Safari"],
      expect.anything(),
    );
  });

  it("refuses a .app path outside the standard Applications folders", () => {
    const outside = join(root, "Evil.app");
    mkdirSync(outside);
    const result = openApp({ name: outside });
    expect(result.success).toBe(false);
    expect(result.error).toContain("must live in");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("resolves a system .app bundle that really lives in an allowed root", () => {
    // realpath matters: /Applications/Safari.app resolves into the cryptex on
    // modern macOS, so only assert the rule, not a specific machine layout.
    const candidate = "/System/Applications/Calculator.app";
    if (!existsSync(candidate)) return;
    const real = realpathSync(candidate);
    const result = resolveAppTarget(candidate);
    if (real.startsWith("/System/Applications/")) {
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
    }
  });

  it("passes the quit target as argv, never as script text", () => {
    const result = quitApp({ name: "Safari" });
    expect(result.success).toBe(true);
    const [file, args] = execFileSyncMock.mock.calls[0] as [string, string[]];
    expect(file).toBe("osascript");
    expect(args).toEqual([
      "-e",
      "on run argv",
      "-e",
      "tell application (item 1 of argv) to quit",
      "-e",
      "end run",
      "Safari",
    ]);
    // The app name must appear only as the argv argument, never inside -e text.
    const scriptParts = args.filter((part) => part !== "Safari");
    expect(scriptParts.join(" ")).not.toContain("Safari");
  });

  it("lists apps with a constant script", () => {
    execFileSyncMock.mockReturnValue("Safari, Mail");
    const result = listRunningApps();
    expect(result.success).toBe(true);
    expect(result.apps).toEqual([{ name: "Safari" }, { name: "Mail" }]);
    const [, args] = execFileSyncMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual([
      "-e",
      'tell application "System Events" to get name of every process whose background only is false',
    ]);
  });
});

describe("open_in_finder refuses executable targets", () => {
  it("opens a normal folder with an argv array", () => {
    const result = openInFinder({ path: root });
    expect(result.success).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith("open", [root], expect.anything());
  });

  it("refuses a .command file", () => {
    const file = join(root, "run.command");
    writeFileSync(file, "#!/bin/sh\ntouch " + sentinel + "\n", { mode: 0o755 });
    const result = openInFinder({ path: file });
    expect(result.success).toBe(false);
    expect(result.error).toContain("execute");
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(existsSync(sentinel)).toBe(false);
  });

  it("refuses a file with the executable bit set", () => {
    const file = join(root, "script.txt");
    writeFileSync(file, "harmless\n");
    chmodSync(file, 0o755);
    const result = openInFinder({ path: file });
    expect(result.success).toBe(false);
    expect(result.error).toContain("executable");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("refuses an .app bundle", () => {
    mkdirSync(join(root, "Thing.app"));
    const result = openInFinder({ path: join(root, "Thing.app") });
    expect(result.success).toBe(false);
    expect(result.error).toContain(".app");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

describe("system volume uses argv", () => {
  it("passes the volume as an argv argument and verifies it", () => {
    const result = setVolume({ level: 42 });
    expect(result.success).toBe(true);
    const calls = execFileSyncMock.mock.calls as Array<[string, string[]]>;
    const setCall = calls.find(([, args]) => args.join(" ").includes("set volume output volume"));
    expect(setCall).toBeDefined();
    if (!setCall) return;
    expect(setCall[0]).toBe("osascript");
    expect(setCall[1]).toContain("on run argv");
    expect(setCall[1][setCall[1].length - 1]).toBe("42");
    expect(setCall[1].join(" ")).not.toContain("output volume 42");
  });

  it("clamps out-of-range volume values", () => {
    setVolume({ level: 1000 });
    const calls = execFileSyncMock.mock.calls as Array<[string, string[]]>;
    const setCall = calls.find(([, args]) => args.join(" ").includes("set volume output volume"));
    expect(setCall?.[1][setCall[1].length - 1]).toBe("100");
  });
});

describe("no shell-string execution remains", () => {
  it("never uses execSync( (shell form) in local-agent/tools", () => {
    const dir = new URL(".", import.meta.url);
    const files = readdirSync(dir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const source = readFileSync(new URL(name, dir), "utf-8");
      // execFileSync( is allowed; bare execSync( is the shell-string form.
      expect(source).not.toMatch(/(^|[^A-Za-z])execSync\s*\(/);
    }
  });
});
