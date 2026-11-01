/**
 * Workspace boundary tests — traversal, secrets, symlinks, secret scanning.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createWorkspace,
  resolveWorkspacePath,
  WorkspaceViolation,
  isIgnoredPath,
  isSensitivePath,
  looksLikeSecret,
  truncate,
  type WorkspacePolicy,
} from "./workspace";

let root: string;
let outside: string;
let policy: WorkspacePolicy;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "jarvis-ws-"));
  outside = await fs.mkdtemp(path.join(tmpdir(), "jarvis-outside-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "app.ts"), "export {};\n");
  await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");
  await fs.writeFile(path.join(root, ".env.local"), "SECRET=2\n");
  await fs.writeFile(path.join(outside, "secret.txt"), "outside\n");
  // Symlink inside the workspace pointing outside it.
  await fs
    .symlink(path.join(outside, "secret.txt"), path.join(root, "escape-link"))
    .catch(() => {});
  policy = await createWorkspace(root);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
});

describe("resolveWorkspacePath", () => {
  it("resolves relative paths inside the root", async () => {
    const p = await resolveWorkspacePath(policy, "src/app.ts");
    expect(p).toBe(path.join(root, "src", "app.ts"));
  });

  it("accepts paths expressed relative to root ('.')", async () => {
    const p = await resolveWorkspacePath(policy, ".");
    expect(p).toBe(root);
  });

  it("rejects traversal outside the workspace", async () => {
    await expect(resolveWorkspacePath(policy, "../outside/secret.txt")).rejects.toThrow(
      WorkspaceViolation,
    );
    await expect(resolveWorkspacePath(policy, "/etc/passwd")).rejects.toThrow(WorkspaceViolation);
    await expect(resolveWorkspacePath(policy, "src/../../outside")).rejects.toThrow(
      WorkspaceViolation,
    );
  });

  it("rejects .env and .env.* files", async () => {
    await expect(resolveWorkspacePath(policy, ".env")).rejects.toThrow(/Sensitive/);
    await expect(resolveWorkspacePath(policy, ".env.local")).rejects.toThrow(/Sensitive/);
    await expect(resolveWorkspacePath(policy, "config/.env.production")).rejects.toThrow(
      /Sensitive/,
    );
  });

  it("rejects common credential stores (not just .env)", async () => {
    for (const f of [".npmrc", ".netrc", ".git-credentials", "id_rsa", "id_ed25519", ".pgpass"]) {
      await expect(resolveWorkspacePath(policy, f)).rejects.toThrow(/Sensitive/);
      await expect(resolveWorkspacePath(policy, f, "write")).rejects.toThrow(/Sensitive/);
    }
    await expect(resolveWorkspacePath(policy, ".bash_history")).rejects.toThrow(/Sensitive/);
  });

  it("blocks .git/config (token-in-remote-URL) but allows other .git reads and files named 'config'", async () => {
    await expect(resolveWorkspacePath(policy, ".git/config")).rejects.toThrow(/Sensitive/);
    // A legitimate source file that happens to be named 'config' stays usable.
    const ok = await resolveWorkspacePath(policy, "config", "write");
    expect(ok).toBe(path.join(root, "config"));
    // Non-config .git metadata is not caught by the git-config read rule …
    const head = await resolveWorkspacePath(policy, ".git/HEAD");
    expect(head).toBe(path.join(root, ".git", "HEAD"));
    // … but writes inside .git are refused as a dependency/VCS directory.
    await expect(resolveWorkspacePath(policy, ".git/HEAD", "write")).rejects.toThrow(/dependency/);
  });

  it("rejects NUL bytes and empty paths", async () => {
    await expect(resolveWorkspacePath(policy, "a\0b")).rejects.toThrow(WorkspaceViolation);
    await expect(resolveWorkspacePath(policy, "   ")).rejects.toThrow(WorkspaceViolation);
  });

  it("rejects symlink escape on read", async () => {
    await expect(resolveWorkspacePath(policy, "escape-link")).rejects.toThrow(/symlink/);
  });

  it("allows writes in source dirs but not in node_modules", async () => {
    const p = await resolveWorkspacePath(policy, "src/new.ts", "write");
    expect(p).toBe(path.join(root, "src", "new.ts"));
    await expect(
      resolveWorkspacePath(policy, "node_modules/pkg/index.js", "write"),
    ).rejects.toThrow(/dependency/);
  });

  it("allows creating a new file whose parent exists", async () => {
    const p = await resolveWorkspacePath(policy, "src/brand-new.tsx", "write");
    expect(p).toBe(path.join(root, "src", "brand-new.tsx"));
  });
});

describe("heuristic helpers", () => {
  it("isIgnoredPath flags dependency and build dirs only", () => {
    expect(isIgnoredPath("node_modules/x")).toBe(true);
    expect(isIgnoredPath("dist/x.js")).toBe(true);
    expect(isIgnoredPath("src/lib/x.ts")).toBe(false);
    // 'build' as a filename, not a directory segment, is fine.
    expect(isIgnoredPath("src/build.sh")).toBe(false);
  });

  it("isSensitivePath flags env and secret files", () => {
    expect(isSensitivePath("/x/.env")).toBe(true);
    expect(isSensitivePath("/x/.env.staging")).toBe(true);
    expect(isSensitivePath("/x/agent-token")).toBe(true);
    expect(isSensitivePath("/x/.npmrc")).toBe(true);
    expect(isSensitivePath("/x/.git-credentials")).toBe(true);
    expect(isSensitivePath("/repo/.git/config")).toBe(true);
    expect(isSensitivePath("/x/index.ts")).toBe(false);
    // A plain file named 'config' outside .git must not be blocked.
    expect(isSensitivePath("/x/config")).toBe(false);
    expect(isSensitivePath("/x/src/config/index.ts")).toBe(false);
  });

  it("looksLikeSecret detects keys but not prose", () => {
    expect(looksLikeSecret("const apiKey = 'sk-abc123def456ghi789'")).toBe(true);
    expect(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(looksLikeSecret('password = "hunter2hunter2hunter2"')).toBe(true);
    expect(looksLikeSecret("The agent uses a token to authenticate requests.")).toBe(false);
  });

  it("truncate keeps and annotates long text", () => {
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("x".repeat(50), 10)).toContain("[truncated 40 chars]");
  });
});
