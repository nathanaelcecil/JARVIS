/**
 * Per-tool argument validation for the local agent.
 *
 * The local agent is a privileged process: its tools open apps, write files and
 * run shell commands. Model output is untrusted, so every argument is checked
 * against an explicit table BEFORE a handler is invoked. Unknown keys are
 * rejected too — silently ignoring extra keys is how a typo becomes a silently
 * different action.
 *
 * This is argument hygiene, not authorization. Approval-token enforcement
 * (../src/lib/approval-token.ts) is the boundary for confirm-tier tools.
 */

export type FieldKind = "string" | "number" | "boolean" | "string[]" | "formFields" | "point";

export type FieldFormat = "app-name" | "path" | "command" | "text" | "url" | "label";

export interface FieldSpec {
  kind: FieldKind;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  format?: FieldFormat;
  maxItems?: number;
  enum?: readonly string[];
  pattern?: RegExp;
  patternHint?: string;
}

export interface ToolArgSpec {
  args: Record<string, FieldSpec>;
}

/** C0 controls + DEL. Checked by code point, not a regex, so the intent is explicit. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Characters that make an app name dangerous when handed to a process or a script. */
const APP_NAME_FORBIDDEN = /["'`$;|&<>\\]/;

const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;
const GITHUB_REF = /^[A-Za-z0-9._\-/]+$/;

/**
 * Key chords ("cmd+shift+t"). The helper has its own fixed key table and
 * rejects unknown names; this pattern only keeps the argument well-formed so a
 * malformed chord fails before a process is spawned.
 */
const KEY_CHORD = /^[A-Za-z0-9`\-=[\]\\;',./]+(?:\+[A-Za-z0-9`\-=[\]\\;',./]+)*$/;
/** Accessibility roles, e.g. AXButton. Never free text. */
const AX_ROLE = /^AX[A-Za-z]{1,48}$/;
/** Menu paths: "File>Export>PDF", 1-6 segments. */
const MENU_PATH = /^[^<>]{1,80}(?:>[^<>]{1,80}){0,5}$/;

function text(maxLength: number, required = true, format: FieldFormat = "text"): FieldSpec {
  return { kind: "string", required, minLength: required ? 1 : 0, maxLength, format };
}
/** Optional string: absent is fine, but if present it must be non-empty. */
function optText(maxLength: number, format: FieldFormat = "text"): FieldSpec {
  return { kind: "string", required: false, minLength: 1, maxLength, format };
}
function num(min: number, max: number, required = true, integer = false): FieldSpec {
  return { kind: "number", required, min, max, integer };
}
function bool(required = false): FieldSpec {
  return { kind: "boolean", required };
}
/** A screen point: exactly { x, y } in global top-left coordinates. */
function point(required = true): FieldSpec {
  return { kind: "point", required, min: -10_000, max: 40_000, integer: true };
}
/** GitHub owner/repo names: no spaces, no shell metacharacters. */
function ghName(): FieldSpec {
  return {
    kind: "string",
    required: true,
    minLength: 1,
    maxLength: 100,
    pattern: GITHUB_NAME,
    patternHint: "letters, digits, dot, dash, underscore",
  };
}
/** Git refs/branches: additionally allow "/". */
function ghRef(required = true): FieldSpec {
  return {
    kind: "string",
    required,
    minLength: 1,
    maxLength: 200,
    pattern: GITHUB_REF,
    patternHint: "letters, digits, dot, dash, underscore, slash",
  };
}

const NO_ARGS: ToolArgSpec = { args: {} };

/**
 * The single source of truth for what a tool may receive. Every entry in the
 * TOOLS map of server.ts must appear here; server.ts refuses to start otherwise
 * (see assertToolSpecsCoverTools).
 */
export const TOOL_ARG_SPECS: Record<string, ToolArgSpec> = {
  // ── Filesystem ──
  list_directory: { args: { path: text(4096, true, "path") } },
  search_files: {
    args: {
      path: text(4096, true, "path"),
      pattern: text(256),
      maxResults: num(1, 500, false, true),
    },
  },
  open_in_finder: { args: { path: text(4096, true, "path") } },
  get_file_metadata: { args: { path: text(4096, true, "path") } },

  // ── Desktop ──
  open_app: { args: { name: text(100, true, "app-name") } },
  quit_app: { args: { name: text(100, true, "app-name") } },
  list_running_apps: NO_ARGS,

  // ── Hands v1 (read-only observation) ──
  // pid/index are numbers, so they can never carry shell syntax; the window
  // index is range-checked because the helper rejects out-of-range indices.
  hands_list_windows: NO_ARGS,
  hands_read_window: {
    args: {
      pid: num(1, 4_194_304, true, true),
      windowIndex: num(0, 500, false, true),
    },
  },
  hands_read_focused: NO_ARGS,
  hands_status: NO_ARGS,
  // Screenshot + OCR. `path` never reaches OCR: handsOcr refuses anything
  // outside its own screenshot directory.
  hands_look: {
    args: {
      display: num(0, 15, false, true),
      pid: num(1, 4_194_304, false, true),
      windowIndex: num(0, 500, false, true),
    },
  },
  hands_read_screen: {
    args: { pid: num(1, 4_194_304, true, true), windowIndex: num(0, 500, false, true) },
  },

  // ── Hands v2 (computer control; confirm tier, never auto) ──
  // Numbers and enumerated strings only where possible: a control argument can
  // never carry shell syntax. The helper additionally refuses to guess.
  control_click: {
    args: {
      pid: num(1, 4_194_304, true, true),
      label: optText(200, "label"),
      role: {
        kind: "string",
        required: false,
        minLength: 1,
        maxLength: 64,
        pattern: AX_ROLE,
        patternHint: "an AX role such as AXButton",
      },
      near: optText(200, "label"),
      x: num(-10_000, 40_000, false, true),
      y: num(-10_000, 40_000, false, true),
      double: bool(),
      right: bool(),
      windowIndex: num(0, 500, false, true),
      global: bool(),
      verify: bool(),
    },
  },
  control_type: {
    args: {
      text: text(4000),
      pid: num(1, 4_194_304, false, true),
      label: optText(200, "label"),
      role: {
        kind: "string",
        required: false,
        minLength: 1,
        maxLength: 64,
        pattern: AX_ROLE,
        patternHint: "an AX role such as AXTextField",
      },
      windowIndex: num(0, 500, false, true),
      submit: bool(),
      global: bool(),
      verify: bool(),
    },
  },
  control_key: {
    args: {
      combo: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 40,
        pattern: KEY_CHORD,
        patternHint: 'key names joined by +, e.g. "cmd+shift+t"',
      },
      times: num(1, 10, false, true),
      pid: num(1, 4_194_304, false, true),
      global: bool(),
      verify: bool(),
    },
  },
  control_scroll: {
    args: {
      dy: num(-20_000, 20_000, false, true),
      dx: num(-20_000, 20_000, false, true),
      pid: num(1, 4_194_304, false, true),
      x: num(-10_000, 40_000, false, true),
      y: num(-10_000, 40_000, false, true),
      global: bool(),
    },
  },
  control_drag: {
    args: {
      from: point(),
      to: point(),
      pid: num(1, 4_194_304, false, true),
      global: bool(),
    },
  },
  control_menu: {
    args: {
      pid: num(1, 4_194_304, true, true),
      path: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 400,
        pattern: MENU_PATH,
        patternHint: 'menu titles joined by >, e.g. "File>Export>PDF"',
      },
      verify: bool(),
    },
  },
  control_place: {
    args: {
      pid: num(1, 4_194_304, true, true),
      where: {
        kind: "string",
        required: true,
        enum: ["left", "right", "full", "fullscreen", "center"] as const,
      },
      screen: num(0, 15, false, true),
      windowIndex: num(0, 500, false, true),
    },
  },
  control_focus: {
    args: { pid: num(1, 4_194_304, true, true), title: optText(200, "label") },
  },
  control_map: {
    args: { pid: num(1, 4_194_304, true, true), windowIndex: num(0, 500, false, true) },
  },
  control_status: NO_ARGS,

  // ── macOS integrations ──
  spotlight_search: {
    args: {
      query: text(200),
      path: optText(4096, "path"),
      maxResults: num(1, 100, false, true),
    },
  },
  contacts_search: { args: { query: text(200), maxResults: num(1, 25, false, true) } },
  spotify_control: {
    args: {
      action: {
        kind: "string",
        required: true,
        enum: [
          "playpause",
          "next",
          "previous",
          "play",
          "pause",
          "volume",
          "playuri",
          "queue",
        ] as const,
      },
      volume: num(0, 100, false, true),
      // Shape-checked here and normalised again in the tool, so an AppleScript
      // statement can never be smuggled in through a URI.
      uri: {
        kind: "string",
        required: false,
        minLength: 22,
        maxLength: 64,
        pattern: /^(spotify:track:)?[A-Za-z0-9]{22}$/,
        patternHint: "spotify:track:<22 character id> or the bare id",
      },
    },
  },
  spotify_status: NO_ARGS,

  // ── System ──
  get_volume: NO_ARGS,
  set_volume: { args: { level: num(0, 100) } },
  get_brightness: NO_ARGS,
  get_battery: NO_ARGS,
  get_ram: NO_ARGS,
  get_storage: NO_ARGS,

  // ── Terminal ──
  run_command: {
    args: {
      command: text(8192, true, "command"),
      cwd: optText(4096, "path"),
      timeout: num(1, 300_000, false, true),
      // The coding agent's prompt spells this `timeoutMs`; accept both so a
      // model-emitted alias cannot become a 400.
      timeoutMs: num(1, 300_000, false, true),
    },
  },
  classify_command: { args: { command: text(8192, true, "command") } },

  // ── Proactive ──
  run_background: {
    args: {
      command: text(8192, true, "command"),
      cwd: optText(4096, "path"),
      label: optText(200, "label"),
    },
  },
  get_job: { args: { jobId: text(200) } },
  list_jobs: NO_ARGS,
  notify: { args: { message: text(2000), title: optText(200, "label") } },

  // ── GitHub ──
  gh_list_repos: {
    args: {
      owner: { ...ghName(), required: false },
      type: { kind: "string", required: false, enum: ["all", "owner", "member"] },
      sort: {
        kind: "string",
        required: false,
        enum: ["created", "updated", "pushed", "full_name"],
      },
      per_page: num(1, 100, false, true),
    },
  },
  gh_get_file: {
    args: { owner: ghName(), repo: ghName(), path: text(1024), ref: { ...ghRef(false) } },
  },
  gh_list_issues: {
    args: {
      owner: ghName(),
      repo: ghName(),
      state: { kind: "string", required: false, enum: ["open", "closed", "all"] },
      per_page: num(1, 100, false, true),
    },
  },
  gh_list_prs: {
    args: {
      owner: ghName(),
      repo: ghName(),
      state: { kind: "string", required: false, enum: ["open", "closed", "all"] },
      per_page: num(1, 100, false, true),
    },
  },
  gh_list_runs: {
    args: { owner: ghName(), repo: ghName(), per_page: num(1, 100, false, true) },
  },
  gh_run_logs: {
    args: { owner: ghName(), repo: ghName(), run_id: num(1, Number.MAX_SAFE_INTEGER) },
  },
  gh_get_diff: {
    args: { owner: ghName(), repo: ghName(), base: ghRef(), head: ghRef() },
  },
  gh_create_branch: {
    args: { owner: ghName(), repo: ghName(), branch: ghRef(), from: { ...ghRef(false) } },
  },
  gh_create_file: {
    args: {
      owner: ghName(),
      repo: ghName(),
      path: text(1024),
      message: text(2000),
      content: text(2_000_000),
      branch: { ...ghRef(false) },
      sha: optText(200),
    },
  },
  gh_create_issue: {
    args: {
      owner: ghName(),
      repo: ghName(),
      title: text(500),
      body: optText(50_000),
      labels: { kind: "string[]", required: false, maxItems: 20, maxLength: 100 },
    },
  },
  gh_create_pr: {
    args: {
      owner: ghName(),
      repo: ghName(),
      title: text(500),
      body: optText(50_000),
      head: ghRef(),
      base: { ...ghRef(false) },
    },
  },
  gh_create_comment: {
    args: {
      owner: ghName(),
      repo: ghName(),
      issue_number: num(1, Number.MAX_SAFE_INTEGER),
      body: text(50_000),
    },
  },

  // ── Browser ──
  browser_navigate: {
    args: { url: text(2048, true, "url"), waitFor: num(0, 60_000, false, true) },
  },
  browser_extract: { args: { url: optText(2048, "url") } },
  browser_screenshot: {
    args: { path: optText(4096, "path"), fullPage: bool() },
  },
  browser_click: {
    args: { selector: text(1000), timeout: num(0, 60_000, false, true) },
  },
  browser_type: {
    args: {
      selector: text(1000),
      text: text(10_000),
      clear: bool(),
      pressEnter: bool(),
    },
  },
  browser_fill_form: {
    args: {
      fields: { kind: "formFields", required: true, maxItems: 50, maxLength: 1000 },
      submitSelector: optText(1000),
    },
  },
  browser_download: { args: { url: text(2048, true, "url"), destination: optText(4096, "path") } },
  browser_close: NO_ARGS,
};

export interface ValidationFailure {
  error: "invalid_arguments";
  message: string;
  /** Field name only — never echo the offending value back (it may be a secret). */
  field?: string;
}

export type ValidationResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; failure: ValidationFailure };

function fail(field: string | undefined, message: string): ValidationResult {
  const failure: ValidationFailure = { error: "invalid_arguments", message };
  if (field !== undefined) failure.field = field;
  return { ok: false, failure };
}

/**
 * Shared app-target rules. Desktop tools and the Hands helper both accept an
 * app name or bundle id — never an arbitrary executable path.
 */
export function validateAppName(value: string): { ok: true } | { ok: false; message: string } {
  if (value.length === 0) return { ok: false, message: "app name must not be empty" };
  if (value.length > 100) return { ok: false, message: "app name is too long (max 100)" };
  if (hasControlChars(value) || APP_NAME_FORBIDDEN.test(value)) {
    return { ok: false, message: "app name contains a forbidden character" };
  }
  if (value.startsWith("-")) {
    return { ok: false, message: "app name must not start with '-' (option injection)" };
  }
  if (value.trim() !== value) {
    return { ok: false, message: "app name must not have leading or trailing whitespace" };
  }
  // A bare name/bundle id is fine ("com.apple.Safari" contains ".app" inside
  // ".apple", so never guess from a substring). Path-like values must be a
  // .app bundle; containment is enforced by the desktop tool.
  if (value.includes("/") && !value.endsWith(".app")) {
    return { ok: false, message: "path-like app values must end with .app" };
  }
  return { ok: true };
}

function checkString(field: string, value: string, spec: FieldSpec): ValidationResult | null {
  const min = spec.minLength ?? 0;
  const max = spec.maxLength ?? 10_000;
  if (value.length < min) return fail(field, `${field} is too short`);
  if (value.length > max) return fail(field, `${field} is too long (max ${max})`);

  const format = spec.format ?? "text";
  switch (format) {
    case "app-name": {
      const result = validateAppName(value);
      if (!result.ok) return fail(field, `${field}: ${result.message}`);
      return null;
    }
    case "path":
      if (hasControlChars(value)) return fail(field, `${field} contains control characters`);
      return null;
    case "command":
      // Newlines are legitimate in a multi-line command; NUL never is.
      if (value.includes("\u0000")) return fail(field, `${field} contains a NUL byte`);
      return null;
    case "url": {
      if (hasControlChars(value)) return fail(field, `${field} contains control characters`);
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return fail(field, `${field} is not a valid URL`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return fail(field, `${field} must be an http(s) URL`);
      }
      return null;
    }
    case "label":
      if (hasControlChars(value)) return fail(field, `${field} contains control characters`);
      return null;
    case "text":
    default:
      if (value.includes("\u0000")) return fail(field, `${field} contains a NUL byte`);
      return null;
  }
}

function checkValue(field: string, value: unknown, spec: FieldSpec): ValidationResult | null {
  switch (spec.kind) {
    case "string": {
      if (typeof value !== "string") return fail(field, `${field} must be a string`);
      if (spec.enum && !spec.enum.includes(value)) {
        return fail(field, `${field} must be one of: ${spec.enum.join(", ")}`);
      }
      if (spec.pattern && !spec.pattern.test(value)) {
        return fail(
          field,
          `${field} is malformed${spec.patternHint ? ` (${spec.patternHint})` : ""}`,
        );
      }
      return checkString(field, value, spec);
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return fail(field, `${field} must be a finite number`);
      }
      if (spec.integer && !Number.isInteger(value)) {
        return fail(field, `${field} must be an integer`);
      }
      const min = spec.min ?? Number.NEGATIVE_INFINITY;
      const max = spec.max ?? Number.POSITIVE_INFINITY;
      if (value < min || value > max) {
        return fail(field, `${field} must be between ${min} and ${max}`);
      }
      return null;
    }
    case "boolean":
      if (typeof value !== "boolean") return fail(field, `${field} must be a boolean`);
      return null;
    case "string[]": {
      if (!Array.isArray(value)) return fail(field, `${field} must be an array`);
      if (value.length > (spec.maxItems ?? 100)) {
        return fail(field, `${field} has too many items (max ${spec.maxItems ?? 100})`);
      }
      const maxLength = spec.maxLength ?? 200;
      for (const item of value) {
        if (typeof item !== "string") return fail(field, `${field} items must be strings`);
        if (item.length === 0 || item.length > maxLength) {
          return fail(field, `${field} items must be 1-${maxLength} characters`);
        }
      }
      return null;
    }
    case "point": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return fail(field, `${field} must be an object with x and y`);
      }
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key !== "x" && key !== "y") {
          return fail(field, `${field} may only contain x and y`);
        }
      }
      const min = spec.min ?? -10_000;
      const max = spec.max ?? 40_000;
      for (const axis of ["x", "y"] as const) {
        const coordinate = record[axis];
        if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
          return fail(field, `${field}.${axis} must be a finite number`);
        }
        if (spec.integer && !Number.isInteger(coordinate)) {
          return fail(field, `${field}.${axis} must be an integer`);
        }
        if (coordinate < min || coordinate > max) {
          return fail(field, `${field}.${axis} must be between ${min} and ${max}`);
        }
      }
      return null;
    }
    case "formFields": {
      if (!Array.isArray(value)) return fail(field, `${field} must be an array`);
      if (value.length === 0) return fail(field, `${field} must not be empty`);
      if (value.length > (spec.maxItems ?? 50)) {
        return fail(field, `${field} has too many items (max ${spec.maxItems ?? 50})`);
      }
      const maxLength = spec.maxLength ?? 1000;
      for (const item of value) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          return fail(field, `${field} items must be objects with selector and value`);
        }
        const record = item as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          if (key !== "selector" && key !== "value") {
            return fail(field, `${field} items may only contain selector and value`);
          }
        }
        if (typeof record["selector"] !== "string" || record["selector"].length === 0) {
          return fail(field, `${field} items need a selector string`);
        }
        if (typeof record["value"] !== "string") {
          return fail(field, `${field} items need a value string`);
        }
        if (
          (record["selector"] as string).length > maxLength ||
          (record["value"] as string).length > maxLength
        ) {
          return fail(field, `${field} items exceed ${maxLength} characters`);
        }
        if ((record["value"] as string).includes("\u0000")) {
          return fail(field, `${field} items contain a NUL byte`);
        }
      }
      return null;
    }
    default:
      return fail(field, `${field} has an unknown validation kind`);
  }
}

/**
 * Validate a tool call. Returns the original args object on success so callers
 * execute exactly what was validated (no normalization, no coercion).
 */
export function validateToolArgs(tool: string, args: unknown): ValidationResult {
  const spec = TOOL_ARG_SPECS[tool];
  if (!spec) return fail(undefined, `no argument spec registered for tool: ${tool}`);
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) {
    return fail(undefined, "args must be a JSON object");
  }
  const record = args as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(key in spec.args)) return fail(key, `unknown argument: ${key}`);
  }

  for (const [field, fieldSpec] of Object.entries(spec.args)) {
    const value = record[field];
    if (value === undefined || value === null) {
      if (fieldSpec.required) return fail(field, `missing required argument: ${field}`);
      continue;
    }
    const problem = checkValue(field, value, fieldSpec);
    if (problem) return problem;
  }

  // Guard against prototype-pollution style payloads that JSON.parse can emit.
  if (
    Object.getPrototypeOf(record) !== Object.prototype &&
    Object.getPrototypeOf(record) !== null
  ) {
    return fail(undefined, "args must be a plain object");
  }

  return { ok: true, value: record };
}

/**
 * Startup self-check: every configured tool must have a spec. With
 * `requireAll` (the real built-in table), specs for tools that no longer exist
 * are an error too.
 */
export function assertToolSpecsCoverTools(
  toolNames: string[],
  options: { requireAll?: boolean } = {},
): void {
  const missing = toolNames.filter((name) => !(name in TOOL_ARG_SPECS));
  const extra = options.requireAll
    ? Object.keys(TOOL_ARG_SPECS).filter((name) => !toolNames.includes(name))
    : [];
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `local-agent argument specs out of sync (missing: ${missing.join(", ") || "none"}; ` +
        `stale: ${extra.join(", ") || "none"})`,
    );
  }
}
