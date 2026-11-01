/**
 * macOS integration tests (Spotlight / Contacts / Spotify).
 *
 * The real `mdfind` and `osascript` are replaced with fakes on a temporary path
 * (JARVIS_MDFIND_BIN / JARVIS_OSASCRIPT_BIN), so these run headless, touch no
 * real index, contact book or player, and never prompt for permission.
 *
 * What is pinned: arguments travel as argv (a hostile query stays one
 * argument), output is parsed correctly, and a macOS refusal is reported as a
 * structured `automation_denied` instead of a generic failure.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  contactsSearch,
  MDFIND_BIN_ENV,
  normalizeSpotifyUri,
  OSASCRIPT_BIN_ENV,
  spotlightSearch,
  spotifyControl,
  spotifyStatus,
} from "./mac";
import { TOOLS } from "../server";
import { validateToolArgs } from "../validate";
import { TOOL_TIERS } from "../../src/lib/tool-tiers";
import { checkPermission, toolPermissionCategory } from "../../src/lib/guardrails";

let dir: string;
let argFile: string;

function fake(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

const recordArgs = `printf '%s\\n' "$@" > "$JARVIS_TEST_ARGFILE"\n`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-mac-test-"));
  argFile = join(dir, "args.txt");
  process.env["JARVIS_TEST_ARGFILE"] = argFile;
});

afterAll(() => {
  delete process.env["JARVIS_TEST_ARGFILE"];
  delete process.env[MDFIND_BIN_ENV];
  delete process.env[OSASCRIPT_BIN_ENV];
  rmSync(dir, { recursive: true, force: true });
});

describe("spotlight_search", () => {
  it("passes the query as one argv element and lists results", async () => {
    const bin = fake(
      "mdfind-ok",
      `#!/bin/bash\n${recordArgs}printf '/Users/x/notes.md\\n/Users/x/plan.txt\\n/Users/x/third.md\\n'\n`,
    );
    process.env[MDFIND_BIN_ENV] = bin;

    const hostile = 'invoice"; rm -rf /tmp/should-not-exist; echo "';
    const result = (await spotlightSearch({ query: hostile, maxResults: 2 })) as Record<
      string,
      unknown
    >;

    expect(result["ok"]).toBe(true);
    expect(result["total"]).toBe(3);
    expect(result["results"]).toEqual(["/Users/x/notes.md", "/Users/x/plan.txt"]);

    // One argv element: the whole hostile string, untouched.
    const recorded = readFileSync(argFile, "utf8").split("\n").filter(Boolean);
    expect(recorded).toEqual([hostile]);
  });

  it("scopes to a folder when asked", async () => {
    const bin = fake("mdfind-scope", `#!/bin/bash\n${recordArgs}printf '/Users/x/a.md\\n'\n`);
    process.env[MDFIND_BIN_ENV] = bin;
    await spotlightSearch({ query: "budget", path: "/Users/x" });
    const recorded = readFileSync(argFile, "utf8").split("\n").filter(Boolean);
    expect(recorded).toEqual(["-onlyin", "/Users/x", "budget"]);
  });

  it("refuses an empty query without spawning anything", async () => {
    const result = (await spotlightSearch({ query: "   " })) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["code"]).toBe("usage");
  });

  it("reports a broken index as spotlight_denied", async () => {
    process.env[MDFIND_BIN_ENV] = fake(
      "mdfind-fail",
      `#!/bin/bash\necho "Index is disabled" >&2\nexit 1\n`,
    );
    const result = (await spotlightSearch({ query: "anything" })) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["code"]).toBe("spotlight_denied");
  });
});

describe("contacts_search", () => {
  it("parses name, email and phone", async () => {
    process.env[OSASCRIPT_BIN_ENV] = fake(
      "osa-contacts",
      `#!/bin/bash\n${recordArgs}printf 'Ada Lovelace\\tada@example.com\\t+27 555 1234\\n'\n`,
    );
    const result = (await contactsSearch({ query: "ada" })) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["contacts"]).toEqual([
      { name: "Ada Lovelace", email: "ada@example.com", phone: "+27 555 1234" },
    ]);
    // The script is argv[1], the query is argv[2].
    const recorded = readFileSync(argFile, "utf8").split("\n").filter(Boolean);
    expect(recorded[0]).toBe("-e");
    expect(recorded[recorded.length - 1]).toBe("ada");
  });

  it("turns a macOS refusal into automation_denied with the fix", async () => {
    process.env[OSASCRIPT_BIN_ENV] = fake(
      "osa-denied",
      `#!/bin/bash\necho 'execution error: Not authorized to send Apple events to Contacts. (-1743)' >&2\nexit 1\n`,
    );
    const result = (await contactsSearch({ query: "ada" })) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["code"]).toBe("automation_denied");
    expect(String(result["error"])).toContain("Automation");
  });

  it("reports an empty result honestly", async () => {
    process.env[OSASCRIPT_BIN_ENV] = fake("osa-empty", `#!/bin/bash\nexit 0\n`);
    const result = (await contactsSearch({ query: "nobody" })) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["count"]).toBe(0);
    expect(String(result["note"])).toContain("No contact");
  });
});

describe("spotify_control", () => {
  it("returns the new state and track", async () => {
    process.env[OSASCRIPT_BIN_ENV] = fake(
      "osa-spotify",
      `#!/bin/bash\n${recordArgs}printf 'playpause\\tplaying\\tClair de Lune\\tDebussy\\n'\n`,
    );
    const result = (await spotifyControl({ action: "playpause" })) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["state"]).toBe("playing");
    expect(result["track"]).toBe("Clair de Lune");
  });

  it("sets the volume through argv, not interpolation", async () => {
    process.env[OSASCRIPT_BIN_ENV] = fake(
      "osa-spotify-vol",
      `#!/bin/bash\n${recordArgs}printf 'volume\\tplaying\\tX\\tY\\n'\n`,
    );
    await spotifyControl({ action: "volume", volume: 35 });
    const recorded = readFileSync(argFile, "utf8").split("\n").filter(Boolean);
    expect(recorded[recorded.length - 1]).toBe("35");
  });

  it("rejects bad actions and volumes before spawning", async () => {
    const bad = (await spotifyControl({ action: "shuffle" as never })) as Record<string, unknown>;
    expect(bad["code"]).toBe("usage");
    const badVolume = (await spotifyControl({ action: "volume" })) as Record<string, unknown>;
    expect(badVolume["code"]).toBe("usage");
    const outOfRange = (await spotifyControl({ action: "volume", volume: 140 })) as Record<
      string,
      unknown
    >;
    expect(outOfRange["code"]).toBe("usage");
  });

  it("says so when Spotify is not open", async () => {
    process.env[OSASCRIPT_BIN_ENV] = fake(
      "osa-spotify-closed",
      `#!/bin/bash\necho 'Application isn\\'t running. (-600)' >&2\nexit 1\n`,
    );
    const result = (await spotifyControl({ action: "next" })) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["code"]).toBe("app_not_running");
  });
});

describe("spotify_status", () => {
  it("reads state, track and artist without acting", async () => {
    process.env[OSASCRIPT_BIN_ENV] = fake(
      "osa-spotify-status",
      `#!/bin/bash\n${recordArgs}printf 'status\\tplaying\\tPunchiri\\tJob Kurian\\n'\n`,
    );
    const result = (await spotifyStatus()) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["playing"]).toBe(true);
    expect(result["track"]).toBe("Punchiri");
    expect(result["artist"]).toBe("Job Kurian");
  });

  it("reports a paused player as not playing", async () => {
    process.env[OSASCRIPT_BIN_ENV] = fake(
      "osa-spotify-paused",
      `#!/bin/bash\nprintf 'status\\tpaused\\tX\\tY\\n'\n`,
    );
    const result = (await spotifyStatus()) as Record<string, unknown>;
    expect(result["playing"]).toBe(false);
  });
});

describe("spotify track URIs", () => {
  const id = "4cOdK2wGLETKBW3PvgPWqT";

  it("accepts a URI or a bare id and normalises both", () => {
    expect(normalizeSpotifyUri(`spotify:track:${id}`)).toBe(`spotify:track:${id}`);
    expect(normalizeSpotifyUri(id)).toBe(`spotify:track:${id}`);
  });

  it("refuses anything that is not a track id", () => {
    for (const bad of ["", "not-a-uri", "spotify:album:abc", `spotify:track:${id} & quit`]) {
      expect(normalizeSpotifyUri(bad)).toBeNull();
    }
  });

  it("passes the URI as its own command-line argument", async () => {
    process.env[OSASCRIPT_BIN_ENV] = fake(
      "osa-spotify-play",
      `#!/bin/bash\n${recordArgs}printf 'playuri\\tplaying\\tX\\tY\\n'\n`,
    );
    const result = (await spotifyControl({ action: "playuri", uri: id })) as Record<
      string,
      unknown
    >;
    expect(result["ok"]).toBe(true);
    const recorded = readFileSync(argFile, "utf8").split("\n").filter(Boolean);
    expect(recorded[recorded.length - 1]).toBe(`spotify:track:${id}`);
  });

  it("strips the scheme for a queue request (Spotify's open location)", async () => {
    process.env[OSASCRIPT_BIN_ENV] = fake(
      "osa-spotify-queue",
      `#!/bin/bash\n${recordArgs}printf 'queue\\tplaying\\tX\\tY\\n'\n`,
    );
    await spotifyControl({ action: "queue", uri: `spotify:track:${id}` });
    const recorded = readFileSync(argFile, "utf8").split("\n").filter(Boolean);
    expect(recorded[recorded.length - 1]).toBe(id);
  });

  it("refuses a missing or malformed URI before spawning osascript", async () => {
    const missing = (await spotifyControl({ action: "playuri" })) as Record<string, unknown>;
    expect(missing["code"]).toBe("usage");
    const bad = (await spotifyControl({ action: "playuri", uri: "x" })) as Record<string, unknown>;
    expect(bad["code"]).toBe("usage");
  });
});

describe("registration and tiers", () => {
  it("has a handler and an argument spec for each tool", () => {
    for (const tool of [
      "spotlight_search",
      "contacts_search",
      "spotify_status",
      "spotify_control",
    ]) {
      expect(typeof TOOLS[tool], tool).toBe("function");
    }
    expect(validateToolArgs("spotlight_search", { query: "x" }).ok).toBe(true);
    expect(validateToolArgs("spotlight_search", { query: "x", maxResults: 0 }).ok).toBe(false);
    expect(validateToolArgs("contacts_search", { query: "x", extra: 1 }).ok).toBe(false);
    expect(validateToolArgs("spotify_status", {}).ok).toBe(true);
    expect(validateToolArgs("spotify_status", { extra: 1 }).ok).toBe(false);
    expect(validateToolArgs("spotify_control", { action: "shuffle" }).ok).toBe(false);
    expect(validateToolArgs("spotify_control", { action: "volume", volume: 101 }).ok).toBe(false);
    expect(validateToolArgs("spotify_control", { action: "playuri", uri: "nope" }).ok).toBe(false);
  });

  it("agrees with both permission tables", () => {
    expect(TOOL_TIERS["spotlight_search"]).toBe("auto");
    expect(TOOL_TIERS["contacts_search"]).toBe("auto");
    expect(TOOL_TIERS["spotify_status"]).toBe("auto");
    expect(TOOL_TIERS["spotify_control"]).toBe("confirm");
    for (const [tool, expected] of [
      ["spotlight_search", "auto"],
      ["contacts_search", "auto"],
      ["spotify_status", "auto"],
      ["spotify_control", "confirm"],
    ] as const) {
      const category = toolPermissionCategory(tool);
      expect(category).not.toBe(tool);
      expect(checkPermission(category).permission).toBe(expected);
    }
  });
});
