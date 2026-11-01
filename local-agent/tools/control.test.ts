/**
 * Hands v2 (computer control) tests.
 *
 * What is pinned here:
 *   1. The control helper is the ONLY thing that can act, it refuses without
 *      Accessibility, it will not type into a password field, and it has no
 *      shell.
 *   2. The TypeScript wrapper passes arguments as argv — a hostile string stays
 *      one argument.
 *   3. Every acting tool is confirm-tier in BOTH permission tables, and the
 *      local agent refuses it without a valid approval token.
 *
 * No real click, keystroke or window is ever produced: the helper under test is
 * a fake on a temporary path, and the server harness uses a stub handler.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTROL_BIN_ENV, controlClick, controlMenu, controlPlace, runControl } from "./control";
import { createAgentServer, TOOLS, type ToolHandler } from "../server";
import { assertToolSpecsCoverTools, validateToolArgs } from "../validate";
import { mintApprovalToken } from "../approval";
import { TOOL_TIERS, tierForTool } from "../../src/lib/tool-tiers";
import { checkPermission, toolPermissionCategory } from "../../src/lib/guardrails";

const ACTING_TOOLS = [
  "control_click",
  "control_type",
  "control_key",
  "control_scroll",
  "control_drag",
  "control_menu",
  "control_place",
  "control_focus",
] as const;
const READ_ONLY_CONTROL_TOOLS = ["control_map", "control_status"] as const;
const CONTROL_TOOLS = [...ACTING_TOOLS, ...READ_ONLY_CONTROL_TOOLS];

// ── 1. The helper's own safety properties ─────────────────────────────────

describe("native/jarvis-hands-control is the only acting surface", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../native/jarvis-hands-control/main.swift", import.meta.url)),
    "utf8",
  );
  /** Code only: the header names the APIs this helper does not use. */
  const code = source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  it("refuses to act without Accessibility permission", () => {
    expect(code).toContain("AXIsProcessTrusted");
    expect(code).toContain("accessibility_denied");
    // Every acting command must call the permission gate.
    for (const command of [
      "clickCommand",
      "typeCommand",
      "keyCommand",
      "scrollCommand",
      "dragCommand",
      "menuCommand",
      "placeCommand",
    ]) {
      const start = code.indexOf(`func ${command}`);
      expect(start, `${command} must exist`).toBeGreaterThan(-1);
      const body = code.slice(start, start + 2500);
      expect(body, `${command} must call requireAccessibility()`).toContain(
        "requireAccessibility()",
      );
    }
  });

  it("never types into a secure password field", () => {
    expect(code).toContain("AXSecureTextField");
    expect(code).toContain("secure_field_refused");
  });

  it("targets the app rather than stealing focus by default", () => {
    // Background delivery is what keeps the user's pointer and front app put.
    expect(code).toContain("postToPid");
    // Moving the pointer has to be asked for explicitly.
    expect(code).toContain('"--global"');
  });

  it("parses key chords against a fixed grammar", () => {
    expect(code).toContain("keyCodes");
    expect(code).toContain("unknown_key");
    expect(code).toContain("unknown_modifier");
  });

  it("has no shell and no process spawning of its own", () => {
    for (const token of ["Process(", "NSTask", "/bin/sh", "system(", "popen"]) {
      expect(code, `main.swift must not use ${token}`).not.toContain(token);
    }
  });

  it("exposes exactly the documented subcommands", () => {
    for (const command of [
      "click",
      "type",
      "key",
      "scroll",
      "drag",
      "menu",
      "place",
      "focus",
      "map",
      "permissions",
    ]) {
      expect(code).toContain(`case "${command}"`);
    }
  });

  it("is a separate binary from the read-only observer", () => {
    const readOnlySource = readFileSync(
      fileURLToPath(new URL("../../native/jarvis-hands/main.swift", import.meta.url)),
      "utf8",
    );
    // Comments in that file name the APIs it deliberately does NOT use, so scan
    // code only.
    const readOnlyCode = readOnlySource
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    for (const token of [
      "AXUIElementPerformAction",
      "AXUIElementSetAttributeValue",
      "CGEventPost",
      "postToPid",
      "keyboardSetUnicodeString",
    ]) {
      expect(readOnlyCode, `jarvis-hands must not use ${token}`).not.toContain(token);
    }
  });
});

// ── 2. Runner: argv, not shell ────────────────────────────────────────────

describe("control runner", () => {
  let dir: string;
  let echoBin: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-control-test-"));
    echoBin = join(dir, "fake-control");
    writeFileSync(
      echoBin,
      `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, tool: "fake", argv: process.argv.slice(2) }));\n`,
      "utf8",
    );
    chmodSync(echoBin, 0o755);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes arguments as argv (a hostile string stays one argument)", async () => {
    const hostile = "Save; rm -rf /tmp/jarvis-should-not-exist $(whoami) && echo pwned";
    const run = await runControl(["click", "--label", hostile], {
      env: { [CONTROL_BIN_ENV]: echoBin },
    });
    expect(run.parsed).toEqual({
      ok: true,
      tool: "fake",
      argv: ["click", "--label", hostile],
    });
  });

  it("reports a missing helper instead of throwing", async () => {
    const previous = process.env[CONTROL_BIN_ENV];
    process.env[CONTROL_BIN_ENV] = join(dir, "not-built");
    try {
      const result = (await controlClick({ pid: 99, label: "OK" })) as Record<string, unknown>;
      expect(result["ok"]).toBe(false);
      expect(result["code"]).toBe("helper_missing");
      expect(String(result["error"])).toContain("build.command");
    } finally {
      if (previous === undefined) delete process.env[CONTROL_BIN_ENV];
      else process.env[CONTROL_BIN_ENV] = previous;
    }
  });

  it("builds the documented argv for each acting tool", async () => {
    const previous = process.env[CONTROL_BIN_ENV];
    process.env[CONTROL_BIN_ENV] = echoBin;
    try {
      const menu = (await controlMenu({ pid: 7, path: "File>Export>PDF" })) as Record<
        string,
        unknown
      >;
      expect(menu["argv"]).toEqual(["menu", "--pid", "7", "--path", "File>Export>PDF"]);

      const place = (await controlPlace({ pid: 7, where: "left", screen: 1 })) as Record<
        string,
        unknown
      >;
      expect(place["argv"]).toEqual(["place", "--pid", "7", "--where", "left", "--screen", "1"]);
    } finally {
      if (previous === undefined) delete process.env[CONTROL_BIN_ENV];
      else process.env[CONTROL_BIN_ENV] = previous;
    }
  });

  it("does not use a shell anywhere in the wrapper", () => {
    const wrapper = readFileSync(fileURLToPath(new URL("./control.ts", import.meta.url)), "utf8");
    expect(wrapper).toContain("execFile");
    expect(wrapper).toContain("shell: false");
    expect(wrapper).not.toMatch(/\bexecSync\(/);
    expect(wrapper).not.toMatch(/shell:\s*true/);
  });
});

// ── 3. Validation ─────────────────────────────────────────────────────────

describe("control arguments are validated before a process is spawned", () => {
  it("accepts well-formed calls", () => {
    expect(validateToolArgs("control_click", { pid: 42, label: "Save" }).ok).toBe(true);
    expect(validateToolArgs("control_click", { pid: 42, x: 100, y: 200 }).ok).toBe(true);
    expect(validateToolArgs("control_type", { text: "hello" }).ok).toBe(true);
    expect(validateToolArgs("control_key", { combo: "cmd+shift+t" }).ok).toBe(true);
    expect(validateToolArgs("control_menu", { pid: 1, path: "File>Export>PDF" }).ok).toBe(true);
    expect(validateToolArgs("control_place", { pid: 1, where: "left" }).ok).toBe(true);
    expect(validateToolArgs("control_drag", { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }).ok).toBe(
      true,
    );
    expect(validateToolArgs("control_status", {}).ok).toBe(true);
  });

  it("rejects malformed coordinates, pids and extra keys", () => {
    expect(validateToolArgs("control_click", { pid: "42", label: "Save" }).ok).toBe(false);
    expect(validateToolArgs("control_click", { label: "Save" }).ok).toBe(false);
    expect(validateToolArgs("control_click", { pid: 0, label: "Save" }).ok).toBe(false);
    expect(validateToolArgs("control_click", { pid: 42, x: 1.5, y: 2 }).ok).toBe(false);
    expect(validateToolArgs("control_click", { pid: 42, x: 999_999, y: 2 }).ok).toBe(false);
    expect(validateToolArgs("control_click", { pid: 42, label: "Save", surprise: 1 }).ok).toBe(
      false,
    );
    expect(
      validateToolArgs("control_drag", { from: { x: 1, y: 2, z: 3 }, to: { x: 3, y: 4 } }).ok,
    ).toBe(false);
  });

  it("rejects key chords and menu paths that are not in the grammar", () => {
    expect(validateToolArgs("control_key", { combo: "cmd+nosuchkey" }).ok).toBe(true); // helper rejects it by name
    expect(validateToolArgs("control_key", { combo: "cmd + ; rm -rf /" }).ok).toBe(false);
    expect(validateToolArgs("control_key", { combo: "" }).ok).toBe(false);
    expect(validateToolArgs("control_menu", { pid: 1, path: "File>>Export" }).ok).toBe(false);
    expect(
      validateToolArgs("control_menu", { pid: 1, path: "File>Export>PDF>More>Still>Deep>X" }).ok,
    ).toBe(false);
    expect(validateToolArgs("control_place", { pid: 1, where: "sideways" }).ok).toBe(false);
    expect(validateToolArgs("control_type", { text: "x".repeat(4001) }).ok).toBe(false);
  });

  it("has a handler and a spec for every control tool", () => {
    for (const tool of CONTROL_TOOLS) {
      expect(typeof TOOLS[tool], `${tool} handler`).toBe("function");
    }
    expect(() => assertToolSpecsCoverTools(Object.keys(TOOLS), { requireAll: true })).not.toThrow();
  });
});

// ── 4. Tiers ──────────────────────────────────────────────────────────────

describe("control tiers", () => {
  it("makes every acting tool confirm-tier in both tables", () => {
    for (const tool of ACTING_TOOLS) {
      expect(TOOL_TIERS[tool], `${tool} tier`).toBe("confirm");
      expect(tierForTool(tool)).toBe("confirm");
      const category = toolPermissionCategory(tool);
      expect(category).toBe(`control.${tool.replace("control_", "")}`);
      expect(checkPermission(category).permission).toBe("confirm");
    }
  });

  it("keeps the two read-only control tools auto-tier", () => {
    for (const tool of READ_ONLY_CONTROL_TOOLS) {
      expect(TOOL_TIERS[tool]).toBe("auto");
      const category = toolPermissionCategory(tool);
      expect(checkPermission(category)).toEqual({ allowed: true, permission: "auto" });
    }
  });
});

// ── 5. Approval is required by the server, not just asked for by the client ──

describe("the local agent refuses control without a real approval", () => {
  const APPROVAL_KEY = "c".repeat(64);
  const SECRET = "control-test-secret";
  let server: Server;
  let url: string;
  const calls: Array<Record<string, unknown>> = [];

  const handler: ToolHandler = (args) => {
    calls.push(args);
    return { ok: true, clicked: args["label"] ?? null };
  };

  const call = async (
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${url}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed };
  };

  beforeAll(async () => {
    server = createAgentServer({
      secret: SECRET,
      approvalKey: APPROVAL_KEY,
      tools: { control_click: handler, control_map: handler },
      tierFor: (tool) => TOOL_TIERS[tool] ?? "confirm",
      log: () => {},
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects a control call with the bearer secret alone", async () => {
    const res = await call({ tool: "control_click", args: { pid: 42, label: "Save" } });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("rejects a token minted for a different tool or different args", async () => {
    const otherTool = mintApprovalToken({
      key: APPROVAL_KEY,
      tool: "open_app",
      args: { pid: 42, label: "Save" },
    });
    // 403 (not 401): the bearer is fine, the approval is not.
    expect(
      (
        await call({
          tool: "control_click",
          args: { pid: 42, label: "Save" },
          approvalToken: otherTool,
        })
      ).status,
    ).toBe(403);

    const otherArgs = mintApprovalToken({
      key: APPROVAL_KEY,
      tool: "control_click",
      args: { pid: 42, label: "Delete" },
    });
    expect(
      (
        await call({
          tool: "control_click",
          args: { pid: 42, label: "Save" },
          approvalToken: otherArgs,
        })
      ).status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("runs the approved action exactly once", async () => {
    const args = { pid: 42, label: "Save" };
    const token = mintApprovalToken({ key: APPROVAL_KEY, tool: "control_click", args });
    const first = await call({ tool: "control_click", args, approvalToken: token });
    expect(first.status).toBe(200);
    expect(calls).toHaveLength(1);

    // A replayed token must not click twice.
    const replay = await call({ tool: "control_click", args, approvalToken: token });
    expect(replay.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("leaves read-only control tools open without a token", async () => {
    const res = await call({ tool: "control_map", args: { pid: 42 } });
    expect(res.status).toBe(200);
  });
});
