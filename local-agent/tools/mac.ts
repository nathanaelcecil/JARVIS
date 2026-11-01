/**
 * macOS integrations: Spotlight file search, Contacts lookup, Spotify transport.
 *
 * All three are argv-only (never a shell string), and each returns a structured
 * failure the model can explain instead of a generic error:
 *
 *   automation_denied   the user has not allowed JARVIS to control Contacts /
 *                       Spotify (System Settings → Privacy & Security →
 *                       Automation). This is a macOS prompt the user must
 *                       accept once.
 *   spotlight_denied    Spotlight indexing is disabled or the path is not
 *                       indexed.
 *   spotify_not_running Spotify is not open.
 *
 * Spotify transport is deliberately limited to what AppleScript supports
 * reliably (play/pause, next, previous, volume, current state). Searching for
 * and playing an arbitrary track is a UI interaction, so it belongs to the
 * control_* tools where it gets an approval card.
 */

import { execFile } from "node:child_process";

export const OSASCRIPT_BIN_ENV = "JARVIS_OSASCRIPT_BIN";
export const MDFIND_BIN_ENV = "JARVIS_MDFIND_BIN";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RESULTS_DEFAULT = 25;
const MAX_RESULTS_CAP = 100;

function bin(envName: string, fallback: string): string {
  const override = process.env[envName];
  return override && override.trim() ? override.trim() : fallback;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", shell: false },
      (error, stdout, stderr) => {
        const status =
          error && typeof (error as NodeJS.ErrnoException).code === "number"
            ? ((error as NodeJS.ErrnoException).code as unknown as number)
            : error
              ? 1
              : 0;
        resolvePromise({
          status,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

/** Map an osascript failure onto something the model can act on. */
function classifyOsaFailure(stderr: string, app: string): { code: string; error: string } {
  const text = stderr.trim();
  if (/-1743|not authori[sz]ed|Not allowed/i.test(text)) {
    return {
      code: "automation_denied",
      error: `macOS has not allowed JARVIS to control ${app}. Grant it once in System Settings → Privacy & Security → Automation (the request appears the first time).`,
    };
  }
  if (/isn't running|not running|-600/i.test(text)) {
    return { code: "app_not_running", error: `${app} is not running.` };
  }
  return { code: "applescript_failed", error: text.slice(0, 400) || `${app} did not respond.` };
}

// ── Spotlight ─────────────────────────────────────────────────────────────

/** Search files by content or name with Spotlight. Read-only. */
export async function spotlightSearch(args: {
  query: string;
  path?: string;
  maxResults?: number;
}): Promise<unknown> {
  const query = args.query.trim();
  if (!query) return { ok: false, code: "usage", error: "a search query is required" };
  const limit = Math.min(Math.max(args.maxResults ?? MAX_RESULTS_DEFAULT, 1), MAX_RESULTS_CAP);

  const argv = args.path ? ["-onlyin", args.path, query] : [query];
  const result = await run(bin(MDFIND_BIN_ENV, "/usr/bin/mdfind"), argv);

  if (result.status !== 0) {
    const text = result.stderr.trim();
    return {
      ok: false,
      code: /index/i.test(text) ? "spotlight_denied" : "spotlight_failed",
      error:
        text.slice(0, 300) ||
        "Spotlight could not answer. Check that indexing is enabled for that location.",
    };
  }

  const paths = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return {
    ok: true,
    tool: "spotlight_search",
    query,
    ...(args.path ? { path: args.path } : {}),
    count: Math.min(paths.length, limit),
    total: paths.length,
    results: paths.slice(0, limit),
  };
}

// ── Contacts ──────────────────────────────────────────────────────────────

const CONTACTS_SCRIPT = `on run argv
  set q to item 1 of argv
  set out to ""
  tell application "Contacts"
    set matches to (every person whose name contains q)
    repeat with p in matches
      set nm to name of p
      set em to ""
      try
        set em to value of first email of p
      end try
      set ph to ""
      try
        set ph to value of first phone of p
      end try
      set out to out & nm & tab & em & tab & ph & linefeed
    end repeat
  end tell
  return out
end run`;

export interface ContactMatch {
  name: string;
  email: string;
  phone: string;
}

/** Look someone up in Contacts. Read-only, but needs Automation permission. */
export async function contactsSearch(args: {
  query: string;
  maxResults?: number;
}): Promise<unknown> {
  const query = args.query.trim();
  if (!query) return { ok: false, code: "usage", error: "a name to look up is required" };
  const limit = Math.min(Math.max(args.maxResults ?? 5, 1), 25);

  const result = await run(bin(OSASCRIPT_BIN_ENV, "/usr/bin/osascript"), [
    "-e",
    CONTACTS_SCRIPT,
    query,
  ]);

  if (result.status !== 0) {
    return { ok: false, ...classifyOsaFailure(result.stderr, "Contacts") };
  }

  const contacts: ContactMatch[] = result.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => (parts[0] ?? "").trim().length > 0)
    .map((parts) => ({
      name: (parts[0] ?? "").trim(),
      email: (parts[1] ?? "").trim(),
      phone: (parts[2] ?? "").trim(),
    }));

  return {
    ok: true,
    tool: "contacts_search",
    query,
    count: Math.min(contacts.length, limit),
    contacts: contacts.slice(0, limit),
    ...(contacts.length === 0 ? { note: "No contact matched that name." } : {}),
  };
}

// ── Spotify ───────────────────────────────────────────────────────────────

// `player state` is an enumeration; it coerces with `as string` (note: `as
// text` is rejected by the Spotify scripting dictionary at compile time, and a
// bare `set st to` collides with Spotify's own terms). The additional
// transports (play/queue by URI) are AppleScript-native; free-text search is
// not, so it stays a UI task.
const SPOTIFY_SCRIPT = `on run argv
  set act to item 1 of argv
  tell application "Spotify"
    if act is "playpause" then
      playpause
    else if act is "next" then
      next track
    else if act is "previous" then
      previous track
    else if act is "volume" then
      set sound volume to (item 2 of argv) as integer
    else if act is "play" then
      play
    else if act is "pause" then
      pause
    else if act is "playuri" then
      play track (item 2 of argv)
    else if act is "queue" then
      open location "spotify:track:" & (item 2 of argv)
    end if
    set pstate to (player state) as string
    set tname to ""
    set tart to ""
    try
      set tname to name of current track
      set tart to artist of current track
    end try
    return act & tab & pstate & tab & tname & tab & tart
  end tell
end run`;

export type SpotifyAction =
  "playpause" | "next" | "previous" | "play" | "pause" | "volume" | "playuri" | "queue";

/**
 * A Spotify track URI, or a bare 22-character track id (which is turned into a
 * URI). Anything else is refused rather than handed to AppleScript, so a value
 * can never smuggle in another AppleScript statement.
 */
export function normalizeSpotifyUri(input: string): string | null {
  const value = input.trim();
  if (/^spotify:track:[A-Za-z0-9]{22}$/.test(value)) return value;
  if (/^[A-Za-z0-9]{22}$/.test(value)) return `spotify:track:${value}`;
  return null;
}

/** Read what Spotify is playing. Read-only, so auto tier. */
export async function spotifyStatus(): Promise<unknown> {
  const result = await run(bin(OSASCRIPT_BIN_ENV, "/usr/bin/osascript"), [
    "-e",
    SPOTIFY_SCRIPT,
    "status",
  ]);
  if (result.status !== 0) {
    return { ok: false, ...classifyOsaFailure(result.stderr, "Spotify") };
  }
  const [, state = "", track = "", artist = ""] = result.stdout.trim().split("\t");
  return {
    ok: true,
    tool: "spotify_status",
    state,
    playing: state === "playing",
    track: track || null,
    artist: artist || null,
  };
}

/** Control Spotify transport. Confirm tier: it changes what is playing. */
export async function spotifyControl(args: {
  action: SpotifyAction;
  volume?: number;
  uri?: string;
}): Promise<unknown> {
  const allowed: SpotifyAction[] = [
    "playpause",
    "next",
    "previous",
    "play",
    "pause",
    "volume",
    "playuri",
    "queue",
  ];
  if (!allowed.includes(args.action)) {
    return {
      ok: false,
      code: "usage",
      error: `action must be one of: ${allowed.join(", ")}`,
    };
  }
  if (args.action === "volume") {
    if (typeof args.volume !== "number" || !Number.isInteger(args.volume)) {
      return { ok: false, code: "usage", error: "volume needs an integer 0-100" };
    }
    if (args.volume < 0 || args.volume > 100) {
      return { ok: false, code: "usage", error: "volume must be between 0 and 100" };
    }
  }

  let uri: string | null = null;
  if (args.action === "playuri" || args.action === "queue") {
    if (!args.uri) {
      return {
        ok: false,
        code: "usage",
        error: `action "${args.action}" needs a Spotify track URI (spotify:track:<id>) or a track id`,
      };
    }
    uri = normalizeSpotifyUri(args.uri);
    if (!uri) {
      return {
        ok: false,
        code: "usage",
        error:
          "that is not a Spotify track URI. Expected spotify:track:<22 characters> or a 22-character track id.",
      };
    }
  }

  const argv = ["-e", SPOTIFY_SCRIPT, args.action];
  if (args.action === "volume") argv.push(String(args.volume));
  if (args.action === "playuri") argv.push(uri!);
  if (args.action === "queue") argv.push(uri!.replace("spotify:track:", ""));

  const result = await run(bin(OSASCRIPT_BIN_ENV, "/usr/bin/osascript"), argv);
  if (result.status !== 0) {
    return { ok: false, ...classifyOsaFailure(result.stderr, "Spotify") };
  }

  const [action, state = "", track = "", artist = ""] = result.stdout.trim().split("\t");
  return {
    ok: true,
    tool: "spotify_control",
    action: action ?? args.action,
    state,
    playing: state === "playing",
    track: track || null,
    artist: artist || null,
    ...(uri ? { uri } : {}),
  };
}
