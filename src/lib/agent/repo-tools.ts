/**
 * Repository intelligence tools — exploration, search, git, controlled edits,
 * and project script execution for the JARVIS coding agent.
 *
 * Everything is workspace-bound: paths resolve through resolveWorkspacePath,
 * reads and writes are screened for secrets/dependencies, outputs are bounded
 * so a whole repository never reaches the model in one shot.
 *
 * No new dependencies: walks are Node-only, git/npm run through execFile.
 */

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { isIgnoredPath, resolveWorkspacePath, truncate, type WorkspacePolicy } from "./workspace";

// ── Limits ──────────────────────────────────────────────────
const MAX_FILE_READ_CHARS = 40_000;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILE_BYTES = 1_500_000;
const MAX_TREE_ENTRIES = 400;
const MAX_DIFF_CHARS = 12_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 180_000;

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".sh",
  ".sql",
  ".graphql",
  ".vue",
  ".svelte",
  ".html",
  ".css",
  ".scss",
  ".yml",
  ".yaml",
  ".toml",
  ".txt",
]);

// ── File reading ────────────────────────────────────────────

export interface FileReadResult {
  path: string;
  totalLines: number;
  offset: number;
  lines: string[];
  truncated: boolean;
  sizeBytes: number;
}

export async function readSourceFile(
  policy: WorkspacePolicy,
  args: { path: string; offset?: number; limit?: number },
): Promise<FileReadResult> {
  const abs = await resolveWorkspacePath(policy, args.path, "read");
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new Error(`File not found: ${args.path}`);
  if (stat.isDirectory()) {
    throw new Error(`${args.path} is a directory — use list_repo_tree instead`);
  }
  if (stat.size > MAX_SEARCH_FILE_BYTES * 2) {
    throw new Error(`File too large to read (${stat.size} bytes): ${args.path}`);
  }

  const raw = await fs.readFile(abs, "utf-8");
  const allLines = raw.split("\n");
  const offset = Math.max(1, Math.floor(args.offset ?? 1));
  const limit = Math.max(1, Math.min(1000, Math.floor(args.limit ?? 200)));
  const slice = allLines.slice(offset - 1, offset - 1 + limit);

  return {
    path: path.relative(policy.root, abs),
    totalLines: allLines.length,
    offset,
    lines: slice,
    // More lines remain beyond this window (or the caller's limit cut it).
    truncated: offset - 1 + slice.length < allLines.length,
    sizeBytes: stat.size,
  };
}

// ── Tree ────────────────────────────────────────────────────

export async function listRepoTree(
  policy: WorkspacePolicy,
  args: { path?: string; depth?: number; maxEntries?: number } = {},
): Promise<{ path: string; entries: string[]; truncated: boolean }> {
  const abs = await resolveWorkspacePath(policy, args.path ?? ".", "read");
  const maxDepth = Math.max(1, Math.min(6, Math.floor(args.depth ?? 3)));
  const maxEntries = Math.max(
    1,
    Math.min(MAX_TREE_ENTRIES, Math.floor(args.maxEntries ?? MAX_TREE_ENTRIES)),
  );
  const entries: string[] = [];
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > maxDepth) return;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    const withTypes = await Promise.all(
      names
        .filter((n) => n !== ".DS_Store")
        .map(async (n) => {
          const full = path.join(dir, n);
          try {
            const st = await fs.lstat(full);
            return { n, isDir: st.isDirectory() };
          } catch {
            return { n, isDir: false };
          }
        }),
    );
    // Directories first, then files, each alphabetical.
    withTypes.sort((a, b) => (a.isDir === b.isDir ? a.n.localeCompare(b.n) : a.isDir ? -1 : 1));

    for (const { n, isDir } of withTypes) {
      if (truncated) return;
      const rel = path.relative(policy.root, path.join(dir, n));
      if (isDir && isIgnoredPath(rel + path.sep)) continue;
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      entries.push(`${rel}${isDir ? "/" : ""}`);
      if (isDir) await walk(path.join(dir, n), depth + 1);
    }
  };

  await walk(abs, 1);
  return {
    path: path.relative(policy.root, abs) || ".",
    entries,
    truncated,
  };
}

// ── Content search ──────────────────────────────────────────

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export async function searchRepoContent(
  policy: WorkspacePolicy,
  args: {
    query: string;
    path?: string;
    regex?: boolean;
    caseSensitive?: boolean;
    extensions?: string[];
    maxResults?: number;
  },
): Promise<{ query: string; hits: SearchHit[]; filesScanned: number; truncated: boolean }> {
  if (!args.query || args.query.length === 0) {
    throw new Error("query is required");
  }
  const searchRoot = await resolveWorkspacePath(policy, args.path ?? ".", "read");
  const maxResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(args.maxResults ?? 50)));

  let matcher: RegExp;
  try {
    matcher = new RegExp(
      args.regex ? args.query : args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      args.caseSensitive ? "g" : "gi",
    );
  } catch (err) {
    throw new Error(
      `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const extFilter =
    args.extensions && args.extensions.length > 0
      ? new Set(args.extensions.map((e) => (e.startsWith(".") ? e : `.${e}`)))
      : null;

  const hits: SearchHit[] = [];
  let filesScanned = 0;
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (truncated) return;
      if (name === ".DS_Store") continue;
      const full = path.join(dir, name);
      const rel = path.relative(policy.root, full);
      let st;
      try {
        st = await fs.lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (isIgnoredPath(rel + path.sep)) continue;
        await walk(full);
        continue;
      }
      if (!st.isFile() || st.size > MAX_SEARCH_FILE_BYTES) continue;
      const ext = path.extname(name).toLowerCase();
      if (extFilter && !extFilter.has(ext)) continue;
      if (!extFilter && !SOURCE_EXTENSIONS.has(ext)) continue;

      let content: string;
      try {
        const buf = await fs.readFile(full);
        if (buf.includes(0)) continue; // binary
        content = buf.toString("utf-8");
      } catch {
        continue;
      }
      filesScanned++;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        matcher.lastIndex = 0;
        if (matcher.test(lines[i]!)) {
          hits.push({
            file: rel,
            line: i + 1,
            text: truncate(lines[i]!.trimEnd(), 300),
          });
          if (hits.length >= maxResults) {
            truncated = true;
            return;
          }
        }
      }
    }
  };

  await walk(searchRoot);
  return { query: args.query, hits, filesScanned, truncated };
}

// ── Symbol finding ──────────────────────────────────────────

export async function findSymbols(
  policy: WorkspacePolicy,
  args: { name: string; maxResults?: number },
): Promise<{ name: string; hits: SearchHit[]; truncated: boolean }> {
  if (!args.name) throw new Error("name is required");
  const esc = args.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    `(?:export\\s+)?(?:async\\s+)?function\\s+${esc}\\b`,
    `(?:export\\s+)?class\\s+${esc}\\b`,
    `(?:export\\s+)?interface\\s+${esc}\\b`,
    `(?:export\\s+)?type\\s+${esc}\\b`,
    `(?:export\\s+)?(?:const|let|var)\\s+${esc}\\s*(?::[^=]+)?=`,
    `def\\s+${esc}\\s*\\(`,
    `fn\\s+${esc}\\b`,
  ];
  return searchRepoContent(policy, {
    query: patterns.join("|"),
    regex: true,
    maxResults: args.maxResults ?? 40,
  }).then((r) => ({ name: args.name, hits: r.hits, truncated: r.truncated }));
}

// ── Git ─────────────────────────────────────────────────────

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 20_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1000, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        if (
          err &&
          typeof (err as NodeJS.ErrnoException).code === "string" &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          reject(new Error(`${cmd} is not installed or not on PATH`));
          return;
        }
        const killed = (err as { killed?: boolean } | null)?.killed === true;
        const numeric = (err as { code?: number | string } | null)?.code;
        resolve({
          code: typeof numeric === "number" ? numeric : err ? 1 : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: killed,
        });
      },
    );
  });
}

async function git(
  policy: WorkspacePolicy,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run("git", ["-C", policy.root, ...args], policy.root);
}

export async function gitStatus(
  policy: WorkspacePolicy,
): Promise<{ branch: string; entries: string[]; clean: boolean }> {
  const branch = await git(policy, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.code !== 0) {
    throw new Error(`git rev-parse failed: ${branch.stderr.trim()}`);
  }
  const st = await git(policy, ["status", "--porcelain=v1"]);
  if (st.code !== 0) throw new Error(`git status failed: ${st.stderr.trim()}`);
  const entries = st.stdout.split("\n").filter(Boolean);
  return { branch: branch.stdout.trim(), entries, clean: entries.length === 0 };
}

export async function gitDiff(
  policy: WorkspacePolicy,
  args: { staged?: boolean; path?: string; maxChars?: number } = {},
): Promise<{ staged: boolean; diff: string; truncated: boolean }> {
  const argv = ["diff"];
  if (args.staged) argv.push("--cached");
  if (args.path) {
    const p = await resolveWorkspacePath(policy, args.path, "read");
    argv.push("--", path.relative(policy.root, p));
  }
  const d = await git(policy, argv);
  if (d.code !== 0) throw new Error(`git diff failed: ${d.stderr.trim()}`);
  const max = Math.min(60_000, Math.floor(args.maxChars ?? MAX_DIFF_CHARS));
  return {
    staged: !!args.staged,
    diff: truncate(d.stdout, max),
    truncated: d.stdout.length > max,
  };
}

export async function gitLog(
  policy: WorkspacePolicy,
  args: { limit?: number } = {},
): Promise<{ commits: Array<{ hash: string; subject: string; date: string }> }> {
  const n = Math.max(1, Math.min(50, Math.floor(args.limit ?? 10)));
  const d = await git(policy, ["log", `-n${n}`, "--pretty=format:%h|%s|%ad", "--date=short"]);
  if (d.code !== 0) throw new Error(`git log failed: ${d.stderr.trim()}`);
  const commits = d.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", subject = "", date = ""] = line.split("|");
      return { hash, subject, date };
    });
  return { commits };
}

/** Current diff of specific files relative to before the task started. */
export async function gitDiffWorktree(policy: WorkspacePolicy, fileRel: string): Promise<string> {
  const d = await git(policy, ["diff", "--", fileRel]);
  return d.stdout;
}

// ── Line diff (no dependency) ───────────────────────────────

/**
 * Minimal unified-style diff: common prefix/suffix trimmed, one hunk.
 * Enough for review; not a full LCS line matcher.
 */
export function simpleDiff(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const lines: string[] = [];
  lines.push(`@@ -${start + 1},${endA - start + 1} +${start + 1},${endB - start + 1} @@`);
  for (let i = start; i <= endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i <= endB; i++) lines.push(`+${b[i]}`);
  if (a.length === b.length && lines.length === 1) {
    return "(no textual changes)";
  }
  return truncate(lines.join("\n"), MAX_DIFF_CHARS);
}

// ── Controlled editing ──────────────────────────────────────

export interface FileChange {
  path: string;
  created: boolean;
  diff: string;
  bytesBefore: number;
  bytesAfter: number;
}

export async function writeRepoFile(
  policy: WorkspacePolicy,
  args: { path: string; content: string },
): Promise<FileChange> {
  if (typeof args.content !== "string") {
    throw new Error("content must be a string");
  }
  const abs = await resolveWorkspacePath(policy, args.path, "write");
  const before = await fs.readFile(abs, "utf-8").catch(() => null);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, args.content, "utf-8");
  const rel = path.relative(policy.root, abs);
  return {
    path: rel,
    created: before === null,
    diff:
      before === null
        ? `(new file, ${args.content.length} chars)`
        : simpleDiff(before, args.content),
    bytesBefore: before?.length ?? 0,
    bytesAfter: args.content.length,
  };
}

export async function editRepoFile(
  policy: WorkspacePolicy,
  args: {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  },
): Promise<FileChange & { replacements: number }> {
  if (typeof args.oldString !== "string" || args.oldString === "") {
    throw new Error("oldString is required and must be non-empty");
  }
  if (typeof args.newString !== "string") {
    throw new Error("newString must be a string");
  }
  if (args.oldString === args.newString) {
    throw new Error("oldString and newString are identical");
  }
  const abs = await resolveWorkspacePath(policy, args.path, "write");
  const before = await fs.readFile(abs, "utf-8").catch(() => null);
  if (before === null) throw new Error(`File not found: ${args.path}`);

  const count = before.split(args.oldString).length - 1;
  if (count === 0) {
    throw new Error(
      `oldString not found in ${args.path} — read the file again, ` +
        `the content has changed or the match is wrong (check whitespace).`,
    );
  }
  if (count > 1 && !args.replaceAll) {
    throw new Error(
      `oldString matches ${count} places in ${args.path} — ` +
        `make it unique (include surrounding context) or set replaceAll.`,
    );
  }
  const fixed = args.replaceAll
    ? before.split(args.oldString).join(args.newString)
    : before.replace(args.oldString, args.newString);

  await fs.writeFile(abs, fixed, "utf-8");
  return {
    path: path.relative(policy.root, abs),
    created: false,
    diff: simpleDiff(before, fixed),
    bytesBefore: before.length,
    bytesAfter: fixed.length,
    replacements: args.replaceAll ? count : 1,
  };
}

// ── Project scripts (allowlisted execution) ─────────────────

export async function listProjectScripts(
  policy: WorkspacePolicy,
): Promise<{ scripts: Record<string, string>; runner: string }> {
  const pkgRaw = await fs
    .readFile(path.join(policy.root, "package.json"), "utf-8")
    .catch(() => null);
  if (!pkgRaw) throw new Error("No package.json in workspace root");
  const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
  const hasBunLock = await fs
    .access(path.join(policy.root, "bun.lock"))
    .then(() => true)
    .catch(() => false);
  return { scripts: pkg.scripts ?? {}, runner: hasBunLock ? "bun" : "npm" };
}

export interface ScriptResult {
  script: string;
  command: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/**
 * Run a script DECLARED in package.json — nothing else. This is the
 * allowlisted execution primitive: arbitrary commands are not possible
 * through this tool (run_command exists separately behind guardrails).
 */
export async function runProjectScript(
  policy: WorkspacePolicy,
  args: { script: string; timeoutMs?: number; tailChars?: number },
): Promise<ScriptResult> {
  const { scripts, runner } = await listProjectScripts(policy);
  if (!Object.prototype.hasOwnProperty.call(scripts, args.script)) {
    const available = Object.keys(scripts).sort().join(", ") || "(none)";
    throw new Error(
      `Script "${args.script}" is not declared in package.json. Available: ${available}`,
    );
  }
  const timeoutMs = Math.max(
    5_000,
    Math.min(10 * 60_000, Math.floor(args.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS)),
  );
  const started = Date.now();
  const result = await run(runner, ["run", args.script], policy.root, timeoutMs).catch(
    (err: Error): ExecResult => ({
      code: 127,
      stdout: "",
      stderr: err.message,
      timedOut: false,
    }),
  );
  const tail = Math.max(2000, Math.min(20_000, args.tailChars ?? 8000));
  return {
    script: args.script,
    command: `${runner} run ${args.script}`,
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
    stdout: truncate(result.stdout, tail),
    stderr: truncate(result.stderr, tail),
    truncated: result.stdout.length > tail || result.stderr.length > tail,
  };
}

// ── Project overview ────────────────────────────────────────

export async function getProjectOverview(
  policy: WorkspacePolicy,
): Promise<Record<string, unknown>> {
  const pkgRaw = await fs
    .readFile(path.join(policy.root, "package.json"), "utf-8")
    .catch(() => null);
  let pkg: Record<string, unknown> = {};
  if (pkgRaw) {
    try {
      pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    } catch {
      pkg = { note: "package.json is not valid JSON" };
    }
  }
  const tree = await listRepoTree(policy, { depth: 2, maxEntries: 120 });
  let gitInfo: Record<string, unknown> | string;
  try {
    gitInfo = await gitStatus(policy);
  } catch (err) {
    gitInfo = err instanceof Error ? err.message : String(err);
  }
  const pyFiles = await fs
    .readdir(policy.root)
    .then((names) => names.filter((n) => n.endsWith(".py")))
    .catch(() => [] as string[]);

  return {
    root: path.basename(policy.root),
    packageJson: {
      name: pkg["name"],
      description: pkg["description"],
      scripts: (pkg["scripts"] as Record<string, string>) ?? {},
      dependencies: Object.keys((pkg["dependencies"] as Record<string, string>) ?? {}).slice(0, 60),
      devDependencies: Object.keys((pkg["devDependencies"] as Record<string, string>) ?? {}).slice(
        0,
        60,
      ),
    },
    pythonFiles: pyFiles,
    tree,
    git: gitInfo,
  };
}
