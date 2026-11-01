/**
 * Parity-tool tests.
 *
 * The scroll loop is exercised against fake readers/scrollers, so the stopping
 * rules (already visible → no scroll; never found → bounded and honest) are
 * pinned without a screen. `open_settings` runs a fake `open` binary, so no
 * window is actually raised.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAX_SCROLL_STEPS,
  MAX_WAIT_SECONDS,
  openSettings,
  scrollUntilVisible,
  SETTINGS_BIN_ENV,
  SETTINGS_PANES,
  wait,
} from "./parity";
import { TOOLS } from "../server";
import { validateToolArgs } from "../validate";
import { TOOL_TIERS } from "../../src/lib/tool-tiers";
import { checkPermission, toolPermissionCategory } from "../../src/lib/guardrails";

let dir: string;
let opened: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-parity-"));
  opened = join(dir, "opened.txt");
  const fakeOpen = join(dir, "open");
  writeFileSync(
    fakeOpen,
    `#!/bin/bash\nprintf '%s\\n' "$1" >> ${JSON.stringify(opened)}\nexit 0\n`,
  );
  chmodSync(fakeOpen, 0o755);
  process.env[SETTINGS_BIN_ENV] = fakeOpen;
});

afterAll(() => {
  delete process.env[SETTINGS_BIN_ENV];
  rmSync(dir, { recursive: true, force: true });
});

describe("wait", () => {
  it("waits roughly the requested time", async () => {
    const started = Date.now();
    await wait(0.05);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(1000);
  });

  it("clamps to a sane maximum instead of hanging for hours", async () => {
    const started = Date.now();
    // Ask for an hour; it must behave like MAX_WAIT_SECONDS, so abort quickly.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(wait(3600, controller.signal)).rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(MAX_WAIT_SECONDS).toBeLessThanOrEqual(30);
  });

  it("refuses immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(wait(1, controller.signal)).rejects.toThrow("cancelled");
  });
});

describe("scrollUntilVisible", () => {
  it("does not scroll when the text is already visible", async () => {
    let scrolls = 0;
    const result = await scrollUntilVisible("Inbox", {
      read: async () => "Inbox\nSent\nDrafts",
      scroll: async () => {
        scrolls += 1;
      },
    });
    expect(result).toEqual({ found: true, steps: 0 });
    expect(scrolls).toBe(0);
  });

  it("scrolls until the text appears, counting the steps", async () => {
    const pages = ["top", "middle", "the answer is here", "further"];
    let index = 0;
    const result = await scrollUntilVisible("answer is here", {
      read: async () => pages[index]!,
      scroll: async (dy) => {
        expect(dy).toBe(600);
        index += 1;
      },
    });
    expect(result.found).toBe(true);
    expect(result.steps).toBe(2);
  });

  it("scrolls upward when asked", async () => {
    const seen: number[] = [];
    await scrollUntilVisible("x", {
      read: async () => "nothing",
      scroll: async (dy) => {
        seen.push(dy);
      },
      direction: "up",
      maxSteps: 3,
    });
    expect(seen).toEqual([-600, -600, -600]);
  });

  it("gives up honestly after the step cap", async () => {
    const result = await scrollUntilVisible("nowhere", {
      read: async () => "still nothing",
      scroll: async () => undefined,
      maxSteps: 4,
    });
    expect(result.found).toBe(false);
    expect(result.steps).toBe(4);
    expect(String(result.note)).toContain("Scrolled 4 times");
  });

  it("survives a window that cannot be read", async () => {
    const result = await scrollUntilVisible("anything", {
      read: async () => null,
      scroll: async () => undefined,
      maxSteps: 2,
    });
    expect(result.found).toBe(false);
    expect(result.steps).toBe(2);
  });

  it("stops early when a scroll throws", async () => {
    await expect(
      scrollUntilVisible("x", {
        read: async () => "nothing",
        scroll: async () => {
          throw new Error("scroll failed");
        },
      }),
    ).rejects.toThrow("scroll failed");
  });

  it("needs something to look for", async () => {
    const result = await scrollUntilVisible("   ", {
      read: async () => "",
      scroll: async () => undefined,
    });
    expect(result.found).toBe(false);
    expect(result.note).toBe("no text to look for");
  });
});

describe("openSettings", () => {
  it("opens the Accessibility pane's exact URL", async () => {
    const result = (await openSettings({ pane: "Accessibility" })) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["pane"]).toBe("accessibility");
    expect(readFileSync(opened, "utf8")).toContain(SETTINGS_PANES["accessibility"]!.url);
  });

  it("normalises a pane name with spaces", async () => {
    const result = (await openSettings({ pane: "screen recording" })) as Record<string, unknown>;
    expect(result["pane"]).toBe("screen-recording");
  });

  it("refuses an unknown pane with the list of known ones", async () => {
    const result = (await openSettings({ pane: "bluetooth" })) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toContain("accessibility");
  });
});

describe("registration and tiers", () => {
  it("has a handler and an argument spec", () => {
    for (const tool of ["control_wait", "control_scroll_to", "open_settings"]) {
      expect(typeof TOOLS[tool], tool).toBe("function");
    }
    expect(validateToolArgs("control_wait", { seconds: 1 }).ok).toBe(true);
    expect(validateToolArgs("control_wait", { seconds: -1 }).ok).toBe(false);
    expect(validateToolArgs("control_wait", { seconds: 60 }).ok).toBe(false);
    expect(validateToolArgs("control_scroll_to", { pid: 10, text: "x" }).ok).toBe(true);
    expect(validateToolArgs("control_scroll_to", { text: "x" }).ok).toBe(false);
    expect(validateToolArgs("open_settings", { pane: "accessibility" }).ok).toBe(true);
    expect(validateToolArgs("open_settings", { pane: "" }).ok).toBe(false);
  });

  it("agrees with both permission tables", () => {
    for (const [tool, expected] of [
      ["control_wait", "auto"],
      ["control_scroll_to", "confirm"],
      ["open_settings", "confirm"],
    ] as const) {
      expect(TOOL_TIERS[tool]).toBe(expected);
      const category = toolPermissionCategory(tool);
      expect(category).not.toBe(tool);
      expect(checkPermission(category).permission).toBe(expected);
    }
  });
});
