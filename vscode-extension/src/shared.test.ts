import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskPrompt,
  capContext,
  CAPS,
  escapeHtml,
  isActivePhase,
  isTerminalPhase,
  parseTokenFile,
  phasePresentation,
  renderDiffHtml,
  validateServerUrl,
} from "./shared";
import { renderApp, type WebviewState } from "./webview";

test("validateServerUrl accepts loopback only", () => {
  assert.equal(validateServerUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  assert.equal(validateServerUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(validateServerUrl("https://example.com"), null);
  assert.equal(validateServerUrl("http://192.168.1.5:3000"), null);
  assert.equal(validateServerUrl("http://127.0.0.1.evil.com"), null);
  assert.equal(validateServerUrl("file:///etc/passwd"), null);
  assert.equal(validateServerUrl("not a url"), null);
});

test("parseTokenFile rejects short / non-hex tokens", () => {
  assert.equal(parseTokenFile("abc"), null);
  assert.equal(parseTokenFile("z".repeat(64)), null);
  assert.equal(parseTokenFile(" " + "ab".repeat(32) + "\n"), "ab".repeat(32));
});

test("capContext enforces transmission caps", () => {
  const out = capContext({
    selection: "x".repeat(10_000),
    fileText: "y".repeat(10_000),
    diagnostics: Array.from({ length: 100 }, (_, i) => ({
      line: i,
      severity: "error" as const,
      message: "m".repeat(1000),
    })),
  });
  assert.equal(out.selection?.length, CAPS.selectionChars);
  assert.equal(out.fileText?.length, CAPS.fileTextChars);
  assert.equal(out.diagnostics?.length, CAPS.maxDiagnostics);
  assert.equal(out.diagnostics?.[0]?.message.length, CAPS.maxDiagnosticChars);
  assert.equal(out.diagnostics?.[0]?.line, 1); // line 0 clamped to 1
});

test("buildTaskPrompt includes only relevant context per intent", () => {
  const p = buildTaskPrompt("fix_problems", "Fix it", {
    file: "src/a.ts",
    diagnostics: [{ line: 3, severity: "error", message: "bad" }],
    fileText: "SECRET_BODY",
  });
  assert.match(p, /line 3 \[error\] bad/);
  assert.ok(!p.includes("SECRET_BODY")); // file body only goes out for explain_file
  assert.ok(p.length <= 8000);
});

test("phase helpers", () => {
  assert.equal(isActivePhase("TESTING"), true);
  assert.equal(isActivePhase("COMPLETED"), false);
  assert.equal(isTerminalPhase("FAILED"), true);
  assert.equal(isTerminalPhase("NEEDS_APPROVAL"), false);
  assert.equal(phasePresentation("NEEDS_APPROVAL").tone, "wait");
});

test("renderDiffHtml escapes hostile repo content", () => {
  const html = renderDiffHtml('+</script><img src=x onerror=alert(1)>\n-"quoted"');
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("</script>"));
  assert.match(html, /&lt;\/script&gt;/);
});

const baseTask = {
  id: "t1",
  title: "t",
  repoRoot: "/r",
  phase: "NEEDS_APPROVAL",
  model: "m",
  createdAt: 0,
  updatedAt: 0,
  iterations: 1,
  maxIterations: 10,
  steps: [],
  events: [],
  changedFiles: ["a.ts"],
  baseline: null,
  verificationRuns: [],
  snapshotFiles: [],
  approval: {
    tool: "run_command",
    args: { cmd: "<b>rm</b>" },
    description: "run <script>x</script>",
    state: "pending" as const,
    at: 1,
  },
};

test("renderApp: nonce CSP, no unsafe-inline script, approval buttons, escaping", () => {
  const state: WebviewState = {
    connection: "ok",
    task: baseTask,
    diffs: {},
    messages: [{ role: "user", text: "<img onerror=1>" }],
  };
  const html = renderApp(state, "NONCE123");
  assert.match(html, /script-src 'nonce-NONCE123'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(html));
  assert.match(html, /<script nonce="NONCE123">/);
  assert.match(html, /data-act="approve" data-approved="1"/);
  assert.match(html, /data-act="approve" data-approved="0"/);
  assert.ok(!html.includes("<script>x</script>"));
  assert.ok(!html.includes("<img onerror=1>"));
});

test("renderApp: connection error shows banner with Retry", () => {
  const html = renderApp(
    {
      connection: "error",
      connectionMessage: "Cannot reach JARVIS backend",
      task: null,
      diffs: {},
      messages: [],
    },
    "n",
  );
  assert.match(html, /Cannot reach JARVIS backend/);
  assert.match(html, /data-act="retry"/);
});

test("renderApp: terminal task offers revert; running task offers cancel", () => {
  const done = renderApp(
    {
      connection: "ok",
      task: { ...baseTask, phase: "COMPLETED", approval: null },
      diffs: {},
      messages: [],
    },
    "n",
  );
  assert.match(done, /data-act="revert"/);
  assert.ok(!/data-act="cancel"/.test(done));
  const running = renderApp(
    {
      connection: "ok",
      task: { ...baseTask, phase: "TESTING", approval: null },
      diffs: {},
      messages: [],
    },
    "n",
  );
  assert.match(running, /data-act="cancel"/);
  assert.ok(!/data-act="revert"/.test(running));
});

test("escapeHtml", () => {
  assert.equal(
    escapeHtml(`<a href="x">'&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
});
