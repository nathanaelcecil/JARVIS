/**
 * Hands v1 tests.
 *
 * Three things are pinned here:
 *   1. The Swift helper contains NO way to act on the computer (static check).
 *   2. The runner spawns it with an argv array — no shell, so an argument can
 *      never be interpreted as shell syntax.
 *   3. Every hands tool is argument-validated and auto-tier only because it is
 *      read-only; the tier tables agree.
 *
 * No real window is ever read here: the helper under test is a fake on a
 * temporary path (JARVIS_HANDS_BIN), so these run headless and touch nothing.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  HANDS_BIN_ENV,
  handsListWindows,
  handsReadFocused,
  handsReadWindow,
  handsCrop,
  runHands,
} from "./hands";
import { TOOLS } from "../server";
import { assertToolSpecsCoverTools, validateToolArgs } from "../validate";
import { TOOL_TIERS, tierForTool } from "../../src/lib/tool-tiers";
import { checkPermission, toolPermissionCategory } from "../../src/lib/guardrails";

const HANDS_TOOLS = [
  "hands_list_windows",
  "hands_read_window",
  "hands_read_focused",
  "hands_status",
  "hands_look",
  "hands_read_screen",
  "hands_crop",
] as const;

// ── 1. Static: the helper cannot act ───────────────────────────────────────

describe("native/jarvis-hands is observation-only", () => {
  const sourcePath = fileURLToPath(
    new URL("../../native/jarvis-hands/main.swift", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");

  it("contains no API that can act on the computer", () => {
    // Comments name the APIs this helper deliberately does NOT use, so scan
    // code only — the header would otherwise match its own denylist.
    const code = source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    const forbidden = [
      "AXUIElementPerformAction",
      "AXUIElementSetAttributeValue",
      "AXUIElementSetMessagingTimeout",
      "CGEventPost",
      "CGEventCreate",
      "CGEventTapCreate",
      "NSEvent",
      "keystroke",
      "NSWorkspace",
      "NSRunningApplication",
      "NSApplication",
      "activate(",
      "openURL",
      "pasteboard",
      "WriteFile",
      "FileManager.default",
      "Process(",
      "NSTask",
    ];
    for (const token of forbidden) {
      expect(code, `main.swift must not use ${token}`).not.toContain(token);
    }
  });

  it("exposes only read-only subcommands", () => {
    for (const command of ["list-windows", "read-window", "read-focused", "permissions"]) {
      expect(source).toContain(command);
    }
    // Reading the AX tree is the only attribute access used.
    expect(source).toContain("AXUIElementCopyAttributeValue");
  });

  it("never reads secure text fields", () => {
    expect(source).toContain("AXSecureTextField");
    expect(source).toContain("secretRoles");
  });
});

// ── 2. Runner: argv, not shell ─────────────────────────────────────────────

describe("hands runner", () => {
  let dir: string;
  let goodBin: string;
  let garbageBin: string;
  let slowBin: string;

  const writeHelper = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, body, "utf8");
    chmodSync(path, 0o755);
    return path;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-hands-test-"));
    goodBin = writeHelper(
      "fake-hands-node",
      `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, tool: "fake", argv: process.argv.slice(2) }));\n`,
    );
    garbageBin = writeHelper("fake-hands-garbage", `#!/bin/bash\necho "not json at all"\n`);
    // Prints nothing at all, so the assertion is deterministic even if the
    // kill lands late: there is never output to parse.
    slowBin = writeHelper("fake-hands-slow", `#!/bin/bash\nsleep 5\nexit 0\n`);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes arguments as argv (a hostile string stays one argument)", async () => {
    const hostile = "1; rm -rf /tmp/jarvis-should-not-exist && echo pwned";
    const run = await runHands(["read-window", hostile], { env: { [HANDS_BIN_ENV]: goodBin } });
    expect(run.parsed).toEqual({ ok: true, tool: "fake", argv: ["read-window", hostile] });
    expect(run.status).toBe(0);
  });

  it("reports a missing helper without throwing", async () => {
    const run = await runHands(["permissions"], {
      env: { [HANDS_BIN_ENV]: join(dir, "definitely-not-here") },
    });
    expect(run.status).not.toBe(0);
    expect(run.parsed).toBeNull();
  });

  it("surfaces non-JSON output as bad output rather than a crash", async () => {
    const previous = process.env[HANDS_BIN_ENV];
    process.env[HANDS_BIN_ENV] = garbageBin;
    try {
      const result = (await handsListWindows()) as Record<string, unknown>;
      expect(result["ok"]).toBe(false);
      expect(result["code"]).toBe("helper_bad_output");
    } finally {
      if (previous === undefined) delete process.env[HANDS_BIN_ENV];
      else process.env[HANDS_BIN_ENV] = previous;
    }
  });

  it("returns helper_missing when the binary is absent", async () => {
    const previous = process.env[HANDS_BIN_ENV];
    process.env[HANDS_BIN_ENV] = join(dir, "missing-bin");
    try {
      const result = (await handsReadFocused()) as Record<string, unknown>;
      expect(result["ok"]).toBe(false);
      expect(result["code"]).toBe("helper_missing");
      expect(String(result["error"])).toContain("build.command");
    } finally {
      if (previous === undefined) delete process.env[HANDS_BIN_ENV];
      else process.env[HANDS_BIN_ENV] = previous;
    }
  });

  it("times out a hung helper instead of hanging the agent", async () => {
    // A short timeout is what an agent-side deadline would be; the hung helper
    // must be killed and reported, never awaited forever.
    const run = await runHands(["read-focused"], {
      timeoutMs: 200,
      env: { [HANDS_BIN_ENV]: slowBin },
    });
    expect(run.status).not.toBe(0);
    expect(run.parsed).toBeNull();
  }, 15000);

  it("tags window contents as untrusted data", async () => {
    const previous = process.env[HANDS_BIN_ENV];
    process.env[HANDS_BIN_ENV] = goodBin;
    try {
      const result = (await handsReadWindow({ pid: 4242, windowIndex: 1 })) as Record<
        string,
        unknown
      >;
      expect(result["untrusted"]).toBe(true);
      expect(result["argv"]).toEqual(["read-window", "4242", "1"]);
    } finally {
      if (previous === undefined) delete process.env[HANDS_BIN_ENV];
      else process.env[HANDS_BIN_ENV] = previous;
    }
  });

  it("does not use a shell anywhere in the wrapper", () => {
    const wrapper = readFileSync(fileURLToPath(new URL("./hands.ts", import.meta.url)), "utf8");
    expect(wrapper).toContain("execFile");
    expect(wrapper).toContain("shell: false");
    expect(wrapper).not.toMatch(/\bexecSync\(/);
    expect(wrapper).not.toMatch(/shell:\s*true/);
  });
});

// ── 3. Validation, registration and tiers ──────────────────────────────────

describe("hands tools are registered, validated and read-only", () => {
  it("every tool has a handler and an argument spec", () => {
    for (const tool of HANDS_TOOLS) {
      expect(typeof TOOLS[tool]).toBe("function");
    }
    expect(() => assertToolSpecsCoverTools(Object.keys(TOOLS), { requireAll: true })).not.toThrow();
  });

  it("rejects malformed or extra arguments before any handler runs", () => {
    expect(validateToolArgs("hands_read_window", { pid: 12 }).ok).toBe(true);
    expect(validateToolArgs("hands_read_window", { pid: 12, windowIndex: 3 }).ok).toBe(true);
    // A string pid, a missing pid, an out-of-range index and an unknown key
    // must all be refused.
    expect(validateToolArgs("hands_read_window", { pid: "12" }).ok).toBe(false);
    expect(validateToolArgs("hands_read_window", {}).ok).toBe(false);
    expect(validateToolArgs("hands_read_window", { pid: 12, windowIndex: 501 }).ok).toBe(false);
    expect(validateToolArgs("hands_read_window", { pid: 12, windowIndex: -1 }).ok).toBe(false);
    expect(validateToolArgs("hands_read_window", { pid: 12, extra: "x" }).ok).toBe(false);
    expect(validateToolArgs("hands_list_windows", {}).ok).toBe(true);
    expect(validateToolArgs("hands_list_windows", { anything: 1 }).ok).toBe(false);
    expect(validateToolArgs("hands_read_focused", {}).ok).toBe(true);
    expect(validateToolArgs("hands_status", {}).ok).toBe(true);
    // hands_crop: a region is four numbers, all required, and a crop smaller
    // than 8×8 is refused as meaningless rather than captured.
    expect(validateToolArgs("hands_crop", { x: 10, y: 20, width: 300, height: 200 }).ok).toBe(true);
    expect(validateToolArgs("hands_crop", { x: -500, y: 0, width: 300, height: 200 }).ok).toBe(
      true,
    );
    expect(validateToolArgs("hands_crop", { x: 10, y: 20, width: 300 }).ok).toBe(false);
    expect(validateToolArgs("hands_crop", { x: 10, y: 20, width: 4, height: 200 }).ok).toBe(false);
    expect(validateToolArgs("hands_crop", { x: "10", y: 20, width: 300, height: 200 }).ok).toBe(
      false,
    );
  });

  it("refuses a crop too small to be meaningful before capturing anything", async () => {
    await expect(handsCrop({ x: 0, y: 0, width: 4, height: 4 })).resolves.toMatchObject({
      ok: false,
      code: "invalid_region",
    });
    await expect(
      handsCrop({ x: Number.NaN, y: 0, width: 100, height: 100 }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_region" });
  });

  it("is auto-tier in both permission tables (read-only means no prompt)", () => {
    for (const tool of HANDS_TOOLS) {
      expect(TOOL_TIERS[tool]).toBe("auto");
      expect(tierForTool(tool)).toBe("auto");
      const category = toolPermissionCategory(tool);
      expect(category).toBe(`hands.${tool.replace("hands_", "")}`);
      expect(checkPermission(category)).toEqual({ allowed: true, permission: "auto" });
      // A tool absent from the mapping would fail closed to confirm; assert the
      // mapping really exists rather than relying on the default.
      expect(category).not.toBe(tool);
    }
  });
});
