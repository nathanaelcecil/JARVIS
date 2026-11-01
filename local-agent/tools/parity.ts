/**
 * Parity primitives: the small pieces that make a control sequence reliable.
 *
 *   control_wait      let a window settle without guessing a sleep in prose.
 *   control_scroll_to "scroll until I can see <text>" — bounded, and honest
 *                     when the text never appears.
 *   open_settings     jump to the exact System Settings pane a permission
 *                     lives in, instead of describing the path in words.
 *
 * Nothing here invents success: a scroll that never finds the text says so and
 * reports how far it looked. The scroll loop takes its reader and scroller as
 * arguments so its stopping rules are tested without a real screen.
 */

import { execFile } from "node:child_process";

export const SETTINGS_BIN_ENV = "JARVIS_OPEN_BIN";
export const MAX_WAIT_SECONDS = 30;
export const MAX_SCROLL_STEPS = 20;

/** Panes we know by heart, with the URL each one needs. */
export const SETTINGS_PANES: Record<string, { url: string; what: string }> = {
  accessibility: {
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    what: "Accessibility — needed by jarvis-hands-control to click, type and press keys",
  },
  "screen-recording": {
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    what: "Screen Recording — needed to read what is on screen",
  },
  microphone: {
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    what: "Microphone — needed for voice input and dictation",
  },
  speech: {
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
    what: "Speech Recognition — needed for the wake word",
  },
  automation: {
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
    what: "Automation — needed to read Contacts and control Spotify",
  },
  notifications: {
    url: "x-apple.systempreferences:com.apple.preference.notifications",
    what: "Notifications — where JARVIS banners are listed",
  },
  sound: {
    url: "x-apple.systempreferences:com.apple.preference.sound",
    what: "Sound output/input",
  },
  network: { url: "x-apple.systempreferences:com.apple.preference.network", what: "Network" },
  battery: { url: "x-apple.systempreferences:com.apple.preference.battery", what: "Battery" },
};

/** Wait, cooperatively: an aborted request stops the wait instead of holding it. */
export function wait(seconds: number, signal?: AbortSignal): Promise<void> {
  const ms = Math.min(Math.max(seconds, 0), MAX_WAIT_SECONDS) * 1000;
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    };
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ScrollToDeps {
  /** Text currently visible in the window, or null when it cannot be read. */
  read: () => Promise<string | null>;
  /** Scroll one step; `dy` is negative for up. */
  scroll: (dy: number) => Promise<unknown>;
  /** Steps to take at most (default MAX_SCROLL_STEPS). */
  maxSteps?: number;
  direction?: "down" | "up";
}

/**
 * Scroll until `text` appears, or give up honestly.
 *
 * Deliberately checks the current view first: "scroll to X" when X is already
 * visible must not move the window at all.
 */
export async function scrollUntilVisible(
  text: string,
  deps: ScrollToDeps,
): Promise<{
  found: boolean;
  steps: number;
  note?: string;
}> {
  const needle = text.trim().toLowerCase();
  if (!needle) return { found: false, steps: 0, note: "no text to look for" };

  const maxSteps = deps.maxSteps ?? MAX_SCROLL_STEPS;
  const dy = deps.direction === "up" ? -600 : 600;

  let seen = (await deps.read())?.toLowerCase() ?? "";
  if (seen.includes(needle)) return { found: true, steps: 0 };

  for (let step = 1; step <= maxSteps; step++) {
    await deps.scroll(dy);
    seen = (await deps.read())?.toLowerCase() ?? "";
    if (seen.includes(needle)) return { found: true, steps: step };
  }

  return {
    found: false,
    steps: maxSteps,
    note: `Scrolled ${maxSteps} times without seeing "${text}". It may be on another page, in another window, or not in this document at all.`,
  };
}

/** Open a System Settings pane. Returns the pane it opened, never a guess. */
export async function openSettings(args: { pane: string }): Promise<unknown> {
  const key = args.pane.trim().toLowerCase().replace(/\s+/g, "-");
  const pane = SETTINGS_PANES[key];
  if (!pane) {
    return {
      ok: false,
      code: "usage",
      error: `unknown settings pane "${args.pane}". Known panes: ${Object.keys(SETTINGS_PANES).join(", ")}`,
    };
  }
  return new Promise((resolvePromise) => {
    execFile(
      process.env[SETTINGS_BIN_ENV] ?? "/usr/bin/open",
      [pane.url],
      { timeout: 10_000 },
      (error) => {
        if (error) {
          resolvePromise({
            ok: false,
            code: "open_failed",
            error: `System Settings did not open: ${error.message}`,
          });
          return;
        }
        resolvePromise({ ok: true, tool: "open_settings", pane: key, what: pane.what });
      },
    );
  });
}
