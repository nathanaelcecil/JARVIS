/**
 * Coding-agent engine tests.
 *
 * A scripted fake model (deps.chat) drives the real state machine against
 * real temp workspaces: repo tools, allowlisted scripts and verification all
 * execute for real; only the LLM is canned.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  startCodingAgent,
  cancelAgentTask,
  runAgentLoop,
  parseAgentMetadata,
  newFailures,
  resolveAgentApproval,
  isAgentRunning,
  type AgentDeps,
} from "./engine";
import type { AgentTaskRecord, CheckReport } from "./engine-types";
import { listTasks, recoverTasks, loadTask } from "./task-store";
import { promoteTool, demoteTool } from "../guardrails";

// ── helpers ─────────────────────────────────────────────────

const roots: string[] = [];

async function mkWorkspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "jarvis-agent-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
  }
  return root;
}

/** Build a full model response with metadata block. */
function resp(
  text: string,
  extra: {
    tools?: Array<{ tool: string; args: Record<string, unknown> }>;
    state?: string;
    memory?: Array<{ kind: string; content: string }>;
  } = {},
): string {
  const block: Record<string, unknown> = {};
  if (extra.tools) block["tools"] = extra.tools;
  if (extra.state) block["state"] = extra.state;
  if (extra.memory) block["memory"] = extra.memory;
  return `${text}\n---METADATA--- ${JSON.stringify(block)}`;
}

interface ScriptedChat {
  deps: Partial<AgentDeps>;
  calls: Array<{ model: string; turn: number }>;
  onTurn?: (turn: number) => void;
}

function scripted(
  script: Array<string | ((turn: number) => string)>,
  hooks: { onTurn?: (turn: number) => void; onChat?: () => Promise<void> } = {},
): ScriptedChat {
  const calls: Array<{ model: string; turn: number }> = [];
  let turn = 0;
  return {
    calls,
    deps: {
      async chat({ model, signal }) {
        if (hooks.onChat) await hooks.onChat();
        if (signal?.aborted) throw new Error("aborted");
        turn++;
        calls.push({ model, turn });
        hooks.onTurn?.(turn);
        const entry = script[turn - 1];
        if (entry === undefined) {
          throw new Error(`script exhausted at turn ${turn}`);
        }
        return { content: typeof entry === "function" ? entry(turn) : entry };
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

// ── parseAgentMetadata (pure) ───────────────────────────────

describe("parseAgentMetadata", () => {
  it("parses tools, state and memory", () => {
    const m = parseAgentMetadata(
      resp("Done.", {
        tools: [{ tool: "read_file", args: { path: "a.ts" } }],
        state: "INVESTIGATING",
        memory: [{ kind: "convention", content: "uses vitest" }],
      }),
    );
    expect(m.text).toBe("Done.");
    expect(m.tools).toEqual([{ tool: "read_file", args: { path: "a.ts" } }]);
    expect(m.state).toBe("INVESTIGATING");
    expect(m.memories[0]!.content).toBe("uses vitest");
  });

  it("tolerates a missing or malformed metadata block", () => {
    expect(parseAgentMetadata("plain reply").tools).toEqual([]);
    expect(parseAgentMetadata("x\n---METADATA--- not-json").tools).toEqual([]);
    expect(parseAgentMetadata("x\n---METADATA--- [1,2]").tools).toEqual([]);
  });

  it("caps tools per block and drops bad entries", () => {
    const tools = Array.from({ length: 12 }, () => ({
      tool: "overview",
      args: {},
    }));
    tools.push({ tool: "", args: {} });
    const m = parseAgentMetadata(resp("hi", { tools: tools as never }));
    expect(m.tools).toHaveLength(6);
    expect(m.tools.every((t) => t.tool === "overview")).toBe(true);
  });

  it("defaults missing args to an object", () => {
    const m = parseAgentMetadata(`x\n---METADATA--- {"tools":[{"tool":"overview"}]}`);
    expect(m.tools[0]!.args).toEqual({});
  });

  it("tolerates a line-split delimiter (--- then METADATA---)", () => {
    // Real Ollama output that previously "completed" the task with the raw
    // block as the final report.
    const m = parseAgentMetadata(
      'finding files\n---\nMETADATA---\n{"tools":[{"tool":"read_file","args":{"path":"a.ts"}}],"state":"INVESTIGATING"}',
    );
    expect(m.text).toBe("finding files");
    expect(m.tools).toEqual([{ tool: "read_file", args: { path: "a.ts" } }]);
    expect(m.state).toBe("INVESTIGATING");
    expect(m.metaFailed).toBeUndefined();
  });

  it("accepts a bare JSON block when the delimiter is missing entirely", () => {
    // Real Ollama output: no ---METADATA--- at all, just the object.
    const m = parseAgentMetadata('{"tools":[{"tool":"overview","args":{}}]}');
    expect(m.tools).toEqual([{ tool: "overview", args: {} }]);
    expect(m.text).toBe("");
    expect(m.metaFailed).toBeUndefined();
  });

  it("accepts prose followed by a line-leading JSON block (no delimiter)", () => {
    const m = parseAgentMetadata(
      'Let me look around.\n{"state":"INVESTIGATING","tools":[{"tool":"list_tree","args":{}}]}',
    );
    expect(m.text).toBe("Let me look around.");
    expect(m.tools).toEqual([{ tool: "list_tree", args: {} }]);
    expect(m.state).toBe("INVESTIGATING");
  });

  it("accepts tools as plain strings with optional parallel args", () => {
    const m = parseAgentMetadata('{"tools":["overview","read_file"],"args":[{"path":"src/a.ts"}]}');
    expect(m.tools).toEqual([
      { tool: "overview", args: { path: "src/a.ts" } }, // paired by index
      { tool: "read_file", args: {} },
    ]);
  });

  it("leaves prose alone when a trailing JSON object is not metadata", () => {
    const m = parseAgentMetadata('Here is the config:\n{"scripts":{"test":"vitest run"}}');
    expect(m.tools).toEqual([]);
    expect(m.text).toContain("vitest run");
  });

  it("flags an invalid metadata body via metaFailed", () => {
    expect(parseAgentMetadata("x\n---METADATA--- not-json").metaFailed).toBe(true);
    expect(parseAgentMetadata("x\n---METADATA--- [1,2]").metaFailed).toBe(true);
    expect(parseAgentMetadata("plain prose final answer").metaFailed).toBe(undefined);
  });
});

// ── newFailures (pure) ──────────────────────────────────────

describe("newFailures — baseline vs regression", () => {
  const mk = (results: Array<[string, number]>): CheckReport => ({
    at: 1,
    allPassed: results.every(([, c]) => c === 0),
    results: results.map(([name, exitCode]) => ({
      name,
      command: `run ${name}`,
      exitCode,
      timedOut: false,
      durationMs: 1,
      outputTail: "",
    })),
  });

  it("counts failures that were passing in the baseline", () => {
    const base = mk([["test", 0]]);
    const now = mk([["test", 1]]);
    expect(newFailures(base, now).map((f) => f.name)).toEqual(["test"]);
  });

  it("ignores pre-existing failures (already failing at baseline)", () => {
    const base = mk([["lint", 2]]);
    const now = mk([["lint", 2]]);
    expect(newFailures(base, now)).toEqual([]);
  });

  it("treats a brand-new failing script as introduced", () => {
    expect(
      newFailures(
        mk([["test", 0]]),
        mk([
          ["test", 0],
          ["e2e", 1],
        ]),
      ),
    ).toHaveLength(1);
  });

  it("passing runs are never failures", () => {
    expect(newFailures(null, mk([["test", 0]]))).toEqual([]);
  });
});

// ── lifecycle ───────────────────────────────────────────────

describe("agent lifecycle", () => {
  it("read-only task completes with the report as evidence", async () => {
    const root = await mkWorkspace({ "README.md": "# Demo\n" });
    const sc = scripted([
      resp("This project is a demo with one README.", {
        state: "INVESTIGATING",
      }),
    ]);
    const { record, done } = await startCodingAgent(
      { repoRoot: root, title: "Explain this project" },
      sc.deps,
    );
    const final = await done;
    expect(final.phase).toBe("COMPLETED");
    expect(final.finalReport).toContain("demo");
    expect(final.changedFiles).toEqual([]);
    // Real investigation happened: overview() was available; phase events
    // show UNDERSTANDING started.
    expect(final.events.some((e) => e.kind === "phase")).toBe(true);
    expect(final.transcript[0]!.role).toBe("system");
    expect(final.transcript[0]!.content).toContain("Explain this project");
    expect(record.id).toBeTruthy();
  });

  it("nudges instead of completing when the metadata block is malformed", async () => {
    const root = await mkWorkspace({ "README.md": "# Demo\n" });
    const sc = scripted([
      "finding files\n---\nMETADATA---\n{oops", // delimiter OK, JSON broken
      "Solid report about the demo project.\n---METADATA--- {}",
    ]);
    const { done } = await startCodingAgent(
      { repoRoot: root, title: "Explain this project" },
      sc.deps,
    );
    const final = await done;
    expect(sc.calls.length).toBe(2); // nudge → retry, not instant completion
    expect(final.phase).toBe("COMPLETED");
    expect(final.finalReport).toContain("Solid report");
    expect(final.events.some((e) => e.text.includes("Malformed ---METADATA---"))).toBe(true);
    // The nudge told the model exactly how to fix the block.
    expect(
      final.transcript.some(
        (m) => typeof m.content === "string" && m.content.includes("not valid JSON"),
      ),
    ).toBe(true);
  });

  it("returns a corrective result for invented tool names", async () => {
    const root = await mkWorkspace({ "README.md": "# Demo\n" });
    const sc = scripted([
      resp("", { tools: [{ tool: "cat", args: { file: "README.md" } }] }),
      "Inspected the README with the proper tool. Done.",
    ]);
    const { done } = await startCodingAgent({ repoRoot: root, title: "Read the readme" }, sc.deps);
    const final = await done;
    expect(final.phase).toBe("COMPLETED");
    const corrective = final.transcript.find(
      (m) => typeof m.content === "string" && m.content.includes("Unknown tool"),
    );
    expect(corrective).toBeTruthy();
    // The corrective result lists the real tool names.
    expect(corrective!.content as string).toContain("Available tools");
    expect(corrective!.content as string).toContain("read_file");
  });

  it("keeps looping when the model skips the delimiter and sends bare JSON", async () => {
    const root = await mkWorkspace({ "README.md": "# Demo\n" });
    const sc = scripted([
      '{"tools":[{"tool":"overview","args":{}}]}', // no delimiter at all
      "Explored the project: a demo with one README. Done.",
    ]);
    const { done } = await startCodingAgent(
      { repoRoot: root, title: "Explain this project" },
      sc.deps,
    );
    const final = await done;
    expect(sc.calls.length).toBe(2); // overview ran before completion
    expect(final.phase).toBe("COMPLETED");
    expect(final.finalReport).toContain("demo");
    expect(final.events.some((e) => e.kind === "tool_start" && e.text === "overview")).toBe(true);
  });

  it("nudges a placeholder-only reply instead of completing with nothing", async () => {
    const root = await mkWorkspace({ "README.md": "# Demo\n" });
    const sc = scripted([
      "Done.", // nothing investigated, nothing delivered
      "Explored the repo: a demo project with a single README file.",
    ]);
    const { done } = await startCodingAgent(
      { repoRoot: root, title: "Explain this project" },
      sc.deps,
    );
    const final = await done;
    expect(sc.calls.length).toBe(2);
    expect(final.phase).toBe("COMPLETED");
    expect(final.finalReport).toContain("single README");
    expect(final.events.some((e) => e.text.includes("Placeholder-only reply nudged"))).toBe(true);
  });

  it("nudges the model to conclude before the iteration budget expires", async () => {
    const root = await mkWorkspace({ "a.ts": "x\n" });
    const loop = { tools: [{ tool: "overview", args: {} }], state: "INVESTIGATING" };
    const sc = scripted([
      resp("looking", loop),
      resp("still looking", loop),
      resp("still looking", loop),
      resp("Final report: the repo has one file, a.ts, containing x.", {}),
    ]);
    const { done } = await startCodingAgent(
      { repoRoot: root, title: "endless investigate", maxIterations: 4 },
      sc.deps,
    );
    const final = await done;
    expect(final.phase).toBe("COMPLETED");
    expect(
      final.transcript.some(
        (m) =>
          typeof m.content === "string" && m.content.includes("approaching the iteration budget"),
      ),
    ).toBe(true);
    expect(final.finalReport).toContain("one file");
  });

  it("nudges findings that were stored only in memory into a real report", async () => {
    const root = await mkWorkspace({ "a.ts": "x\n" });
    const sc = scripted([
      resp("investigating", {
        tools: [{ tool: "overview", args: {} }],
        state: "INVESTIGATING",
      }),
      resp("", {
        state: "PLANNING",
        memory: [{ kind: "architecture", content: "Uses Vite with TanStack routing." }],
      }),
      "Architecture: the project uses Vite with TanStack routing; src/start.ts is the server entry.",
    ]);
    const { done } = await startCodingAgent(
      { repoRoot: root, title: "Explain architecture" },
      sc.deps,
    );
    const final = await done;
    expect(sc.calls.length).toBe(3); // nudge happened
    expect(final.phase).toBe("COMPLETED");
    expect(final.finalReport).toContain("TanStack");
    expect(final.events.some((e) => e.text.includes("Memory-only findings nudged"))).toBe(true);
  });

  it("persists steps and is listable after completion", async () => {
    const root = await mkWorkspace({ "a.ts": "export const a = 1;\n" });
    const sc = scripted([resp("a.ts exports a single constant named a, defined in one line.")]);
    const { done } = await startCodingAgent({ repoRoot: root, title: "explain a.ts" }, sc.deps);
    await done;
    const tasks = await listTasks(root);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.phase).toBe("COMPLETED");
    const byId = await loadTask(root, tasks[0]!.id);
    expect(byId?.finalReport).toContain("single constant");
  });

  it("stops at the iteration limit instead of looping forever", async () => {
    const root = await mkWorkspace({ "a.ts": "x\n" });
    const loopTool = {
      tools: [{ tool: "overview", args: {} }],
      state: "INVESTIGATING",
    };
    const sc = scripted([
      resp("looking", loopTool),
      resp("looking", loopTool),
      resp("looking", loopTool),
      resp("looking", loopTool),
      resp("looking", loopTool),
    ]);
    const { done } = await startCodingAgent(
      { repoRoot: root, title: "endless investigate", maxIterations: 3 },
      sc.deps,
    );
    const final = await done;
    expect(final.phase).toBe("FAILED");
    expect(final.error).toContain("Iteration limit");
    expect(final.iterations).toBe(3);
    expect(sc.calls.length).toBe(3);
  });

  it("cancels cleanly mid-task (CANCELLED, no lingering run)", async () => {
    const root = await mkWorkspace({ "a.ts": "x\n" });
    let holder: { id: string } = { id: "" };
    const sc = scripted(
      [
        resp("checking", { tools: [{ tool: "overview", args: {} }] }),
        resp("should not get here", { state: "INVESTIGATING" }),
      ],
      {
        onChat: async () => {
          // Let the first turn finish, then block until cancelled.
          if (sc.calls.length >= 1) {
            for (let i = 0; i < 200; i++) {
              await new Promise((r) => setTimeout(r, 10));
              if (holder.id && !isAgentRunning(holder.id)) break;
            }
          }
        },
      },
    );
    const started = await startCodingAgent({ repoRoot: root, title: "cancel me" }, sc.deps);
    holder = started.record;
    // Wait until turn 1 ran, then cancel.
    for (let i = 0; i < 100 && sc.calls.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(cancelAgentTask(started.record.id)).toBe(true);
    const final = await started.done;
    expect(final.phase).toBe("CANCELLED");
    expect(isAgentRunning(started.record.id)).toBe(false);
    // Cancelling again is a no-op.
    expect(cancelAgentTask(started.record.id)).toBe(false);
  });

  it("runs independent read-only tools concurrently, reconciled in order", async () => {
    const root = await mkWorkspace({ "a.ts": "export const a = 1;\n" });
    let inFlight = 0;
    let maxConcurrent = 0;
    const sc = scripted([
      resp("gathering context", {
        tools: [
          { tool: "read_file", args: { path: "a.ts" } },
          { tool: "git_status", args: {} },
          { tool: "list_tree", args: {} },
        ],
        state: "INVESTIGATING",
      }),
      resp("done reading"),
    ]);
    const { done } = await startCodingAgent(
      { repoRoot: root, title: "parallel reads" },
      {
        ...sc.deps,
        async executeTool(tool, args, ctx) {
          inFlight++;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise((r) => setTimeout(r, 40));
          inFlight--;
          // Fall back to the real implementation for behavior.
          const real = await import("./repo-tools");
          if (tool === "read_file") return real.readSourceFile(ctx.policy, args as never);
          if (tool === "git_status") return real.gitStatus(ctx.policy);
          return real.listRepoTree(ctx.policy, args as never);
        },
      },
    );
    const final = await done;
    expect(final.phase).toBe("COMPLETED");
    expect(maxConcurrent).toBeGreaterThan(1);
    // Results are reconciled into the transcript in block order regardless
    // of which finished first.
    const order = final.transcript
      .filter((m) => m.role === "user" && m.content.startsWith("TOOL "))
      .map((m) => m.content.split(" ")[1]);
    expect(order).toEqual(["read_file", "git_status", "list_tree"]);
  });

  it("rejects a duplicate task while one is active", async () => {
    const root = await mkWorkspace({ "a.ts": "x\n" });
    const gate: { release: () => void } = {
      release: () => {},
    };
    const blocked = new Promise<void>((r) => (gate.release = r));
    const sc = scripted([resp("Investigated a.ts: it declares a single line of content.")], {
      onChat: async () => {
        if (sc.calls.length === 0) await blocked;
      },
    });
    const first = await startCodingAgent({ repoRoot: root, title: "long task" }, sc.deps);
    await expect(startCodingAgent({ repoRoot: root, title: "competing task" })).rejects.toThrow(
      /already active/,
    );
    gate.release();
    const final = await first.done;
    expect(final.phase).toBe("COMPLETED");
  });

  it("fails with evidence when the deadline passes", async () => {
    const root = await mkWorkspace({ "a.ts": "x\n" });
    let clock = 1000;
    const sc = scripted([
      resp("working", { tools: [{ tool: "overview", args: {} }] }),
      resp("never reached"),
    ]);
    const record: AgentTaskRecord = {
      id: "agt-test-deadline",
      title: "deadline task",
      repoRoot: root,
      phase: "IDLE",
      model: "m",
      createdAt: clock,
      updatedAt: clock,
      iterations: 0,
      maxIterations: 10,
      steps: [],
      events: [],
      changedFiles: [],
      snapshots: {},
      baseline: null,
      verificationRuns: [],
      transcript: [],
      approval: null,
    };
    const deps: AgentDeps = {
      ...(sc.deps as AgentDeps),
      now: () => clock,
    };
    // Advance the clock past the deadline during the first chat call.
    const origChat = deps.chat;
    deps.chat = async (p) => {
      const r = await origChat(p);
      clock += 100;
      return r;
    };
    const final = await runAgentLoop({ record, deps, deadlineMs: 5 });
    expect(final.phase).toBe("FAILED");
    expect(final.error).toContain("Deadline");
  });
});

// ── approvals ───────────────────────────────────────────────

describe("agent approvals (NEEDS_APPROVAL)", () => {
  it("pauses for approval, executes on approve, records the decision", async () => {
    const root = await mkWorkspace({ "src/app.ts": "export const v = 1;\n" });
    const sc = scripted([
      resp("Updating the constant.", {
        tools: [
          {
            tool: "edit_file",
            args: {
              path: "src/app.ts",
              oldString: "v = 1",
              newString: "v = 2",
            },
          },
        ],
        state: "IMPLEMENTING",
      }),
      resp("Updated v to 2."),
    ]);
    const started = await startCodingAgent({ repoRoot: root, title: "bump v" }, sc.deps);
    // Wait for the pending approval, then approve.
    let sawPending = false;
    for (let i = 0; i < 300; i++) {
      const t = await loadTask(root, started.record.id);
      if (t?.approval?.state === "pending") {
        sawPending = true;
        expect(t.phase).toBe("NEEDS_APPROVAL");
        expect(resolveAgentApproval(t.id, true)).toBe(true);
        break;
      }
      if (t && ["COMPLETED", "FAILED", "CANCELLED"].includes(t.phase)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(sawPending).toBe(true);
    const final = await started.done;
    expect(final.phase).toBe("COMPLETED");
    expect(final.changedFiles).toContain("src/app.ts");
    const after = await fs.readFile(path.join(root, "src/app.ts"), "utf-8");
    expect(after).toContain("v = 2");
    // Original kept for revert.
    expect(final.snapshots["src/app.ts"]).toContain("v = 1");
    expect(final.events.some((e) => e.kind === "approval")).toBe(true);
  });

  it("feeds a denial back to the model and completes honestly", async () => {
    const root = await mkWorkspace({ "src/app.ts": "export const v = 1;\n" });
    const sc = scripted([
      resp("Attempting the edit.", {
        tools: [
          {
            tool: "edit_file",
            args: {
              path: "src/app.ts",
              oldString: "v = 1",
              newString: "v = 9",
            },
          },
        ],
      }),
      resp("Understood — no changes were made, reporting the denial."),
    ]);
    const started = await startCodingAgent({ repoRoot: root, title: "bump v again" }, sc.deps);
    for (let i = 0; i < 300; i++) {
      const t = await loadTask(root, started.record.id);
      if (t?.approval?.state === "pending") {
        expect(resolveAgentApproval(t.id, false)).toBe(true);
        break;
      }
      if (t && ["COMPLETED", "FAILED", "CANCELLED"].includes(t.phase)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const final = await started.done;
    expect(final.phase).toBe("COMPLETED");
    expect(final.changedFiles).toEqual([]);
    const after = await fs.readFile(path.join(root, "src/app.ts"), "utf-8");
    expect(after).toContain("v = 1"); // untouched
    // The transcript must contain the denial feedback.
    const fedBack = final.transcript.some((m) =>
      m.content.includes("Approval denied for edit_file"),
    );
    expect(fedBack).toBe(true);
  });
});

// ── verification & self-correction ──────────────────────────

describe("verification and self-correction", () => {
  beforeEach(() => {
    // Writes are auto-approved in these scenarios (trust promotion is the
    // documented mechanism for repeated, reviewed operations).
    promoteTool("agent.write_file");
    promoteTool("agent.edit_file");
  });
  afterEach(() => {
    demoteTool("agent.write_file");
    demoteTool("agent.edit_file");
  });

  const CHECK_SCRIPT =
    "node -e \"const s=require('fs').readFileSync('src/app.js','utf8'); if(s.trim()!=='OK'){console.error('expected exactly OK in app.js, got:',JSON.stringify(s)); process.exit(1);} console.log('1 passing')\"";

  it("captures a passing baseline, detects a regression, corrects, verifies", async () => {
    const root = await mkWorkspace({
      "package.json": JSON.stringify({
        name: "fx",
        scripts: { test: CHECK_SCRIPT },
      }),
      "src/app.js": "OK\n",
    });

    const sc = scripted([
      // 1: introduce the regression
      resp("Adding the marker logic.", {
        tools: [
          {
            tool: "write_file",
            args: { path: "src/app.js", content: "BROKEN\n" },
          },
        ],
        state: "IMPLEMENTING",
      }),
      // 2: claims done — engine verification catches it
      resp("All done, tests pass."),
      // 3: receives the REAL failure output, fixes it
      resp("Correcting the marker.", {
        tools: [
          {
            tool: "write_file",
            args: { path: "src/app.js", content: "OK\n" },
          },
        ],
        state: "CORRECTING",
      }),
      // 4: final claim — engine re-verifies and passes
      resp("Fixed and verified."),
    ]);

    const { done } = await startCodingAgent(
      { repoRoot: root, title: "keep app.js valid" },
      sc.deps,
    );
    const final = await done;

    expect(final.phase).toBe("COMPLETED");
    // Baseline was captured BEFORE the first edit and passed.
    expect(final.baseline).not.toBeNull();
    expect(final.baseline!.results[0]!.exitCode).toBe(0);
    // At least two verification runs: one failing, one passing.
    expect(final.verificationRuns.length).toBeGreaterThanOrEqual(2);
    const runs = final.verificationRuns.map((r) => r.allPassed);
    expect(runs).toContain(false);
    expect(runs[runs.length - 1]).toBe(true);
    // Evidence in the final report.
    expect(final.finalReport).toContain("exit 0");
    // The model actually saw the failure output before correcting.
    const sawFailure = final.transcript.some((m) => m.content.includes("NEW failures"));
    expect(sawFailure).toBe(true);
    // File is restored to a passing state.
    expect(await fs.readFile(path.join(root, "src/app.js"), "utf-8")).toBe("OK\n");
    expect(final.steps.some((s) => s.phase === "CORRECTING")).toBe(true);
  });

  it("does not block completion on pre-existing failures", async () => {
    const root = await mkWorkspace({
      "package.json": JSON.stringify({
        name: "fx",
        scripts: { test: "node -e \"console.error('pre-existing'); process.exit(1)\"" },
      }),
      "src/app.js": "keep\n",
    });
    const sc = scripted([
      resp("Making a small change.", {
        tools: [
          {
            tool: "write_file",
            args: { path: "src/app.js", content: "keep changed\n" },
          },
        ],
      }),
      resp("Done. The failing test predates this change."),
    ]);
    const { done } = await startCodingAgent({ repoRoot: root, title: "tiny edit" }, sc.deps);
    const final = await done;
    expect(final.phase).toBe("COMPLETED");
    expect(final.baseline!.results[0]!.exitCode).toBe(1); // failing at baseline
    expect(
      final.finalReport!.includes("pre-existing") || final.finalReport!.includes("exit 1"),
    ).toBe(true);
    // And the final verification did not invent new failures.
    const lastRun = final.verificationRuns.at(-1)!;
    expect(newFailures(final.baseline, lastRun)).toEqual([]);
  });

  it("fails with evidence when correction rounds are exhausted", async () => {
    const root = await mkWorkspace({
      "package.json": JSON.stringify({
        name: "fx",
        scripts: { test: CHECK_SCRIPT },
      }),
      "src/app.js": "OK\n",
    });
    const breakEdit = {
      tools: [{ tool: "write_file", args: { path: "src/app.js", content: "BROKEN\n" } }],
      state: "IMPLEMENTING",
    };
    const sc = scripted([
      resp("breaking it", breakEdit),
      resp("done"), // → failure1 → correcting
      resp("done"), // → failure2 → correcting
      resp("done"), // → failure3 → correcting
      resp("done"), // → still failing → FAILED
    ]);
    const { done } = await startCodingAgent({ repoRoot: root, title: "unfixable" }, sc.deps);
    const final = await done;
    expect(final.phase).toBe("FAILED");
    expect(final.error).toContain("new check failures");
    expect(final.verificationRuns.length).toBeGreaterThanOrEqual(3);
  });

  it("completes when the workspace declares no verification scripts", async () => {
    const root = await mkWorkspace({
      "src/app.js": "x\n",
      "notes.md": "plain workspace\n",
    });
    const sc = scripted([
      resp("Updating notes.", {
        tools: [
          {
            tool: "write_file",
            args: { path: "notes.md", content: "updated\n" },
          },
        ],
      }),
      resp("Done — no checks are declared here."),
    ]);
    const { done } = await startCodingAgent({ repoRoot: root, title: "edit notes" }, sc.deps);
    const final = await done;
    expect(final.phase).toBe("COMPLETED");
    expect(final.finalReport).toContain("No project checks are declared");
  });
});

// ── restart recovery ────────────────────────────────────────

describe("restart recovery", () => {
  it("marks mid-flight tasks as interrupted + resumable, keeps terminals", async () => {
    const root = await mkWorkspace({ "a.ts": "x\n" });
    const dir = path.join(root, ".jarvis");
    await fs.mkdir(dir, { recursive: true });
    const base = {
      model: "m",
      createdAt: 1,
      updatedAt: 1,
      iterations: 1,
      maxIterations: 10,
      steps: [],
      events: [],
      changedFiles: [],
      snapshots: {},
      baseline: null,
      verificationRuns: [],
      transcript: [],
      approval: null,
      repoRoot: root,
    };
    await fs.writeFile(
      path.join(dir, "tasks.json"),
      JSON.stringify({
        version: 1,
        tasks: [
          { ...base, id: "agt-live", title: "t", phase: "IMPLEMENTING" },
          { ...base, id: "agt-done", title: "t2", phase: "COMPLETED" },
        ],
      }),
    );
    const recovered = await recoverTasks(root);
    const live = recovered.find((t) => t.id === "agt-live")!;
    const doneTask = recovered.find((t) => t.id === "agt-done")!;
    expect(live.phase).toBe("CANCELLED");
    expect(live.interrupted).toBe(true);
    expect(live.error).toContain("resumable");
    expect(doneTask.phase).toBe("COMPLETED");
    expect(doneTask.interrupted).toBeUndefined();
  });
});
