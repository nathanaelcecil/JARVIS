/**
 * JARVIS backend client for the VS Code extension.
 *
 * No `vscode` imports — unit-testable against a real loopback HTTP server.
 * Auth: bearer token from the workspace's .jarvis/agent-token file.
 * Every request carries a timeout and supports caller AbortSignals; all
 * failures surface as JarvisError with status + structured body, never as
 * silent success.
 */

import {
  DEFAULT_TIMEOUT_MS,
  type ListResponse,
  type MemoryEntryPublic,
  type StatusResponse,
} from "./shared";

export class JarvisError extends Error {
  readonly status?: number;
  readonly body?: unknown;

  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = "JarvisError";
    if (status !== undefined) this.status = status;
    if (body !== undefined) this.body = body;
  }

  /** True when no HTTP response was received (backend down, timeout, DNS). */
  get isConnectionError(): boolean {
    return this.status === undefined;
  }

  /** True when the backend rejected our token. */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  /** True when the engine is already running a task for this workspace. */
  get isBusy(): boolean {
    return this.status === 409;
  }
}

export interface JarvisClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
}

export class JarvisClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JarvisClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request<T>(pathname: string, opts: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: opts.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: unknown = undefined;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!res.ok) {
        const msg =
          parsed && typeof parsed === "object" && "error" in parsed
            ? String((parsed as { error: unknown }).error)
            : `HTTP ${res.status}`;
        throw new JarvisError(msg, res.status, parsed);
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof JarvisError) throw err;
      if ((err as Error)?.name === "AbortError") {
        const timedOut = !opts.signal?.aborted;
        throw new JarvisError(
          timedOut
            ? `Request timed out after ${this.timeoutMs}ms: ${pathname}`
            : `Request cancelled: ${pathname}`,
        );
      }
      const cause = err instanceof Error ? err.message : String(err);
      throw new JarvisError(
        `Cannot reach JARVIS backend at ${this.baseUrl} — is it running? (${cause})`,
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  // ── Typed endpoints ───────────────────────────────────────

  status(
    params: { taskId?: string; repoRoot?: string; signal?: AbortSignal } = {},
  ): Promise<StatusResponse> {
    const q = new URLSearchParams();
    if (params.taskId) q.set("taskId", params.taskId);
    if (params.repoRoot) q.set("repoRoot", params.repoRoot);
    const qs = q.toString();
    return this.request<StatusResponse>(`/api/agent${qs ? `?${qs}` : ""}`, {
      ...(params.signal ? { signal: params.signal } : {}),
    });
  }

  /** Pre-change content of one file the task changed (null = task created it). */
  snapshot(
    taskId: string,
    relPath: string,
    repoRoot?: string,
  ): Promise<{ path: string; before: string | null }> {
    const q = new URLSearchParams({ taskId, snapshot: relPath });
    if (repoRoot) q.set("repoRoot", repoRoot);
    return this.request(`/api/agent?${q.toString()}`);
  }

  list(repoRoot?: string): Promise<ListResponse> {
    const q = new URLSearchParams({ list: "1" });
    if (repoRoot) q.set("repoRoot", repoRoot);
    return this.request<ListResponse>(`/api/agent?${q.toString()}`);
  }

  start(
    task: string,
    repoRoot?: string,
    maxIterations?: number,
  ): Promise<{ started: boolean; taskId: string; phase: string }> {
    return this.request("/api/agent", {
      method: "POST",
      body: {
        action: "start",
        task,
        ...(repoRoot ? { repoRoot } : {}),
        ...(maxIterations !== undefined ? { maxIterations } : {}),
      },
    });
  }

  cancel(taskId: string): Promise<{ cancelled: boolean }> {
    return this.request("/api/agent", {
      method: "POST",
      body: { action: "cancel", taskId },
    });
  }

  approve(taskId: string, approved: boolean): Promise<{ resolved: boolean }> {
    return this.request("/api/agent", {
      method: "POST",
      body: { action: "approve", taskId, approved },
    });
  }

  resume(taskId: string, repoRoot?: string): Promise<{ resumed: boolean }> {
    return this.request("/api/agent", {
      method: "POST",
      body: { action: "resume", taskId, ...(repoRoot ? { repoRoot } : {}) },
    });
  }

  revert(taskId: string, repoRoot?: string): Promise<{ reverted: Record<string, string> }> {
    return this.request("/api/agent", {
      method: "POST",
      body: { action: "revert", taskId, ...(repoRoot ? { repoRoot } : {}) },
    });
  }

  memory(repoRoot?: string): Promise<{ entries: MemoryEntryPublic[] }> {
    const q = new URLSearchParams({ memory: "1" });
    if (repoRoot) q.set("repoRoot", repoRoot);
    return this.request(`/api/agent?${q.toString()}`);
  }

  memoryUpdate(
    id: string,
    patch: { content?: string; kind?: string },
    repoRoot?: string,
  ): Promise<{ entry: MemoryEntryPublic }> {
    return this.request("/api/agent", {
      method: "POST",
      body: { action: "memory_update", id, ...patch, ...(repoRoot ? { repoRoot } : {}) },
    });
  }

  memoryDelete(id: string, repoRoot?: string): Promise<{ deleted: string }> {
    return this.request("/api/agent", {
      method: "POST",
      body: { action: "memory_delete", id, ...(repoRoot ? { repoRoot } : {}) },
    });
  }
}
