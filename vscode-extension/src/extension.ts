/**
 * JARVIS coding-agent extension.
 *
 * Sidebar webview + editor commands that talk to the local JARVIS backend
 * (/api/agent, bearer token from .jarvis/agent-token). No AI logic lives
 * here — the extension gathers workspace context, starts/reviews tasks, and
 * renders server-side state.
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { JarvisClient, JarvisError } from "./client";
import { renderApp, type ChatMessage, type WebviewState } from "./webview";
import {
  buildTaskPrompt,
  isActivePhase,
  parseTokenFile,
  validateServerUrl,
  type AgentTaskPublic,
  type DiagnosticPublic,
  type EditorContext,
  type MemoryEntryPublic,
} from "./shared";

const SNAP_SCHEME = "jarvis-snap";

function repoRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

/** Serves snapshot ("before") documents for side-by-side diff views. */
class SnapshotProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(key: string, content: string): void {
    this.docs.set(key, content);
    this.emitter.fire(vscode.Uri.from({ scheme: SNAP_SCHEME, path: "/" + key }));
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path.replace(/^\//, "")) ?? "";
  }
}

interface ViewMessage {
  type: "send" | "approve" | "cancel" | "resume" | "revert" | "open-diff" | "retry";
  text?: string;
  approved?: boolean;
  path?: string;
}

class JarvisViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private timer?: ReturnType<typeof setInterval>;
  private state: WebviewState = {
    connection: "unknown",
    task: null,
    diffs: {},
    messages: [],
  };

  constructor(private readonly extensionContext: vscode.ExtensionContext) {}

  // ── backend access ────────────────────────────────────────

  private getClient(): JarvisClient {
    const cfg = vscode.workspace.getConfiguration("jarvis");
    const rawUrl = String(cfg.get("serverUrl") ?? "");
    const baseUrl = validateServerUrl(rawUrl);
    if (!baseUrl) {
      throw new JarvisError(`jarvis.serverUrl must be a loopback http(s) URL — got "${rawUrl}"`);
    }
    const configured = String(cfg.get("tokenPath") ?? "").trim();
    const tokenPath =
      configured !== "" ? configured : path.join(repoRoot(), ".jarvis", "agent-token");
    let token: string | null = null;
    try {
      token = parseTokenFile(fs.readFileSync(tokenPath, "utf-8"));
    } catch {
      token = null;
    }
    if (!token) {
      throw new JarvisError(
        `Agent token not found at ${tokenPath} — start the JARVIS web app once so it generates the token.`,
      );
    }
    return new JarvisClient({ baseUrl, token });
  }

  // ── state plumbing ────────────────────────────────────────

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = renderApp(this.state, nonceOf());
  }

  private setConnectionError(message: string): void {
    this.state.connection = "error";
    this.state.connectionMessage = message;
    this.render();
  }

  async poll(): Promise<void> {
    try {
      const client = this.getClient();
      const res = await client.status({ repoRoot: repoRoot() });
      const task = res.task ?? res.active ?? null;
      this.state.connection = "ok";
      delete this.state.connectionMessage;
      this.state.task = task;
      this.state.diffs = res.diffs ?? {};
      this.render();
    } catch (err) {
      this.setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }

  private startPolling(): void {
    if (this.timer) return;
    const cfg = vscode.workspace.getConfiguration("jarvis");
    const ms = Number(cfg.get("pollIntervalMs") ?? 800);
    this.timer = setInterval(() => void this.poll(), Math.max(300, ms));
    void this.poll();
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Send a task: reveal the sidebar, record the message, start the engine. */
  async send(prompt: string): Promise<void> {
    void vscode.commands.executeCommand("jarvis.chat.focus");
    const userMsg: ChatMessage = { role: "user", text: prompt };
    this.state.messages.push(userMsg);
    this.render();
    try {
      const client = this.getClient();
      await client.start(prompt, repoRoot());
      this.state.connection = "ok";
      delete this.state.connectionMessage;
      this.startPolling();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const busy = err instanceof JarvisError && err.isBusy;
      this.state.messages.push({
        role: "jarvis",
        text: busy
          ? "A task is already running — one at a time. Watch its progress above."
          : `Could not start: ${msg}`,
      });
      if (!busy) this.setConnectionError(msg);
      this.startPolling(); // still refresh status/approvals if reachable
    }
    this.render();
  }

  // ── command-facing helpers ────────────────────────────────

  getTask(): AgentTaskPublic | null {
    return this.state.task;
  }

  async cancelTask(): Promise<void> {
    const task = this.state.task;
    if (!task) return;
    await this.getClient().cancel(task.id);
    await this.poll();
  }

  async memoryList(): Promise<MemoryEntryPublic[]> {
    const res = await this.getClient().memory(repoRoot());
    return res.entries;
  }

  async memoryUpdate(id: string, content: string): Promise<void> {
    await this.getClient().memoryUpdate(id, { content }, repoRoot());
    this.state.messages.push({ role: "jarvis", text: "Memory corrected." });
    this.render();
  }

  async memoryDelete(id: string): Promise<void> {
    await this.getClient().memoryDelete(id, repoRoot());
    this.state.messages.push({ role: "jarvis", text: "Memory entry deleted." });
    this.render();
  }

  // ── webview wiring ────────────────────────────────────────

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage(
      (msg: ViewMessage) => {
        void this.onMessage(msg);
      },
      undefined,
      this.extensionContext.subscriptions,
    );
    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) this.startPolling();
        else this.stopPolling();
      },
      undefined,
      this.extensionContext.subscriptions,
    );
    this.render();
    this.startPolling();
  }

  private async onMessage(msg: ViewMessage): Promise<void> {
    try {
      const client = this.getClient();
      const task = this.state.task;
      switch (msg.type) {
        case "send":
          if (msg.text?.trim()) await this.send(msg.text.trim());
          return;
        case "retry":
          await this.poll();
          return;
        case "approve":
          if (!task) return;
          await client.approve(task.id, msg.approved === true);
          await this.poll();
          return;
        case "cancel":
          if (!task) return;
          await client.cancel(task.id);
          await this.poll();
          return;
        case "resume":
          if (!task) return;
          await client.resume(task.id, repoRoot());
          this.startPolling();
          return;
        case "revert": {
          if (!task) return;
          const confirmed = await vscode.window.showWarningMessage(
            `Revert all ${task.changedFiles.length} file(s) this task changed? Snapshots are restored; created files are deleted.`,
            { modal: true },
            "Revert changes",
          );
          if (confirmed !== "Revert changes") return;
          const res = await client.revert(task.id, repoRoot());
          const lines = Object.entries(res.reverted).map(([f, r]) => `${f}: ${r}`);
          this.state.messages.push({
            role: "jarvis",
            text: `Reverted:\n${lines.join("\n")}`,
          });
          await this.poll();
          return;
        }
        case "open-diff":
          if (msg.path) await this.openDiff(msg.path);
          return;
      }
    } catch (err) {
      this.setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }

  // ── diffs ─────────────────────────────────────────────────

  async openDiff(relPath: string): Promise<void> {
    const task = this.state.task;
    if (!task) return;
    const client = this.getClient();
    const snap = await client.snapshot(task.id, relPath, task.repoRoot);
    const key = `${task.id}/${relPath}`;
    snapshotStore.set(
      key,
      snap.before === null
        ? "// file created by this task"
        : (snap.before ?? "// snapshot unavailable"),
    );
    const wsUri = vscode.Uri.file(path.join(task.repoRoot, relPath));
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.from({ scheme: SNAP_SCHEME, path: "/" + key }),
      wsUri,
      `JARVIS: ${relPath} (before ↔ current)`,
    );
  }

  dispose(): void {
    this.stopPolling();
  }
}

/** Per-render CSP nonce so the inline script stays locked to this render. */
function nonceOf(): string {
  return Buffer.from(String(Date.now()) + Math.random().toString(36).slice(2))
    .toString("base64")
    .slice(0, 24);
}

/** Before-content documents for side-by-side diff (registered in activate). */
const snapshotStore = new SnapshotProvider();

// ── editor context gathering ────────────────────────────────

function collectEditorContext(includeText: boolean): EditorContext {
  const ctx: EditorContext = { workspaceRoot: repoRoot() };
  const editor = vscode.window.activeTextEditor;
  if (!editor) return ctx;
  const doc = editor.document;
  ctx.file = vscode.workspace.asRelativePath(doc.uri, false);
  ctx.languageId = doc.languageId;
  const sel = editor.selection;
  if (!sel.isEmpty) {
    ctx.selection = doc.getText(sel);
  } else if (includeText) {
    ctx.fileText = doc.getText();
  }
  ctx.diagnostics = vscode.languages.getDiagnostics(doc.uri).map((d) => ({
    line: d.range.start.line + 1,
    severity:
      d.severity === vscode.DiagnosticSeverity.Error
        ? ("error" as const)
        : d.severity === vscode.DiagnosticSeverity.Warning
          ? ("warning" as const)
          : ("info" as const),
    message: d.message,
  })) as DiagnosticPublic[];
  return ctx;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SNAP_SCHEME, snapshotStore),
  );
  const provider = new JarvisViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("jarvis.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    { dispose: () => provider.dispose() },
  );

  const register = (id: string, fn: () => Promise<void> | void): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => {
        void Promise.resolve(fn()).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`JARVIS: ${msg}`);
        });
      }),
    );
  };

  register("jarvis.newTask", async () => {
    await vscode.commands.executeCommand("jarvis.chat.focus");
  });

  register("jarvis.explainSelection", async () => {
    const ctx = collectEditorContext(false);
    if (!ctx.selection) {
      void vscode.window.showInformationMessage(
        "JARVIS: select the code you want explained first.",
      );
      return;
    }
    await provider.send(
      buildTaskPrompt(
        "explain_selection",
        "Explain this selected code: what it does, how it fits the project, and any issues you notice. You may read related files.",
        ctx,
      ),
    );
  });

  register("jarvis.explainFile", async () => {
    const ctx = collectEditorContext(true);
    if (!ctx.file) {
      void vscode.window.showInformationMessage("JARVIS: open a file first.");
      return;
    }
    await provider.send(
      buildTaskPrompt(
        "explain_file",
        "Explain this file: its role, structure, key exports, and notable issues.",
        ctx,
      ),
    );
  });

  register("jarvis.fixProblems", async () => {
    const ctx = collectEditorContext(true);
    if (!ctx.diagnostics?.length) {
      void vscode.window.showInformationMessage(
        "JARVIS: no problems reported for the active file.",
      );
      return;
    }
    await provider.send(
      buildTaskPrompt(
        "fix_problems",
        "Diagnose and fix these editor problems. Investigate first, make targeted changes, then run the relevant checks and report the real results.",
        ctx,
      ),
    );
  });

  register("jarvis.reviewChanges", async () => {
    await provider.poll();
    const task = provider.getTask();
    if (task && task.changedFiles.length > 0) {
      const pick = await vscode.window.showQuickPick(task.changedFiles, {
        placeHolder: "Choose a file to review (before ↔ current)",
      });
      if (pick) await provider.openDiff(pick);
      return;
    }
    void vscode.window.showInformationMessage("JARVIS: no task changes to review.");
  });

  register("jarvis.cancelTask", async () => {
    const task = provider.getTask();
    if (!task || !isActivePhase(task.phase)) {
      void vscode.window.showInformationMessage("JARVIS: no task is running.");
      return;
    }
    await provider.cancelTask();
    void vscode.window.showInformationMessage(`JARVIS: cancelled ${task.id.slice(0, 12)}`);
  });

  register("jarvis.openMemory", async () => {
    const entries = await provider.memoryList();
    if (entries.length === 0) {
      void vscode.window.showInformationMessage("JARVIS: no project memory stored yet.");
      return;
    }
    interface Pick extends vscode.QuickPickItem {
      entryId: string;
      content: string;
    }
    const pick = await vscode.window.showQuickPick<Pick>(
      entries.map((e) => ({
        label: e.content.slice(0, 90),
        description: `${e.kind}${e.stale ? " · STALE" : ""}`,
        detail: e.fileRefs.length ? e.fileRefs.join(", ") : undefined,
        entryId: e.id,
        content: e.content,
      })),
      { placeHolder: "Project memory — select to correct or delete" },
    );
    if (!pick) return;
    const action = await vscode.window.showQuickPick(["Edit", "Delete", "Cancel"], {
      placeHolder: `Memory: ${pick.label}`,
    });
    if (action === "Edit") {
      const next = await vscode.window.showInputBox({
        prompt: "Correct this memory",
        value: pick.content,
      });
      if (next !== undefined && next !== pick.content) {
        await provider.memoryUpdate(pick.entryId, next);
      }
    } else if (action === "Delete") {
      const ok = await vscode.window.showWarningMessage(
        "Delete this memory entry permanently?",
        { modal: true },
        "Delete",
      );
      if (ok === "Delete") await provider.memoryDelete(pick.entryId);
    }
  });
}

export function deactivate(): void {
  // nothing — disposables registered on context.subscriptions clean up
}
