/**
 * JarvisClient against a REAL loopback HTTP server (no fetch mocks).
 * Run: npm test (in vscode-extension/)
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { JarvisClient, JarvisError } from "./client";

const TOKEN = "a".repeat(64);

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        body,
      });
      handler(req, res, body);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    }),
  );
}

const json = (res: http.ServerResponse, status: number, obj: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

test("sends bearer token and JSON body on start", async () => {
  const s = await startServer((_q, res) =>
    json(res, 201, { started: true, taskId: "t1", phase: "UNDERSTANDING" }),
  );
  try {
    const c = new JarvisClient({ baseUrl: s.url, token: TOKEN });
    const r = await c.start("fix tests", "/repo", 10);
    assert.equal(r.taskId, "t1");
    assert.equal(s.seen[0]?.method, "POST");
    assert.equal(s.seen[0]?.auth, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(s.seen[0]?.body ?? "{}"), {
      action: "start",
      task: "fix tests",
      repoRoot: "/repo",
      maxIterations: 10,
    });
  } finally {
    await s.close();
  }
});

test("snapshot() builds the right query", async () => {
  const s = await startServer((_q, res) => json(res, 200, { path: "a/b.ts", before: null }));
  try {
    const c = new JarvisClient({ baseUrl: s.url, token: TOKEN });
    const r = await c.snapshot("t1", "a/b.ts", "/repo");
    assert.equal(r.before, null);
    const u = new URL(s.seen[0]!.url, "http://x");
    assert.equal(u.searchParams.get("taskId"), "t1");
    assert.equal(u.searchParams.get("snapshot"), "a/b.ts");
    assert.equal(u.searchParams.get("repoRoot"), "/repo");
  } finally {
    await s.close();
  }
});

test("401 becomes an auth JarvisError", async () => {
  const s = await startServer((_q, res) => json(res, 401, { error: "Unauthorized" }));
  try {
    const c = new JarvisClient({ baseUrl: s.url, token: TOKEN });
    await assert.rejects(c.status(), (e: unknown) => {
      assert.ok(e instanceof JarvisError);
      assert.equal(e.status, 401);
      assert.equal(e.isAuthError, true);
      assert.equal(e.isConnectionError, false);
      return true;
    });
  } finally {
    await s.close();
  }
});

test("409 busy is distinguishable from a dead backend", async () => {
  const s = await startServer((_q, res) => json(res, 409, { error: "Agent busy", busy: true }));
  try {
    const c = new JarvisClient({ baseUrl: s.url, token: TOKEN });
    await assert.rejects(c.start("do a thing"), (e: unknown) => {
      assert.ok(e instanceof JarvisError);
      assert.equal(e.isBusy, true);
      assert.equal(e.isConnectionError, false);
      return true;
    });
  } finally {
    await s.close();
  }
});

test("connection refused is a clear connection error", async () => {
  // Port 1 on loopback: nothing listens there.
  const c = new JarvisClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN, timeoutMs: 2000 });
  await assert.rejects(c.status(), (e: unknown) => {
    assert.ok(e instanceof JarvisError);
    assert.equal(e.isConnectionError, true);
    assert.match(e.message, /Cannot reach JARVIS backend/);
    return true;
  });
});

test("hung backend hits the request timeout", async () => {
  const s = await startServer(() => {
    /* never respond */
  });
  try {
    const c = new JarvisClient({ baseUrl: s.url, token: TOKEN, timeoutMs: 300 });
    await assert.rejects(c.status(), (e: unknown) => {
      assert.ok(e instanceof JarvisError);
      assert.match(e.message, /timed out/);
      return true;
    });
  } finally {
    await s.close();
  }
});

test("caller abort is reported as cancelled, not timeout", async () => {
  const s = await startServer(() => {
    /* never respond */
  });
  try {
    const c = new JarvisClient({ baseUrl: s.url, token: TOKEN, timeoutMs: 5000 });
    const ac = new AbortController();
    const p = c.status({ signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, /cancelled/);
  } finally {
    await s.close();
  }
});

test("token is never echoed in error messages", async () => {
  const s = await startServer((_q, res) => json(res, 500, { error: "boom" }));
  try {
    const c = new JarvisClient({ baseUrl: s.url, token: TOKEN });
    await assert.rejects(c.status(), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.ok(!e.message.includes(TOKEN));
      return true;
    });
  } finally {
    await s.close();
  }
});
