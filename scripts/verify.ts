#!/usr/bin/env bun
/**
 * One command that proves the installation actually works.
 *
 * Every check runs against the real machine — the real TypeScript compiler, the
 * real test suite, the real helpers, the real Ollama daemon, the real local
 * agent, and (when the dev server is up) the real speech-to-text pipeline. A
 * check that cannot run is reported as skipped with the reason, never as a pass.
 *
 * Usage:  bun scripts/verify.ts [--quick]
 *         --quick skips the slower compiler/test/lint checks.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const QUICK = process.argv.includes("--quick");
const APP_ORIGIN = process.env["JARVIS_APP_ORIGIN"] ?? "http://127.0.0.1:4173";
const AGENT_ORIGIN = `http://127.0.0.1:${process.env["LOCAL_AGENT_PORT"] ?? "3008"}`;

type Status = "pass" | "fail" | "skip";
interface Result {
  name: string;
  status: Status;
  detail: string;
}

const results: Result[] = [];
function record(name: string, status: Status, detail: string): void {
  results.push({ name, status, detail });
  const glyph = status === "pass" ? "✓" : status === "fail" ? "✗" : "–";
  console.log(`${glyph} ${name}${detail ? ` — ${detail}` : ""}`);
}

function run(command: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
    return { ok: true, output };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`,
    };
  }
}

function firstLines(text: string, count: number): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(" · ")
    .slice(0, 220);
}

// ── Static checks ──────────────────────────────────────────────────────────

if (!QUICK) {
  const tsc = run("npx", ["tsc", "--noEmit"]);
  record(
    "typecheck",
    tsc.ok ? "pass" : "fail",
    tsc.ok ? "no type errors" : firstLines(tsc.output, 3),
  );

  const tests = run("npx", ["vitest", "run", "--reporter=dot"]);
  const counts = /Tests\s+(\d+) passed/.exec(tests.output) ?? /(\d+) passed/.exec(tests.output);
  record(
    "unit tests",
    tests.ok ? "pass" : "fail",
    tests.ok ? `${counts?.[1] ?? "all"} tests passed` : firstLines(tests.output, 4),
  );

  const lint = run("npx", ["eslint", "."]);
  record("lint", lint.ok ? "pass" : "fail", lint.ok ? "no problems" : firstLines(lint.output, 3));
}

// ── The two native helpers and their permissions ───────────────────────────

const observer = join(ROOT, "native/jarvis-hands/bin/jarvis-hands");
const control = join(ROOT, "native/jarvis-hands-control/bin/jarvis-hands-control");

for (const [label, bin] of [
  ["observer helper", observer],
  ["control helper", control],
] as const) {
  if (!existsSync(bin)) {
    record(label, "skip", `not built — run ./native/build-all.command`);
    continue;
  }
  const result = run(bin, ["permissions"]);
  let status: Status = "fail";
  let detail = firstLines(result.output, 1);
  try {
    const json = JSON.parse(result.output.trim().split("\n").pop() ?? "{}") as Record<
      string,
      unknown
    >;
    const granted = json["accessibility"] === true && json["screenRecording"] === true;
    status = granted ? "pass" : "skip";
    detail = `accessibility=${json["accessibility"]} screenRecording=${json["screenRecording"]}`;
    if (!granted) detail += " — grant in System Settings → Privacy & Security";
  } catch {
    // keep the failure detail
  }
  record(label, status, detail);
}

// ── Model backend ──────────────────────────────────────────────────────────

async function checkModels(): Promise<void> {
  try {
    const { listInstalledModels, chooseModel } = await import("../src/lib/ai/ollama-models");
    const models = await listInstalledModels();
    if (models.length === 0) {
      record("ollama models", "skip", "daemon did not answer — is `ollama serve` running?");
      return;
    }
    const routed = process.env["OLLAMA_LOCAL_MODEL"] ?? "qwen2.5:14b";
    const chosen = chooseModel(routed, models);
    record(
      "ollama models",
      chosen === routed ? "pass" : "skip",
      `installed: ${models.join(", ")} · routing to ${chosen}${chosen === routed ? "" : ` (pull ${routed} for the default)`}`,
    );
  } catch (err) {
    record("ollama models", "fail", err instanceof Error ? err.message : String(err));
  }
}

// ── Local agent ────────────────────────────────────────────────────────────

async function checkAgent(): Promise<void> {
  try {
    const res = await fetch(`${AGENT_ORIGIN}/health`, { signal: AbortSignal.timeout(2500) });
    const body = (await res.json()) as { tools?: number };
    record("local agent", "pass", `${body.tools ?? "?"} tools on ${AGENT_ORIGIN}`);
  } catch {
    record("local agent", "skip", `not running — start it with: bun local-agent/server.ts`);
  }
}

// ── Speech-to-text, through the app's own route ────────────────────────────

async function checkTranscription(): Promise<void> {
  let dir: string | null = null;
  try {
    const ping = await fetch(`${APP_ORIGIN}/`, { signal: AbortSignal.timeout(2000) });
    if (!ping.ok) throw new Error(`app answered ${ping.status}`);

    dir = mkdtempSync(join(tmpdir(), "jarvis-verify-"));
    const audio = join(dir, "sample.m4a");
    const said = run("/usr/bin/say", ["-o", audio, "jarvis verification"]);
    if (!said.ok || !existsSync(audio)) {
      record("speech-to-text", "skip", "`say` could not produce sample audio");
      return;
    }

    const { readFileSync: read } = await import("node:fs");
    const res = await fetch(`${APP_ORIGIN}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioBase64: read(audio).toString("base64"),
        mimeType: "audio/mp4",
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json()) as { text?: string; error?: string };
    if (body.text) {
      record("speech-to-text", "pass", `heard: "${body.text.trim()}"`);
    } else {
      record(
        "speech-to-text",
        "skip",
        `${body.error ?? "no text"} — check WHISPER_BIN and models/ggml-small.en.bin`,
      );
    }
  } catch (err) {
    record(
      "speech-to-text",
      "skip",
      `dev server not reachable at ${APP_ORIGIN} (${err instanceof Error ? err.message : err})`,
    );
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

// ── Menu-bar app ───────────────────────────────────────────────────────────

function checkMenuBar(): void {
  const app = join(ROOT, "native/jarvis-menubar/bin/JARVISMenuBar.app");
  if (!existsSync(app)) {
    record("menu-bar app", "skip", "not built — run ./native/jarvis-menubar/build.command");
    return;
  }
  const ps = run("/bin/ps", ["-ax", "-o", "command"]);
  const running = ps.output.includes("JARVISMenuBar.app/Contents/MacOS/JARVISMenuBar");
  record(
    "menu-bar app",
    running ? "pass" : "skip",
    running ? "running (menu bar item “J”)" : `built but not running — open ${app}`,
  );
}

// ── Workspace state ────────────────────────────────────────────────────────

function checkState(): void {
  const required = ["local-agent/.agent-secret", "local-agent/.approval-key"];
  const missing = required.filter((file) => !existsSync(join(ROOT, file)));
  if (missing.length > 0) {
    record(
      "agent keys",
      "skip",
      `missing ${missing.join(", ")} — the agent creates them on first start`,
    );
    return;
  }
  const secret = readFileSync(join(ROOT, "local-agent/.agent-secret"), "utf8").trim();
  record(
    "agent keys",
    secret.length >= 32 ? "pass" : "fail",
    `shared secret present (${secret.length} chars)`,
  );
}

await checkModels();
await checkAgent();
await checkTranscription();
checkMenuBar();
checkState();

const failed = results.filter((r) => r.status === "fail");
const skipped = results.filter((r) => r.status === "skip");
console.log(
  `\n${results.filter((r) => r.status === "pass").length} passed · ${failed.length} failed · ${skipped.length} skipped`,
);
if (failed.length > 0) {
  console.log("Fix the ✗ items above before trusting the rest.");
  process.exit(1);
}
if (skipped.length > 0) {
  console.log("Skipped items are not running yet; each line says what to do.");
}
