/**
 * Workspace boundary enforcement for the coding agent.
 *
 * Every path the agent touches is resolved against an allowed workspace root
 * and screened against traversal, secret files, and dependency/build noise.
 * Repository content (README, source, tool output) is DATA — it can never
 * grant permissions; permission comes only from guardrails.checkPermission.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** Directories that are never worth reading or writing as project source. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".output",
  ".nitro",
  ".vinxi",
  ".tanstack",
  ".wrangler",
  ".xtts-venv",
  "__pycache__",
  ".venv",
  "venv",
  "models",
  "logs",
  ".DS_Store",
]);

/** Files that must never be read or written by the agent (secrets/state). */
const SENSITIVE_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".agent-secret",
  "agent-token",
  "voice_sample.wav",
  // Credential stores — these routinely hold live tokens and are as sensitive
  // as .env even though they aren't named `.env*`:
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".pypirc",
  ".pgpass",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  ".bash_history",
  ".zsh_history",
]);

/**
 * `.git/config` can embed a token in the remote URL. It is blocked by path
 * (not by a bare `config` basename, which would over-block legitimate source
 * files); the git_status / git_diff / git_log tools cover real git needs
 * without reading this file directly.
 */
function isSensitiveGitConfig(relPath: string): boolean {
  const parts = relPath.split(path.sep).filter(Boolean);
  return parts[0] === ".git" && parts[parts.length - 1] === "config";
}

/** Secret-looking content patterns — used to refuse storing memory entries. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgho_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  // Assignment-shaped: value must be ≥12 chars (quoted or bare) so prose
  // like "password: see the vault" never trips it.
  /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*(?:["'][^"'\s]{12,}["']|[^\s"']{12,})/i,
];

export interface WorkspacePolicy {
  /** Absolute path of the workspace root the agent operates in. */
  root: string;
}

export class WorkspaceViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceViolation";
  }
}

/**
 * Normalize the workspace root. Must exist and be a directory.
 */
export async function createWorkspace(root: string): Promise<WorkspacePolicy> {
  const abs = path.resolve(root);
  const stat = await fs.stat(abs);
  if (!stat.isDirectory()) {
    throw new WorkspaceViolation(`Workspace root is not a directory: ${abs}`);
  }
  return { root: abs };
}

function isIgnoredSegment(seg: string): boolean {
  return IGNORED_DIRS.has(seg);
}

/**
 * Resolve a user/agent-supplied path inside the workspace.
 * Throws WorkspaceViolation on traversal outside root, on symlink escapes,
 * and (for `mode: "write"`) on sensitive files.
 */
export async function resolveWorkspacePath(
  policy: WorkspacePolicy,
  userPath: string,
  mode: "read" | "write" = "read",
): Promise<string> {
  if (typeof userPath !== "string" || userPath.trim() === "") {
    throw new WorkspaceViolation("Path must be a non-empty string");
  }
  if (userPath.includes("\0")) {
    throw new WorkspaceViolation("Path contains NUL byte");
  }

  // "~" resolves to the workspace root only — the agent never roams the
  // home directory unless the workspace itself IS the home directory.
  const expanded = userPath === "~" ? policy.root : userPath;
  const abs = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(policy.root, expanded);

  const rootWithSep = policy.root.endsWith(path.sep) ? policy.root : policy.root + path.sep;
  if (abs !== policy.root && !abs.startsWith(rootWithSep)) {
    throw new WorkspaceViolation(`Path escapes the workspace: ${userPath} resolves to ${abs}`);
  }

  // Segment-level screen for secret files anywhere in the relative path.
  const rel = path.relative(policy.root, abs);
  const segments = rel.split(path.sep).filter(Boolean);
  const base = segments[segments.length - 1] ?? "";
  if (SENSITIVE_FILES.has(base) || /^\.env\./.test(base) || isSensitiveGitConfig(rel)) {
    throw new WorkspaceViolation(`Sensitive file is off-limits: ${base}`);
  }
  if (mode === "write" && segments.some(isIgnoredSegment)) {
    throw new WorkspaceViolation(`Refusing to write inside a dependency/build directory: ${rel}`);
  }

  // Symlink escape check: resolve the deepest existing ancestor.
  try {
    const real = await fs.realpath(abs);
    const realRoot = await fs.realpath(policy.root);
    const realRootSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (real !== realRoot && !real.startsWith(realRootSep)) {
      throw new WorkspaceViolation(`Path resolves outside the workspace via symlink: ${userPath}`);
    }
  } catch (err) {
    if (err instanceof WorkspaceViolation) throw err;
    // ENOENT — target does not exist yet: fine for writes. Its parent's
    // realpath was already validated if it exists; validate parent now.
    const parent = path.dirname(abs);
    try {
      const realParent = await fs.realpath(parent);
      const realRoot = await fs.realpath(policy.root);
      const realRootSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
      if (realParent !== realRoot && !realParent.startsWith(realRootSep)) {
        throw new WorkspaceViolation(`Parent resolves outside the workspace: ${userPath}`);
      }
    } catch (parentErr) {
      if (parentErr instanceof WorkspaceViolation) throw parentErr;
      // Parent missing too — still inside root by lexical check above.
    }
  }

  return abs;
}

/** True if this relative path sits inside a dependency/build directory. */
export function isIgnoredPath(relPath: string): boolean {
  return relPath.split(path.sep).filter(Boolean).some(isIgnoredSegment);
}

/** True when a file name looks like secrets/env config. */
export function isSensitivePath(absPath: string): boolean {
  const base = path.basename(absPath);
  if (SENSITIVE_FILES.has(base) || /^\.env\./.test(base) || base === ".env") {
    return true;
  }
  const parts = absPath.split(path.sep).filter(Boolean);
  return parts.includes(".git") && base === "config" && parts[parts.length - 2] === ".git";
}

/** Heuristic secret detection for content about to be persisted (memory). */
export function looksLikeSecret(content: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(content));
}

/** Standard truncation helper — keeps tool outputs bounded for the model. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}
