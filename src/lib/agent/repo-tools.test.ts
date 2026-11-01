/**
 * Repository intelligence tools — fixture workspace with git + scripts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readSourceFile,
  listRepoTree,
  searchRepoContent,
  findSymbols,
  gitStatus,
  gitDiff,
  gitLog,
  writeRepoFile,
  editRepoFile,
  simpleDiff,
  listProjectScripts,
  runProjectScript,
  getProjectOverview,
} from "./repo-tools";
import { createWorkspace, type WorkspacePolicy } from "./workspace";

let root: string;
let policy: WorkspacePolicy;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "jarvis-repo-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
  await fs.mkdir(path.join(root, "dist"), { recursive: true });

  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "fixture",
        scripts: {
          "unit-pass": "node -e \"console.log('1 passed')\"",
          "unit-fail": "node -e \"console.error('boom'); process.exit(3)\"",
        },
        dependencies: { zod: "^3.0.0" },
        devDependencies: { vitest: "^3.0.0" },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    path.join(root, "src", "math.ts"),
    [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
      "export const multiply = (a: number, b: number) => a * b;",
      "",
      "export class Calculator {",
      "  total = 0;",
      "}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "src", "util.ts"),
    "export function addOne(n: number) {\n  return n + 1;\n}\n",
  );
  await fs.writeFile(path.join(root, "README.md"), "# Fixture\n");
  await fs.writeFile(path.join(root, "node_modules", "junk", "index.js"), "function add() {}\n");
  await fs.writeFile(path.join(root, "dist", "bundle.js"), "function add() {}\n");

  // Real git repo with one commit so status/diff/log have something to say.
  const git = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], (err) =>
        err ? reject(err) : resolve(),
      );
    });
  await git(["init"]).catch(() => {});
  await git(["add", "."]).catch(() => {});
  await git(["commit", "-m", "initial fixture"]).catch(() => {});

  policy = await createWorkspace(root);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("readSourceFile", () => {
  it("returns numbered lines with totals", async () => {
    const r = await readSourceFile(policy, { path: "src/math.ts" });
    expect(r.totalLines).toBe(10);
    expect(r.lines[0]).toBe("export function add(a: number, b: number): number {");
    expect(r.truncated).toBe(false);
  });

  it("windows lines by offset/limit and reports truncation", async () => {
    const r = await readSourceFile(policy, {
      path: "src/math.ts",
      offset: 3,
      limit: 2,
    });
    expect(r.offset).toBe(3);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toBe("}");
    expect(r.truncated).toBe(true);
  });

  it("errors on missing files and on directories", async () => {
    await expect(readSourceFile(policy, { path: "nope.ts" })).rejects.toThrow(/not found/);
    await expect(readSourceFile(policy, { path: "src" })).rejects.toThrow(/list_repo_tree/);
  });

  it("refuses to read .env", async () => {
    await expect(readSourceFile(policy, { path: ".env" })).rejects.toThrow(/Sensitive/);
  });
});

describe("listRepoTree", () => {
  it("lists entries and skips dependency/build dirs", async () => {
    const r = await listRepoTree(policy, { depth: 3 });
    expect(r.entries).toContain("src/");
    expect(r.entries).toContain("src/math.ts");
    expect(r.entries).toContain("package.json");
    expect(r.entries.some((e) => e.startsWith("node_modules"))).toBe(false);
    expect(r.entries.some((e) => e.startsWith("dist"))).toBe(false);
    expect(r.entries.some((e) => e.startsWith(".git"))).toBe(false);
  });

  it("respects maxEntries with a truncation flag", async () => {
    const r = await listRepoTree(policy, { depth: 4, maxEntries: 3 });
    expect(r.entries.length).toBeLessThanOrEqual(3);
    expect(r.truncated).toBe(true);
  });
});

describe("searchRepoContent", () => {
  it("finds literal matches with file/line, skipping ignored dirs", async () => {
    const r = await searchRepoContent(policy, { query: "add" });
    const files = r.hits.map((h) => h.file);
    expect(files).toContain("src/math.ts");
    expect(files).toContain("src/util.ts");
    expect(files.some((f) => f.startsWith("node_modules"))).toBe(false);
    expect(files.some((f) => f.startsWith("dist"))).toBe(false);
    expect(r.hits[0]!.line).toBeGreaterThan(0);
  });

  it("treats the query literally unless regex is set", async () => {
    // Literal mode: 'add(' matches itself, and '(' is not a group.
    const lit = await searchRepoContent(policy, { query: "add(a" });
    expect(lit.hits.length).toBeGreaterThan(0);
    // Regex mode: meta characters take effect.
    const re = await searchRepoContent(policy, {
      query: "function\\s+add\\(",
      regex: true,
    });
    expect(re.hits.some((h) => h.file === "src/math.ts")).toBe(true);
    // Invalid regex is reported, not thrown blindly.
    await expect(searchRepoContent(policy, { query: "([bad", regex: true })).rejects.toThrow(
      /Invalid regular expression/,
    );
  });

  it("honors extension filters and maxResults", async () => {
    const r = await searchRepoContent(policy, {
      query: "export",
      extensions: [".ts"],
      maxResults: 2,
    });
    expect(r.hits.length).toBeLessThanOrEqual(2);
    expect(r.hits.every((h) => h.file.endsWith(".ts"))).toBe(true);
    expect(r.truncated).toBe(true);
  });
});

describe("findSymbols", () => {
  it("finds function, const, and class definitions by name", async () => {
    const r = await findSymbols(policy, { name: "add" });
    const files = r.hits.map((h) => h.file + ":" + h.text);
    expect(files.some((f) => f.includes("function add("))).toBe(true);
    // Must not match the node_modules copy.
    expect(files.every((f) => !f.startsWith("node_modules"))).toBe(true);
  });

  it("finds classes and types", async () => {
    const cls = await findSymbols(policy, { name: "Calculator" });
    expect(cls.hits.some((h) => h.text.includes("class Calculator"))).toBe(true);
  });
});

describe("git tools", () => {
  it("reports branch and clean status", async () => {
    const s = await gitStatus(policy);
    expect(s.branch).toBeTruthy();
    // Everything committed in setup → clean until we edit.
    expect(s.clean).toBe(true);
  });

  it("shows a diff after a file changes", async () => {
    await fs.appendFile(path.join(root, "src", "util.ts"), "// touched\n");
    const d = await gitDiff(policy, { path: "src/util.ts" });
    expect(d.diff).toContain("+// touched");
    // Leave it dirty for other tests? Clean it back up.
    await fs.writeFile(
      path.join(root, "src", "util.ts"),
      "export function addOne(n: number) {\n  return n + 1;\n}\n",
    );
  });

  it("reads commit history", async () => {
    const l = await gitLog(policy, { limit: 5 });
    expect(l.commits.length).toBeGreaterThan(0);
    expect(l.commits[0]!.hash).toBeTruthy();
    expect(l.commits[0]!.subject).toBe("initial fixture");
  });
});

describe("editing", () => {
  it("simpleDiff marks removed and added lines", () => {
    const d = simpleDiff("a\nb\nc", "a\nX\nc");
    expect(d).toContain("-b");
    expect(d).toContain("+X");
    expect(simpleDiff("same", "same")).toBe("(no textual changes)");
  });

  it("writeRepoFile creates files and reports diff", async () => {
    const r = await writeRepoFile(policy, {
      path: "src/new-file.ts",
      content: "export const fresh = 1;\n",
    });
    expect(r.created).toBe(true);
    expect(r.diff).toContain("new file");
    const back = await readSourceFile(policy, { path: "src/new-file.ts" });
    expect(back.lines[0]).toBe("export const fresh = 1;");
    await fs.rm(path.join(root, "src", "new-file.ts"));
  });

  it("editRepoFile replaces an exact unique match", async () => {
    const r = await editRepoFile(policy, {
      path: "src/util.ts",
      oldString: "return n + 1;",
      newString: "return n + 2;",
    });
    expect(r.replacements).toBe(1);
    expect(r.diff).toContain("-  return n + 1;");
    expect(r.diff).toContain("+  return n + 2;");
    // Restore.
    await editRepoFile(policy, {
      path: "src/util.ts",
      oldString: "return n + 2;",
      newString: "return n + 1;",
    });
  });

  it("errors on missing or ambiguous matches", async () => {
    await expect(
      editRepoFile(policy, {
        path: "src/util.ts",
        oldString: "does not exist",
        newString: "x",
      }),
    ).rejects.toThrow(/not found/);
    // "n" context appears once… make an ambiguous match instead:
    await expect(
      editRepoFile(policy, {
        path: "src/math.ts",
        oldString: "a",
        newString: "b",
      }),
    ).rejects.toThrow(/matches \d+ places/);
  });

  it("refuses edits to dependency dirs and env files", async () => {
    await expect(
      editRepoFile(policy, {
        path: "node_modules/junk/index.js",
        oldString: "function",
        newString: "const",
      }),
    ).rejects.toThrow(/dependency/);
    await expect(writeRepoFile(policy, { path: ".env.local", content: "x" })).rejects.toThrow(
      /Sensitive/,
    );
  });
});

describe("project scripts", () => {
  it("lists declared scripts", async () => {
    const r = await listProjectScripts(policy);
    expect(Object.keys(r.scripts)).toEqual(["unit-pass", "unit-fail"]);
  });

  it("runs a passing script and captures exit 0 + output", async () => {
    const r = await runProjectScript(policy, { script: "unit-pass" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1 passed");
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures failing exit codes and stderr", async () => {
    const r = await runProjectScript(policy, { script: "unit-fail" });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("boom");
  });

  it("refuses undeclared scripts (allowlist enforcement)", async () => {
    await expect(runProjectScript(policy, { script: "rm -rf /" })).rejects.toThrow(/not declared/);
    await expect(runProjectScript(policy, { script: "prepublish" })).rejects.toThrow(/Available/);
  });
});

describe("getProjectOverview", () => {
  it("summarizes package.json, tree, and git state", async () => {
    const o = (await getProjectOverview(policy)) as {
      packageJson: { name: string; scripts: Record<string, string> };
      git: { branch: string };
      tree: { entries: string[] };
    };
    expect(o.packageJson.name).toBe("fixture");
    expect(o.packageJson.scripts["unit-pass"]).toBeTruthy();
    expect(o.git.branch).toBeTruthy();
    expect(o.tree.entries).toContain("src/");
  });
});
