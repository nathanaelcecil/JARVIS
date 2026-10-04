/**
 * Terminal tool — run shell commands with:
 * - Per-task AbortSignal (SIGTERM → SIGKILL after grace period)
 * - Command classification: auto / confirm / never
 * - Timeout enforcement
 * - stdout + stderr capture
 */

import { spawn, type ChildProcess } from "child_process";

// ── Command classification ──────────────────────────────────

type Classification = "auto" | "confirm" | "never";

/** Patterns that are NEVER allowed — destructive or credential-touching */
const NEVER_PATTERNS: RegExp[] = [
  /\brm\s+(-[rRf]+\s+|--recursive)/,           // rm -rf, rm -R
  /\brm\s+-[f].*\//,                            // rm -f /something
  /\bgit\s+push\s+.*--force/,                   // git push --force
  /\bgit\s+push\s+.*-f\b/,                      // git push -f
  /\bgit\s+reset\s+--hard/,                     // git reset --hard
  /\bgit\s+clean\s+-[fd]+/,                     // git clean -fd
  /\bgit\s+branch\s+-D/,                        // git branch -D (force delete)
  /\bmkfs\b/,                                   // format disk
  /\bdd\s+.*of=\/dev\//,                        // dd to device
  /\bchmod\s+(-R\s+)?777\b/,                    // chmod 777
  /\bsudo\b/,                                   // any sudo
  /\bsu\s+-/,                                   // su -
  /\bkill\s+-9\s+1\b/,                          // kill -9 PID 1
  /\bshutdown\b/,                               // shutdown
  /\breboot\b/,                                 // reboot
  /\bhwctl\b.*--reboot/,                        // hwctl reboot
  /\/etc\/passwd/,                              // touching passwd
  /\/etc\/shadow/,                              // touching shadow
  /\.env(\..*)?$/,                              // any .env file
  /\bcredentials?\b.*\bwrite\b/i,               // writing credentials
  /\bcurl\b.*\b(Bearer|token|password|secret)\b/i, // curling with secrets
  /\bwget\b.*\b(password|token|secret)\b/i,     // wget with secrets
];

/** Patterns that are state-changing (need confirmation) */
const CONFIRM_PATTERNS: RegExp[] = [
  /\bnpm\s+(install|i|ci)\b/,                   // npm install
  /\byarn\s+(add|install)\b/,                    // yarn add
  /\bbun\s+(add|install)\b/,                     // bun add
  /\bpip\s+install\b/,                          // pip install
  /\bgit\s+commit\b/,                           // git commit
  /\bgit\s+push\b/,                             // git push (non-force)
  /\bgit\s+merge\b/,                            // git merge
  /\bgit\s+rebase\b/,                           // git rebase
  /\bgit\s+checkout\s+-b\b/,                    // git checkout -b
  /\bgit\s+branch\s+(?!.*-d\b)/,                // git branch (create)
  /\bgit\s+stash\s+drop\b/,                     // git stash drop
  /\bnpx\s+(create|init)\b/,                    // npx create
  /\b(cd|mkdir|touch|mv|cp)\b.*\//,             // file mutations
  /\b>\s*\S/,                                   // redirects (create/overwrite files)
  /\b>>\s*\S/,                                  // appends
  /\bcat\s+.*>\s*\S/,                           // cat > file
  /\btee\b/,                                    // tee
  /\bstart\b|\bopen\b.*-a\b/,                  // launching processes
  /\bbrew\s+install\b/,                         // brew install
  /\bbrew\s+uninstall\b/,                       // brew uninstall
  /\bport\s+install\b/,                         // port install
  /\bdocker\s+(run|create|rm|stop|kill)\b/,     // docker mutations
  /\bkubectl\s+(create|delete|apply|patch)\b/,  // k8s mutations
  /\bterraform\s+(apply|destroy|import)\b/,     // terraform mutations
];

/** Patterns that are read-only (auto-approve) */
const AUTO_PATTERNS: RegExp[] = [
  /\bgit\s+(status|log|diff|show|branch\s*-l?|remote\s*-v|stash\s*list|blame)\b/,
  /\bls\b/,
  /\bcat\b(?!.*\s*>\s*\S)/,                    // cat without redirect
  /\bpwd\b/,
  /\bwhich\b/,
  /\bwhere\b/,
  /\bfile\b/,
  /\bwc\b/,
  /\bgrep\b(?!.*\s+>\s*\S)/,                    // grep without redirect
  /\bfind\b(?!.*\s+>\s*\S)/,                    // find without redirect
  /\bhead\b/,
  /\btail\b/,
  /\bdate\b/,
  /\benv\b/,
  /\becho\b(?!.*\s*>\s*\S)/,                    // echo without redirect
  /\bnpm\s+(test|run\s+\w+|start|list)\b/,
  /\bnpx\s+(eslint|prettier|tsc|vitest|jest)\b/,
  /\bnode\s+-e\b/,
  /\bbun\s+(test|run)\b/,
  /\bcargo\s+(test|build|check|clippy)\b/,
  /\brustc\b/,
  /\bpython\b(?!.*-c\b.*import\s+os)/,
  /\bgit\s+fetch\b/,
];

function classifyCommand(command: string): { classification: Classification; reason: string } {
  const trimmed = command.trim();

  // Check NEVER first — highest priority
  for (const pattern of NEVER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { classification: "never", reason: `Command matches destructive/forbidden pattern: ${pattern.source}` };
    }
  }

  // Check CONFIRM
  for (const pattern of CONFIRM_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { classification: "confirm", reason: `Command is state-changing: ${pattern.source}` };
    }
  }

  // Check AUTO
  for (const pattern of AUTO_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { classification: "auto", reason: `Command is read-only` };
    }
  }

  // Default: confirm (anything we can't classify needs human review)
  return { classification: "confirm", reason: "Unknown command pattern — requiring confirmation" };
}

// ── Execution ───────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;   // 30s default
const MAX_TIMEOUT_MS = 300_000;      // 5min max
const SIGKILL_GRACE_MS = 3_000;      // 3s between SIGTERM and SIGKILL

export interface RunCommandResult {
  success: boolean;
  command: string;
  classification: Classification;
  classificationReason: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
  error?: string;
}

export function classifyShellCommand(command: string): {
  classification: Classification;
  reason: string;
} {
  return classifyCommand(command);
}

/**
 * Run a shell command. Honors AbortSignal for cancellation.
 * Returns full output (stdout + stderr) and exit code.
 */
export function runCommand(args: {
  command: string;
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const { command, cwd, signal } = args;
    const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    const classification = classifyCommand(command);

    // Block NEVER commands immediately
    if (classification.classification === "never") {
      resolve({
        success: false,
        command,
        classification: "never",
        classificationReason: classification.reason,
        exitCode: null,
        stdout: "",
        stderr: `BLOCKED: ${classification.reason}`,
        timedOut: false,
        killed: false,
        durationMs: 0,
      });
      return;
    }

    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;

    // Spawn the shell
    const child: ChildProcess = spawn("bash", ["-c", command], {
      cwd: cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb" },
    });

    // Capture stdout
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    // Capture stderr
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Timeout timer
    const timeoutId = setTimeout(() => {
      timedOut = true;
      // SIGTERM first
      try { child.kill("SIGTERM"); } catch { /* ignore */ }

      // SIGKILL after grace period
      setTimeout(() => {
        if (!child.killed) {
          killed = true;
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, SIGKILL_GRACE_MS);
    }, timeout);

    // Abort signal handler
    const abortHandler = () => {
      if (signal?.aborted) {
        timedOut = true;
        killed = true;
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        setTimeout(() => {
          if (!child.killed) {
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
          }
        }, SIGKILL_GRACE_MS);
      }
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    // Child process exit
    child.on("close", (code) => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortHandler);
      const durationMs = Date.now() - startTime;

      // Truncate very long output
      const MAX_OUTPUT = 50_000;
      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.slice(0, MAX_OUTPUT) + `\n\n... [truncated — ${stdout.length} total chars]`;
      }
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.slice(0, MAX_OUTPUT) + `\n\n... [truncated — ${stderr.length} total chars]`;
      }

      resolve({
        success: code === 0,
        command,
        classification: classification.classification,
        classificationReason: classification.reason,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        killed,
        durationMs,
      });
    });

    // Spawn error (e.g., command not found)
    child.on("error", (err) => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortHandler);
      const durationMs = Date.now() - startTime;

      resolve({
        success: false,
        command,
        classification: classification.classification,
        classificationReason: classification.reason,
        exitCode: null,
        stdout,
        stderr: stderr || err.message,
        timedOut: false,
        killed: false,
        durationMs,
        error: err.message,
      });
    });
  });
}
