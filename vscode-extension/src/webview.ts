/**
 * Webview renderer for the JARVIS sidebar.
 *
 * Pure function: WebviewState → HTML string (unit-testable, no vscode).
 * Visual identity: dark charcoal ground, restrained forest-green/emerald
 * accents, mono-forward typography — deliberately not blue-gradient AI candy.
 */

import {
  escapeHtml,
  isActivePhase,
  phasePresentation,
  renderDiffHtml,
  type AgentTaskPublic,
  type DiffPayload,
} from "./shared";

export interface ChatMessage {
  role: "user" | "jarvis";
  text: string;
}

export interface WebviewState {
  connection: "unknown" | "ok" | "error";
  connectionMessage?: string;
  task: AgentTaskPublic | null;
  diffs: Record<string, DiffPayload>;
  messages: ChatMessage[];
}

function phasePill(task: AgentTaskPublic | null): string {
  if (!task) return `<span class="pill idle">IDLE</span>`;
  const { label, tone } = phasePresentation(task.phase);
  return `<span class="pill ${tone}">${escapeHtml(label)}</span>`;
}

function progressBar(task: AgentTaskPublic): string {
  const pct = Math.min(100, Math.round((task.iterations / Math.max(1, task.maxIterations)) * 100));
  return `
    <div class="meta-row">
      <span>turn ${task.iterations}/${task.maxIterations}</span>
      <span>${task.changedFiles.length} file${task.changedFiles.length === 1 ? "" : "s"} changed</span>
    </div>
    <div class="track"><div class="fill" style="width:${pct}%"></div></div>`;
}

function approvalBanner(task: AgentTaskPublic | null): string {
  const a = task?.approval;
  if (!a || a.state !== "pending" || !task) return "";
  return `
    <div class="banner wait">
      <div class="banner-title">Approval required</div>
      <div class="banner-body">${escapeHtml(a.description)}</div>
      <pre class="args">${escapeHtml(JSON.stringify(a.args, null, 1).slice(0, 600))}</pre>
      <div class="row">
        <button class="btn primary" data-act="approve" data-approved="1">Approve</button>
        <button class="btn" data-act="approve" data-approved="0">Deny</button>
      </div>
    </div>`;
}

function verificationBlock(task: AgentTaskPublic): string {
  if (task.verificationRuns.length === 0 && !task.baseline) return "";
  const runs = task.verificationRuns.slice(-3).reverse();
  const items = runs
    .map(
      (run) => `
      <div class="check-run">
        ${run.results
          .map(
            (r) => `
          <div class="check-line ${r.exitCode === 0 ? "ok" : "bad"}">
            <span class="exit">exit ${r.exitCode}</span>
            <span class="cmd">${escapeHtml(r.command)}</span>
            <span class="dur">${r.durationMs}ms</span>
          </div>`,
          )
          .join("")}
      </div>`,
    )
    .join("");
  const baselineNote = task.baseline
    ? `<div class="note">baseline: ${task.baseline.results
        .map((r) => `${r.name}=exit ${r.exitCode}`)
        .join(", ")}</div>`
    : "";
  return `
    <details class="block" data-key="checks" ${runs.some((r) => !r.allPassed) ? "open" : ""}>
      <summary>Checks</summary>
      ${items}${baselineNote}
    </details>`;
}

function diffBlock(state: WebviewState): string {
  const task = state.task;
  if (!task || task.changedFiles.length === 0) return "";
  const rows = task.changedFiles
    .slice(0, 20)
    .map((f) => {
      const d = state.diffs[f];
      return `
      <details class="diff-file" data-key="diff:${escapeHtml(f)}">
        <summary>${d?.created ? "＋" : "±"} ${escapeHtml(f)}</summary>
        <div class="diff-body">${d ? renderDiffHtml(d.diff) : "<em>diff unavailable</em>"}</div>
        <div class="row">
          <button class="btn small" data-act="open-diff" data-path="${escapeHtml(f)}">Open side-by-side</button>
        </div>
      </details>`;
    })
    .join("");
  const terminal = ["COMPLETED", "FAILED", "CANCELLED"].includes(task.phase);
  return `
    <details class="block" data-key="changes" open>
      <summary>Changes (${task.changedFiles.length})</summary>
      ${rows}
      ${
        terminal
          ? `<div class="row">
              <button class="btn" data-act="revert">Revert all changes</button>
            </div>`
          : ""
      }
    </details>`;
}

function activityBlock(task: AgentTaskPublic | null): string {
  if (!task || task.events.length === 0) return "";
  const recent = task.events.slice(-14).reverse();
  const items = recent
    .map(
      (e) => `
      <li class="ev ev-${escapeHtml(e.kind)}">
        <span class="ev-kind">${escapeHtml(e.kind)}</span>
        <span>${escapeHtml(e.text)}</span>
      </li>`,
    )
    .join("");
  return `
    <details class="block" data-key="activity">
      <summary>Activity</summary>
      <ul class="events">${items}</ul>
    </details>`;
}

function messagesBlock(state: WebviewState): string {
  const task = state.task;
  const items = state.messages
    .map(
      (m) => `
      <div class="msg ${m.role}">
        <div class="msg-role">${m.role === "user" ? "you" : "jarvis"}</div>
        <div class="msg-text">${escapeHtml(m.text)}</div>
      </div>`,
    )
    .join("");
  const report =
    task?.finalReport && state.messages.every((m) => m.text !== task.finalReport)
      ? `<div class="msg jarvis"><div class="msg-role">report</div>
         <div class="msg-text">${escapeHtml(task.finalReport)}</div></div>`
      : "";
  return `<div class="messages" id="messages">${items}${report}</div>`;
}

export function renderApp(state: WebviewState, nonce = ""): string {
  const task = state.task;
  const running = task ? isActivePhase(task.phase) : false;
  const connTone = state.connection === "ok" ? "ok" : state.connection === "error" ? "bad" : "idle";
  const banner =
    state.connection === "error"
      ? `<div class="banner error"><div class="banner-body">${escapeHtml(
          state.connectionMessage ?? "Backend unreachable",
        )}</div>
         <div class="row"><button class="btn small" data-act="retry">Retry</button></div></div>`
      : "";
  const interrupted =
    task?.interrupted && task.phase === "CANCELLED"
      ? `<div class="banner wait">
           <div class="banner-body">Task was interrupted by a restart — completed steps are kept.</div>
           <div class="row"><button class="btn primary" data-act="resume">Resume</button></div>
         </div>`
      : "";
  const errorBanner =
    task?.phase === "FAILED" && task.error
      ? `<div class="banner error"><div class="banner-body">${escapeHtml(task.error)}</div></div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${escapeHtml(nonce)}'; img-src data:;" />
<style>
  :root {
    --bg: #141715;
    --panel: #1a1e1b;
    --panel-2: #20251f;
    --line: #2b322c;
    --text: #d6dbd6;
    --muted: #7e8c81;
    --emerald: #34d399;
    --forest: #1f6f52;
    --warn: #d9a441;
    --bad: #e06c6c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    background: var(--bg); color: var(--text);
    font-family: "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, monospace;
    font-size: 12px; line-height: 1.5;
  }
  #app { padding: 10px 10px 16px; }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 4px 10px; border-bottom: 1px solid var(--line);
    margin-bottom: 10px;
  }
  .brand { letter-spacing: 4px; font-size: 12px; color: var(--emerald); font-weight: 600; }
  .brand small { color: var(--muted); letter-spacing: 1px; margin-left: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.ok { background: var(--emerald); }
  .dot.bad { background: var(--bad); }
  .dot.idle { background: var(--muted); }
  .pill {
    padding: 2px 8px; border-radius: 10px; font-size: 10px;
    letter-spacing: 1px; text-transform: uppercase;
    border: 1px solid var(--line); color: var(--muted);
  }
  .pill.work { color: var(--emerald); border-color: var(--forest); }
  .pill.wait { color: var(--warn); border-color: #6b5423; }
  .pill.done { color: var(--emerald); border-color: var(--forest); background: #12271f; }
  .pill.error { color: var(--bad); border-color: #6b3232; }
  .meta-row { display: flex; justify-content: space-between; color: var(--muted); margin: 6px 2px 4px; }
  .track { height: 3px; background: var(--panel-2); border-radius: 2px; overflow: hidden; }
  .fill { height: 100%; background: linear-gradient(90deg, var(--forest), var(--emerald)); }
  .banner {
    border: 1px solid var(--line); background: var(--panel);
    padding: 8px 10px; border-radius: 6px; margin: 8px 0;
  }
  .banner.wait { border-color: #6b5423; }
  .banner.error { border-color: #6b3232; }
  .banner-title { color: var(--warn); margin-bottom: 4px; letter-spacing: 1px; font-size: 10px; text-transform: uppercase; }
  .banner-body { color: var(--text); word-break: break-word; }
  .args {
    background: var(--bg); border: 1px solid var(--line); border-radius: 4px;
    padding: 6px; overflow: auto; max-height: 120px; color: var(--muted); margin: 6px 0;
  }
  .row { display: flex; gap: 6px; margin-top: 6px; }
  .btn {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 4px; padding: 4px 10px; cursor: pointer;
    font-family: inherit; font-size: 11px;
  }
  .btn:hover { border-color: var(--forest); color: var(--emerald); }
  .btn.primary { background: #12271f; border-color: var(--forest); color: var(--emerald); }
  .btn.small { padding: 2px 8px; font-size: 10px; }
  details.block {
    border: 1px solid var(--line); background: var(--panel);
    border-radius: 6px; margin: 8px 0; padding: 6px 8px;
  }
  details summary { cursor: pointer; color: var(--muted); letter-spacing: 1px; font-size: 10px; text-transform: uppercase; }
  .check-line { display: flex; gap: 8px; margin-top: 5px; align-items: baseline; }
  .check-line .exit { font-weight: 700; }
  .check-line.ok .exit { color: var(--emerald); }
  .check-line.bad .exit { color: var(--bad); }
  .check-line .cmd { color: var(--text); word-break: break-all; }
  .check-line .dur { color: var(--muted); margin-left: auto; }
  .note { color: var(--muted); margin-top: 6px; font-size: 10px; }
  .diff-file { margin-top: 6px; }
  .diff-file summary { text-transform: none; color: var(--text); letter-spacing: 0; font-size: 11px; }
  .diff-body { max-height: 260px; overflow: auto; margin-top: 6px; border: 1px solid var(--line); border-radius: 4px; }
  .dl { padding: 0 8px; white-space: pre-wrap; word-break: break-all; }
  .dl.add { background: #10291f; color: #7ee2b8; }
  .dl.del { background: #2b1616; color: #e6a0a0; }
  .dl.hunk { color: var(--muted); background: var(--panel-2); }
  .dl.meta { color: var(--muted); font-style: italic; }
  .events { list-style: none; padding: 0; margin: 6px 0 0; }
  .ev { display: flex; gap: 8px; padding: 2px 0; color: var(--muted); }
  .ev-kind { color: var(--forest); min-width: 74px; }
  .ev-error .ev-kind { color: var(--bad); }
  .ev-approval .ev-kind { color: var(--warn); }
  .messages { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
  .msg { border-left: 2px solid var(--line); padding: 2px 8px; }
  .msg.jarvis { border-left-color: var(--emerald); }
  .msg.user { border-left-color: var(--forest); }
  .msg-role { color: var(--muted); font-size: 9px; letter-spacing: 2px; text-transform: uppercase; }
  .msg-text { white-space: pre-wrap; word-break: break-word; }
  .composer { display: flex; gap: 6px; margin-top: 10px; }
  .composer textarea {
    flex: 1; background: var(--panel); color: var(--text);
    border: 1px solid var(--line); border-radius: 6px; resize: vertical;
    min-height: 54px; padding: 6px 8px; font-family: inherit; font-size: 12px;
  }
  .composer textarea:focus { outline: none; border-color: var(--forest); }
  .empty { color: var(--muted); font-style: italic; padding: 6px 2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .chip { background: var(--panel-2); border: 1px solid var(--line); border-radius: 3px; padding: 1px 6px; font-size: 10px; color: var(--muted); }
</style>
</head>
<body>
<div id="app">
  <header>
    <span class="brand">JARVIS<small>coding agent</small></span>
    <span>
      <span class="dot ${connTone}"></span>
      ${phasePill(task)}
      ${
        running
          ? `<button class="btn small" data-act="cancel" title="Cancel running task">■</button>`
          : ""
      }
    </span>
  </header>

  ${banner}
  ${errorBanner}
  ${interrupted}
  ${approvalBanner(task)}

  ${
    task
      ? `<div class="task-head">
           <div class="task-title">${escapeHtml(task.title)}</div>
           ${progressBar(task)}
         </div>
         ${
           task.changedFiles.length > 0
             ? `<div class="chips">${task.changedFiles
                 .map((f) => `<span class="chip">${escapeHtml(f)}</span>`)
                 .join("")}</div>`
             : ""
         }`
      : `<div class="empty">Ask JARVIS to investigate, fix, or explain this workspace. Voice requests use the same task engine.</div>`
  }

  ${diffBlock(state)}
  ${task ? verificationBlock(task) : ""}
  ${activityBlock(task)}
  ${messagesBlock(state)}

  <div class="composer">
    <textarea id="input" placeholder="e.g. Fix the failing tests and verify (Enter to send, Shift+Enter newline)"></textarea>
    <button class="btn primary" data-act="send">Send</button>
  </div>
</div>
<script nonce="${escapeHtml(nonce)}">
  const vscode = acquireVsCodeApi();
  function post(msg) { vscode.postMessage(msg); }
  // The sidebar re-renders as the task progresses; keep the user's draft,
  // open sections and scroll position across renders.
  const saved = vscode.getState() || { draft: "", open: {}, scroll: 0 };
  function persist(patch) {
    saved.draft = patch.draft !== undefined ? patch.draft : saved.draft;
    vscode.setState(saved);
  }
  const input = document.getElementById("input");
  input.value = saved.draft || "";
  input.addEventListener("input", () => persist({ draft: input.value }));
  document.querySelectorAll("details[data-key]").forEach((d) => {
    const k = d.getAttribute("data-key");
    if (saved.open && k in saved.open) d.open = saved.open[k];
    d.addEventListener("toggle", () => { saved.open = saved.open || {}; saved.open[k] = d.open; vscode.setState(saved); });
  });
  window.scrollTo(0, saved.scroll || 0);
  window.addEventListener("scroll", () => { saved.scroll = window.scrollY; vscode.setState(saved); }, { passive: true });
  function clearDraft() { input.value = ""; persist({ draft: "" }); }
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.getAttribute("data-act");
    if (act === "send") {
      const text = input.value.trim();
      if (text) { post({ type: "send", text }); clearDraft(); }
    } else if (act === "approve") {
      post({ type: "approve", approved: el.getAttribute("data-approved") === "1" });
    } else if (act === "retry") {
      post({ type: "retry" });
    } else if (act === "cancel") {
      post({ type: "cancel" });
    } else if (act === "resume") {
      post({ type: "resume" });
    } else if (act === "revert") {
      post({ type: "revert" });
    } else if (act === "open-diff") {
      post({ type: "open-diff", path: el.getAttribute("data-path") });
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (text) { post({ type: "send", text }); clearDraft(); }
    }
  });
  window.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "navigate") {
      if (typeof ev.data.text === "string") { input.value = ev.data.text; persist({ draft: input.value }); }
    }
  });
</script>
</body>
</html>`;
}
