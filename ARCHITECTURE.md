# JARVIS — Architecture & Integration Handoff

> Prepared for an independent review against
> [atticus-mac](https://github.com/SaarthurR/atticus-mac).
> This document describes the code that exists, not an intended design.
> Last verified: 2026-10-25, branch `jarvis-agent-wip` (commit `942ab0c` plus
> uncommitted work). See “Verification” at the end for what was run.

---

## 1. Runtime topology

```
Browser (React 19 / TanStack Start)
  │  SSE /api/stream, JSON /api/confirm, /api/proactive, /api/transcribe
  ▼
TanStack Start server (Vite 8 / Nitro, local Bun process)
  ├── /api/stream ──► Ollama (localhost:11434, OpenAI-compatible)
  │        │              └── optional data pre-pass (Gmail/Calendar/Notion)
  │        ├── local tool agent (127.0.0.1:3008, bearer secret)
  │        ├── Supabase (optional: messages, memory, behaviors, schedules)
  │        └── coding agent (in-process, /api/agent)
  ├── /api/agent ◄── VS Code extension (bearer token .jarvis/agent-token)
  ├── /api/auth/google ──► Google OAuth ──► Supabase google_tokens
  └── /api/proactive ──► 15 s scheduler ──► Supabase + macOS banner
  ▼
XTTS-v2 Python server (127.0.0.1:8080)  ◄── /api/speak server function
```

Everything runs on one Mac. There is no hosted backend and no cloud model
provider in the active path.

### Entry points

| Entry | File | Role |
| --- | --- | --- |
| Start config | `src/start.ts` | CSRF middleware for server functions, SSR error wrapper |
| Server fetch | `src/server.ts` | Cloudflare/Nitro worker entry, h3 error normalization |
| Router | `src/router.tsx` | TanStack router |
| Root layout | `src/routes/__root.tsx` | HTML shell, styles, error boundary |
| Main page | `src/routes/index.tsx` | Chat UI, SSE client, TTS and reveal orchestration |
| One-click launch | `start-jarvis.command` | Python/venv/XTTS + local agent + `bun run dev` |

The production build targets `cloudflare-module` through Nitro, but the app is
designed as a single local process. In-memory state (task registry,
confirmations, context cache, agent controllers, scheduler timer) is **not**
worker-safe or multi-instance-safe. Treat the current deployment model as one
local Bun/Node process.

---

## 2. Frontend

`src/routes/index.tsx` owns the conversation state machine:

1. User submits text, an image, or a transcribed voice clip.
2. Fast local commands (open app, volume, battery, etc.) are recognized in
   `stream.ts` before the model is called.
3. Otherwise `fetch("/api/stream")` opens an SSE stream and parses events:
   `ack`, `perf`, `user_saved`, `token`, `tool_start`, `confirm_request`,
   `tool_result`, `done`, `error`.
4. `token` deltas are accumulated **and** pushed into `StreamingTTSManager`;
   the visible transcript is not painted from tokens directly. The reveal loop
   owns display so text cannot outrun speech.
5. `confirm_request` opens the approval UI; the decision posts to
   `/api/confirm`.
6. `/api/proactive` is polled for reminders/check-ins/task-completion messages.

Supporting components: `JarvisCore.tsx` (Canvas amber core, driven by
`jarvis-core.ts`), `ChatInput.tsx` (text, mic, camera, attachments),
`MessageList.tsx` (reveal-aware rendering, edit/retry), `ConfirmAction.tsx`,
`PatternProposal.tsx`, `StatusOverlay.tsx`, `CameraPanel.tsx`.

The `src/components/ui/` directory is an unused shadcn/Radix kit. It is kept
deliberately as UI scaffolding; it is not on the current render path.

---

## 3. Backend routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/stream` | none (loopback app) | Chat SSE: fast path, data pre-pass, model stream, tool execution |
| `GET /api/agent` | Bearer `.jarvis/agent-token` | Task list/status/diffs/memory |
| `POST /api/agent` | Bearer | start/cancel/approve/resume/revert/memory edit |
| `POST /api/confirm` | none | Resolve a pending confirm-tier tool (3 min expiry) |
| `GET/POST /api/proactive` | none | Poll pending messages; local-agent task callback |
| `POST /api/transcribe` | none | Mic audio → local whisper.cpp text |
| `GET /api/auth/google` | none | Redirect to Google consent |
| `GET /api/auth/google/callback` | none | Exchange code, store tokens |
| Server fn `speak` | CSRF-protected | Text → XTTS → base64 WAV data URL |
| Server fn `getTaskStatus` / `killSwitch` | CSRF-protected | Status and stop |

### Chat pipeline (`src/routes/api/stream.ts`)

1. **Kill switch / validation** — reject when halted; parse body.
2. **Route classification** — `router.ts` picks FAST/SMART/RESEARCH/CODING/
   VISION/AGENT and a model.
3. **Fast path** — deterministic regex commands (open app, volume, battery,
   etc.) skip the model entirely.
4. **Data pre-pass** — for Gmail/Calendar/Notion intents, `data-tools.ts`
   either builds a deterministic plan or asks the model for a strict JSON plan,
   runs those tools, and injects their real results into the prompt.
5. **Context load** — `context-cache.ts` serves memories/behaviors/history
   from RAM (60 s / 60 s / 30 min TTL), falling back to Supabase.
6. **Stream** — `OllamaProvider.chatStream()` yields deltas. `visibleReply()`
   holds back a partial `---METADATA---` marker so it never leaks to screen or
   TTS.
7. **Metadata** — after the stream, the full reply is parsed for
   `tools`, `memory`, `correction`, `inferredPattern`.
8. **Permissions** — `guardrails.checkPermission()` classifies each tool:
   `auto` runs, `confirm` registers a promise and emits `confirm_request`,
   `never` is refused. `EXPIRED` is never reported as a user denial.
9. **Execute** — `mcp/registry.ts` dispatches to the local agent or a
   server-side handler. Results stream back as `tool_result`.
10. **Persist** — assistant message, memory entries, learned behaviors, and
    activity log are written to Supabase (best-effort) and the cache is kept
    coherent.
11. **Done** — `done` includes the final text, task id, route, custody status.

Cancellation is per-request (`task-registry.ts`, in-memory `AbortController`),
not the old global controller.

---

## 4. Voice pipeline

### Speech out

```
model text
  → speech-text.toSpeechText()        strip markdown/URLs/emoji-safe cleanup
  → findSentenceBoundary / splitIntoSpeechChunks   sentence-aware ≤ ~300 chars
  → speak() server fn                 POST XTTS_URL/speak (2 min timeout)
  → xtts_server.py                    XTTS-v2, optional voice_sample.wav
  → base64 WAV data URL
  → audio-queue.StreamingTTSManager   decode + schedule on one AudioContext
  → reveal.revealedText()             audio-clock → word-snapped text reveal
```

Key properties:

- **One clock.** `AudioContext.currentTime` is authoritative; clips are
  gaplessly scheduled with `nextStart()`, not separate `<audio>` elements.
- **Stateless reveal.** `revealedLength(transcript, clips, now)` recomputes
  from the clock, so backgrounded-tab catch-up is correct.
- **Failure convergence.** Cancellation, TTS failure, playback error, and
  completion all reveal remaining text; text is never permanently hidden.
- **Generation counter.** `stopAudio()` invalidates all prior loops/sources.
- **Privacy.** Server logs only character/byte counts and latency, never text.

### Speech in

`ChatInput.tsx` records `MediaRecorder` (webm/opus) → `/api/transcribe`
(base64, 30 MB cap) → `ffmpeg` to 16 kHz mono WAV → `whisper-cli` with
`models/ggml-small.en.bin` → `{ text }`. This replaced the Web Speech API
because it routed audio through Google.

### XTTS server

`xtts_server.py` binds `127.0.0.1:8080`, loads
`tts_models/multilingual/multi-dataset/xtts_v2`, exposes `POST /speak` and
`GET /health`, and forwards only whitelisted tuning parameters
(`ALLOWED_PARAMS`). It auto-accepts the Coqui CPML license via
`COQUI_TOS_AGREED=1`. No authentication; loopback only.

---

## 5. AI provider and routing

`src/lib/ai/provider.ts` defines `AIProvider`:

```ts
chat({ messages, model, signal?, temperature?, raw?, timeoutMs? })
chatStream?({ messages, model, signal? })
```

- **Active:** `OllamaProvider`, OpenAI-compatible `POST /chat/completions`.
  Default `qwen2.5:14b`; `OLLAMA_BASE_URL`, `OLLAMA_API_KEY` configurable.
  It pins the model with a native `/api/generate` keep-alive request
  (`OLLAMA_KEEP_ALIVE=-1`) because `/v1` ignores `keep_alive`.
- **Dormant:** `ZAIProvider` (GLM, with retry/backoff) and `GeminiProvider`
  remain in the file; `FallbackProvider` exists. `createProvider()` returns
  Ollama unconditionally, so none of these are reachable without a code edit.
- `raw: true` returns the full reply including `---METADATA---` for the agent;
  the chat UI gets the stripped text.
- `timeoutMs` default 120 s; the agent uses 240 s per turn.

`router.ts` is a regex/keyword classifier over six classes. Every class maps to
`qwen2.5:14b` except VISION (`qwen2.5vl:7b`), each overridable through
`OLLAMA_*_MODEL`. It is a latency/behavior heuristic, not an ML router.

`system-prompt.ts` is a byte-stable static prefix (Ollama prompt-cache
friendly) plus dynamic memory/behavior/mode blocks. The model is required to
end every reply with a `---METADATA---` JSON block; `stream.ts` strips it from
all user-visible and spoken output.

---

## 6. Tools, MCP registry, permissions

`src/lib/mcp/registry.ts` is a static catalog (`MCP_REGISTRY`) plus a dispatch
map (`SERVER_DISPATCH`). Three execution classes:

1. **Local agent** — `http://127.0.0.1:3008/call`, bearer secret read from
   `local-agent/.agent-secret`, plus a per-call approval token for confirm-tier
   tools (HMAC under `local-agent/.approval-key`, minted only after a real
   approval). Tools: filesystem, desktop, system, terminal, GitHub, Playwright
   browser, background jobs, notifications, read-only screen observation
   (Hands v1), computer control (Hands v2, every acting tool confirm-tier), and
   the macOS integrations in `local-agent/tools/mac.ts` — `spotlight_search`
   (`mdfind`, matches inside documents), `contacts_search` (Automation), and
   `spotify_status` / `spotify_control` (transport plus URI play/queue).
2. **Server-side** — Gmail, Calendar, Notion, proactive reminders,
   `history_search` over the saved conversation, the profile store
   (`.jarvis/profile.json`), routines/watches/procedures, and the coding agent
   (`start_coding_agent`, `coding_task_status`). These run in-process because
   they need Supabase OAuth tokens, the local filesystem or the engine.
3. **Coding agent in chat** — `start_coding_agent` always runs against
   `process.cwd()`; the model cannot re-aim the workspace. VS Code sends its
   own workspace through the authenticated `/api/agent` endpoint.

`guardrails.ts` owns permissions:

- `auto`: read-only (list/read/search/status/volume/battery, Gmail reads,
  Notion reads, browser reads, memory recall, agent reads, **Hands reads** —
  they observe the screen and cannot act on it).
- `confirm`: state-changing (open/quit app, set volume, terminal commands,
  Gmail send/reply/forward, Calendar writes, Notion writes, browser
  click/type/download, `write_file`, `edit_file`, `run_script`, git commit/push).
- `never`: `system.shutdown`, `system.factory_reset`.
- Unknown tools default to `confirm`. `promoteTool()` can move a confirm tool to
  auto in-process, but never-tier tools cannot be promoted.
- `logActivity()` is a no-op when Supabase credentials are absent.

Tool results and repository content are treated as untrusted data. The agent
prompt explicitly says repo text can never grant permissions or change rules,
and `src/lib/untrusted.ts` fences third-party results (window contents, web
pages, mail, Notion pages, repo files) with an explicit
`[BEGIN UNTRUSTED CONTENT from <tool> …]` marker before they are handed to a
model. Forged copies of the marker inside the payload are neutralised so
content cannot close the fence and speak as JARVIS.

### Hands — observation and control, two separate binaries

The defining decision: looking and acting are different binaries with different
macOS permissions.

```
native/jarvis-hands/          → bin/jarvis-hands            OBSERVE only
native/jarvis-hands-control/  → bin/jarvis-hands-control    ACT only
```

macOS grants Accessibility per binary, so the user can revoke control and keep
observation (or the reverse). Neither binary can do the other's job, and a
static test fails the suite if the observation helper ever grows a control API
(`local-agent/tools/hands.test.ts`) or the control helper loses its permission
gate (`local-agent/tools/control.test.ts`).

**Observation — `hands_*`, all `auto` tier**

- `hands_list_windows` → on-screen windows (pid, AX window index, app, title,
  bounds, focused)
- `hands_read_window(pid, windowIndex?)` → that window's accessibility text
- `hands_read_focused` → frontmost window's text plus the focused element's role
- `hands_read_screen(pid, windowIndex?)` → the AX-then-OCR ladder: accessibility
  text first, and when the window exposes none (canvas, PDF reader, image,
  video, some Electron apps) a cropped screenshot is read with Apple's Vision
  OCR. This is what makes visual windows answerable at all.
- `hands_look(display?, pid?, windowIndex?)` → capture a private PNG (0700 dir,
  pruned after 10 minutes) and return its path for a vision-capable model
- `hands_status` → whether macOS granted Accessibility / Screen Recording

The observation helper contains no `AXUIElementPerformAction`, no
`CGEvent` posting, no keystroke, no `NSWorkspace` launch and no file writes.
`AXSecureTextField` values are skipped, so passwords never enter the tree read.
OCR only accepts paths inside its own screenshot directory, so it is not a
general file reader.

**Control — `control_*`, `confirm` tier**

| Tool | What it does |
| --- | --- |
| `control_map(pid, windowIndex?)` | list addressable controls (role, label, x/y, enabled, pressable) — `auto` |
| `control_status()` | permission report for the control helper — `auto` |
| `control_click(pid, label?/role?/near?/x,y?, double?, right?, verify?)` | AXPress when the element supports it, else a synthetic click at the element's centre |
| `control_type(text, pid?, label?, submit?, verify?)` | focus the field, then type via unicode key events; refuses secure fields |
| `control_key(combo, times?, pid?)` | `cmd+shift+t`, arrows, F-keys, Return/Tab/Escape, from a fixed key table |
| `control_scroll(dy, dx?, pid?, x?, y?)` | pixel-unit wheel events |
| `control_drag(from, to, pid?)` | press, 10 interpolated drags, release |
| `control_menu(pid, path "File>Export>PDF")` | accessibility menu traversal, ≤6 levels |
| `control_place(pid, where left\|right\|full\|fullscreen\|center)` | window geometry via AXPosition/AXSize, reported back as actual |
| `control_focus(pid, title?)` | activate the app and raise the matching window |

Every acting tool is `confirm` tier in both permission tables, and the local
agent refuses it without a valid approval token — the bearer secret alone can
never click or type. Clicks and keys are delivered **to the pid**
(`CGEvent.postToPid`) by default, so acting does not move the user's pointer or
change their front app; `--global` is the opt-in exception, and `control_focus`
is the only way to raise a window.

The helper refuses to guess: a label matching several controls returns
`ambiguous` with up to five candidates (role, label, x/y) instead of picking
one. It also enforces its own limits — coordinates outside every display are
rejected, chords and menu paths are parsed against a fixed grammar, text is
capped at 4,000 characters, and secure password fields are never typed into.

The local agent spawns both helpers with `execFile` and an argv array — never a
shell string — so an argument can never be interpreted as shell syntax. Without
Accessibility permission every tool returns an explicit `accessibility_denied`
(or `helper_missing` for an unbuilt binary) rather than silently degrading, and
the system prompt tells JARVIS to explain the grant and the split.

### Automation — routines, watches, learned procedures

`src/lib/automation/` adds the "does things on its own" half without a second
daemon and without Supabase:

| Module | Responsibility |
| --- | --- |
| `schedule.ts` | Parses `"every 30 minutes"`, `"every 2 hours"`, `"every day at 08:30"`, `"every weekday at 9am"`, `"every monday at 9"` into a typed recurrence, and computes the next run in local time. Anything else is refused with the accepted forms. |
| `routines.ts` | File-backed routine store (`.jarvis/routines.json`, atomic writes, per-file lock). `dueRoutines()` claims and advances in one write, so two overlapping ticks cannot double-fire. Claimed prompts go to `.jarvis/routine-outbox.json`. A mutation that changes nothing skips the write entirely, so an idle tick costs one small read and creates no files. |
| `watches.ts` | Pure `evaluateWatch(watch, observation)` plus a poller. Window watches fire on transitions (`shows`, `gone`, `settled` after two polls); command watches fire when the test starts passing. No model is involved while waiting. |
| `procedures.ts` | Learned phrases → tool step lists. Matching is exact after normalisation (a fuzzy match could replay the wrong thing). `isReplaySafe` refuses never-tier tools and steps whose arguments look destructive. |
| `tick.ts` | One pass: claim routines → outbox + banner, then poll watches. Contained per item; a broken watch never blocks reminder delivery. |

The existing 15 s scheduler (`src/lib/proactive/scheduler.ts`) calls
the automation tick, so there is one clock in the process. `/api/proactive`
returns `{ messages, routines }`: messages are things JARVIS said, routine
entries are prompts to **run**, and the UI submits them one at a time as a
normal user turn (never while a turn is already streaming).

Stored state is local and private: `.jarvis/` is git-ignored, the files are
written `0600`, and a routine or watch survives a restart because it is read
from disk on the next tick.

Screen questions are detected narrowly in `data-tools.ts` (`looksLikeScreenRequest`)
and run in the data pre-pass, so the answer is grounded in what was actually
read: a bare "window"/"screen" word does not spawn the helper.

---

## 7. Coding agent

### Loop

`src/lib/agent/engine.ts` runs a bounded state machine:

`IDLE → UNDERSTANDING → INVESTIGATING → PLANNING → IMPLEMENTING → TESTING →
CORRECTING → COMPLETED | FAILED | CANCELLED | NEEDS_APPROVAL`

Bounds and defaults (env-overridable):

| Limit | Default | Range |
| --- | --- | --- |
| `MAX_ITERATIONS` | 10 | 3–40 (`JARVIS_AGENT_MAX_ITERATIONS`) |
| Deadline | 12 min | 30 s–60 min (`JARVIS_AGENT_TIMEOUT_MS`) |
| Correction rounds | 3 | fixed |
| Approval timeout | 180 s | fixed |
| Tools per metadata block | 6 | fixed |
| Transcript messages | 60 | fixed |
| Tool result chars | 6000 | fixed |

Per turn the engine calls the provider, parses `---METADATA---`, executes
independent read-only tools concurrently, and runs writes sequentially. It has
recovery nudges for: malformed/absent metadata, placeholder-only replies,
memory-only findings, and “wrap up before the budget expires”.

### Tools

`repo-tools.ts`: `overview`, `read_file`, `list_tree`, `search`, `find_symbol`,
`git_status`, `git_diff`, `git_log`, `write_file`, `edit_file`,
`run_script`. File edits return diffs. `run_script` is restricted to scripts
declared in `package.json`; `run_command` goes through the local agent and is
confirm-tier.

### Workspace safety

`workspace.ts` enforces:

- path resolution inside the workspace root (lexical + `realpath` symlink
  escape checks);
- refusal of sensitive files (`.env*`, `.agent-secret`, `agent-token`,
  `voice_sample.wav`);
- refusal to write inside dependency/build dirs (`node_modules`, `.git`,
  `dist`, `build`, `out`, `.output`, `.nitro`, `.tanstack`, `.wrangler`,
  `.xtts-venv`, models, caches);
- secret-pattern screening before persisting memory.

### Verification and review

Before the first edit the engine captures a **baseline** run of declared
scripts (`test`, `typecheck`, `check`, `lint`). After edits it reruns them,
compares only **new** failures, allows three correction rounds, and records
every run with command, exit code, duration, timeout flag, and bounded output.
Changed files are snapshotted pre-edit; `/api/agent?taskId=…&snapshot=…`
returns originals, and `POST {action:"revert"}` restores or deletes
task-created files after a modal confirmation.

### Persistence

- `.jarvis/tasks.json` — bounded history (30 terminal tasks), atomic writes,
  serialized via a per-store queue. Mid-flight tasks become `CANCELLED +
  interrupted` on restart and are resumable; they are never silently restarted.
- `.jarvis/memory.json` — per-repo engineering memory (architecture, decision,
  convention, bug, fix, failed approach, task status, note), capped at 200
  entries / 1000 chars, secret-screened, with file-mtime staleness marking.
- One active task per workspace (`AGENT_BUSY` otherwise).

### Control plane and VS Code

`/api/agent` is the authenticated boundary: start, cancel, approve, resume,
revert, list/status/diffs, memory inspect/edit/delete. The token is generated
on first request into `.jarvis/agent-token` (0600) and compared in constant
time.

`vscode-extension/` is a thin sidebar client: `client.ts` (HTTP + errors),
`shared.ts` (protocol helpers, context caps, HTML escaping),
`webview.ts` (CSP nonce UI), `extension.ts` (commands, polling, diff viewer).
It holds no AI logic. Editor context is capped before transmission (selection
2000 chars, file 4000, 20 diagnostics).

### Current agent limitations

- The local 14B model emits inconsistent metadata; the engine has a tolerance
  layer and regression tests, but a stronger model (set `OLLAMA_CODING_MODEL`)
  behaves better.
- Not sandboxed: the agent runs as the user. Safety is workspace path checks,
  script allowlisting, and confirmations — not OS isolation.
- `run_command` is general shell (confirm-tier); it can do anything the user
  could.
- One task at a time; no parallel agents.
- Verification only sees scripts declared in `package.json`.
- Task transcripts/snapshots can contain repository content; `.jarvis/` is
  git-ignored but not encrypted.
- The VS Code UI is compile- and unit-tested, not smoke-tested in a live
  Extension Development Host.

---

## 8. Persistence

### Supabase (optional)

| Table | Use |
| --- | --- |
| `messages` | chat history per `session_id` |
| `memory` | personal facts with relevance keywords + `last_accessed` |
| `learned_behaviors` | user corrections/rules |
| `activity_log` | tool execution audit |
| `google_tokens` | OAuth tokens, single `user_id='default'` |
| `proactive_schedules` | reminders, check-ins, task reports |
| `proactive_messages` | pending proactive messages |

Chat works without Supabase; history, memory, schedules and Google/Notion do
not. `supabase-server.ts` initializes the client lazily and, when the URL or
service-role key is absent, `supabaseAdmin.from(...)` yields a null query
builder that resolves to an explicit `supabase_not_configured` error instead of
throwing — so the module-scope `createClient("")` crash that would otherwise
take down `/api/stream` on a first run cannot occur, reads return empty, and
writes surface the error. All Supabase access is server-side with the
service-role key. There is no multi-user model: Google tokens and proactive
state are keyed to `default`.

### Workspace state

`.jarvis/agent-token`, `.jarvis/tasks.json`, `.jarvis/memory.json` — ignored by
Git, local to the workspace.

---

## 9. Security model and gaps

**Implemented**

- `.env.local`, `.jarvis/`, `local-agent/.agent-secret`, model weights, venv,
  voice sample, build outputs and extension artifacts are git-ignored.
- `/api/agent` bearer auth with constant-time comparison.
- Local tool agent: loopback bind + shared secret, loopback-only CORS echo, and
  per-call HMAC approval tokens for every confirm-tier tool (a leaked bearer
  secret alone cannot open an app, run a command or write a file).
- Google OAuth tokens encrypted at rest (AES-256-GCM under
  `TOKEN_ENCRYPTION_KEY`), never silently downgraded to plaintext.
- Local HTTP routes (`/api/stream`, `/api/confirm`, `/api/proactive`,
  `/api/transcribe`) are guarded by a Host/Origin check
  (`src/lib/local-request-guard.ts`).
- Hands v1 observation is read-only by construction (no action APIs in the
  helper) and its results are fenced as untrusted data.
- Coding agent: workspace containment, sensitive-file refusal, secret
  screening, confirmations, snapshots/revert.
- TTS logs contain no message content.
- No secrets are returned to the browser except the Supabase anon key.

**Gaps / documented debt (do not treat as solved)**

1. **Google token encryption depends on `TOKEN_ENCRYPTION_KEY`.**
   `token-store.ts` now encrypts `access_token`/`refresh_token` (AES-256-GCM,
   `TOKEN_ENCRYPTION_KEY`, with `TOKEN_ENCRYPTION_KEY_PREVIOUS` for re-encrypt
   rotation) and refuses to fall back to plaintext: a decrypt failure means
   "Google not connected", never raw bytes. Remaining caveats: without a valid
   32-byte key the integration is disabled; `002_google_tokens.sql` still
   mentions pgcrypto, which the application layer does not use; and there is no
   key-rotation UI beyond the previous-key environment variable.
2. **Local HTTP routes have no authentication** (`/api/stream`,
   `/api/confirm`, `/api/proactive`, `/api/transcribe`). They are intended for
   loopback single-user use; do not expose the dev server to a LAN.
3. **Local agent CORS is loopback-only, not `*`.** The server echoes
   `Access-Control-Allow-Origin` only for `localhost`/`127.0.0.1`/`[::1]`
   origins and sends no CORS header to anything else. A foreign web page still
   cannot read responses, but any local process that can read the secret files
   (`.agent-secret`, `.approval-key`) could call the agent directly — filesystem
   permissions are the real boundary, not CORS. Confirm-tier tools additionally
   require an approval token that only the JARVIS server mints after a real
   approval, so the bearer secret alone is not enough to run them.
4. **Prompt-injection surface:** repository content can influence the agent’s
   reasoning. Mitigations are prompt rules, permission tiers and workspace
   bounds, not a hard sandbox.
5. **No token rotation UI** for the agent token; delete `.jarvis/agent-token`
   to force regeneration.
6. **Single-user assumptions** throughout (`user_id='default'`, one active task).

---

## 10. Verification (recorded 2026-10-27, after the security-hardening pass)

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `npx tsc --noEmit` | exit 0 |
| Unit tests | `npm test` (vitest) | 460/460 passed, 28 files |
| Production build | `npm run build` | exit 0 (Nitro cloudflare-module) |
| Python syntax | `python3 -m py_compile xtts_server.py` | exit 0 |
| Extension types | `npx tsc --noEmit` in `vscode-extension` | exit 0 |
| Extension tests | `npm test` in `vscode-extension` | 18/18 passed |
| Hands helpers build | `native/jarvis-hands/build.command`, `native/jarvis-hands-control/build.command` (swiftc 6.3.1) | exit 0 both |
| Control helper refusals | real binary, un-granted TCC | `accessibility_denied` for click/map/key/menu; `bad_coordinates` for off-screen points; `unknown_key`/`unknown_modifier` for bad chords; `usage` for a bad `--where` |
| Vision OCR | real helper on a PNG with known text | text returned correctly (`"Atticus / Your whole Mac, one sentence away."`), 5 lines |
| Live tool path | real `bun local-agent/server.ts` + real helper through `routeToolCall` | read-only tools answered; confirm tier 401 without a token; `hands_click` 404 |
| Targeted lint | `npx eslint` on touched paths | exit 0 |

Baseline before this pass (same machine, 2026-10-25): 198/198 tests in 14
files. The earlier review snapshot (215 tests / 16 files) and the older docs
(208 / 15) both differ from that measurement.

Not verified end-to-end in this pass: live Ollama conversation, XTTS audio
quality, microphone/whisper transcription, Google/Notion OAuth flows, the
VS Code sidebar UI, and any Hands behaviour that needs a granted macOS
Accessibility permission (the helper was exercised un-granted, so
`read-focused` correctly returned `accessibility_denied` rather than window
text). Their code paths exist and are unit-tested where possible.

---

## 11. Dependencies worth knowing

- **Runtime/app:** `@tanstack/react-start`, `@tanstack/react-router`,
  `@tanstack/react-query`, `react` 19, `vite` 8, `nitro` (Cloudflare target),
  `zod`, `ws`, `@supabase/supabase-js`.
- **UI:** Tailwind 4, Radix/shadcn kit (largely unused), `lucide-react`.
- **Voice:** Python 3.10–3.12, `torch`/`torchaudio`, `coqui-tts[codec]`,
  `transformers>=4.57,<5.1`, `flask`; `whisper-cpp` + a GGML model.
- **Local agent:** Bun, `playwright` (browser tools), macOS `osascript`.
- **Extension:** TypeScript, `@types/vscode`, `tsx`, `@vscode/vsce`.

There are two lockfiles at the root (`bun.lock`, `package-lock.json`). The
launch script uses Bun; npm was used for checks. This is a known inconsistency
— pick one package manager before dependency changes.

---

## 12. Known technical debt / incomplete work

- Google token key management: no rotation UI, and a missing
  `TOKEN_ENCRYPTION_KEY` disables the integration entirely.
- Unused shadcn/Radix UI kit (~45 files) and its dependency weight.
- Dormant `ZAIProvider`/`GeminiProvider` code and stale comments in docs.
- `TOKEN_ENCRYPTION_KEY` is not applied.
- Proactive scheduler is an in-process interval; it only runs while the app is
  running and only one process should own it.
- `src/functions/chat.ts` (legacy non-streaming chat) was removed during this
  cleanup; `stream.ts` is the only chat path.
- Vite build warns about a redundant `vite-tsconfig-paths` plugin (injected by
  `@lovable.dev/vite-tanstack-config`) and an ineffective dynamic import of the
  agent engine.
- Whole-repo `eslint .` is extremely slow on this machine; lint targeted paths.
- Hands needs TWO macOS grants, one per binary: Accessibility for
  `native/jarvis-hands/bin/jarvis-hands` (reading) and Accessibility for
  `native/jarvis-hands-control/bin/jarvis-hands-control` (acting), plus Screen
  Recording for whichever process runs the capture (the OCR fallback and
  `hands_look`). Until they are granted the tools return explicit
  `accessibility_denied` / `screen_recording_denied` results. Neither helper is
  built by `start-jarvis.command` — run both `build.command` scripts. Video and
  pure-graphics content is only readable through OCR, so a window with no text
  still yields nothing useful.
- No integration tests for Supabase, Google, Notion, XTTS, whisper, or the
  VS Code host.
- `.jarvis/tasks.json` can grow with transcripts; 30-task cap applies only to
  terminal tasks.

---

## 13. Atticus feature parity: what was taken, what was not, and the seams

> Status: Atticus-inspired capabilities are now being integrated **as
> independently implemented features**, not as a port. No Atticus source,
> prompt or asset has been copied; `THIRD_PARTY_NOTICES.md` records that.
> `ATTICUS_PARITY.md` holds the live, item-by-item matrix of what exists and
> what is still missing.

The following seams stay stable so each remaining parity item can be added
surgically.

### Safe places to extend

1. **Model/provider layer** — implement `AIProvider` (`chat`/`chatStream`) or
   add a new provider behind `createProvider()`. Do not change the SSE event
   contract (`token`, `tool_start`, `confirm_request`, `tool_result`, `done`).
2. **Tool registry** — add servers/tools to `MCP_REGISTRY` and handlers to
   `SERVER_DISPATCH`, then add permission entries in `guardrails.ts`. The
   registry schema is the natural adapter point for Atticus tools.
3. **Coding-agent executor** — `AgentDeps` already injects `chat` and
   `executeTool`; tests use overrides. An Atticus planner/tool-executor can be
   swapped in there without touching the state machine or task store.
4. **Memory** — `memory.ts` has a small typed surface (`saveMemory`,
   `recallMemory`, `listMemory`, `memoryToPrompt`). Replace the JSON backend
   behind that interface if a richer memory system is adopted.
5. **Workspace policy** — `resolveWorkspacePath` is the single choke point for
   path safety; any new tool must go through it.
6. **Voice** — keep `speech-text.ts` → `audio-queue.ts` → `reveal.ts` intact.
   It solves text/audio synchronization and failure recovery; replacing it with
   a different TTS engine is a separate, high-risk project.

### Do not replace without a migration plan

- The audio-clock reveal pipeline and its tests.
- The agent’s snapshot/revert and single-active-task guarantees.
- The `/api/stream` SSE contract used by the frontend.
- The `/api/agent` bearer boundary and workspace containment.
- Supabase table shapes used by existing data (messages/memory/behaviors).

### Recommended comparison questions for the Atticus review

1. How does Atticus represent tools and permissions — can it populate
   `MCP_REGISTRY` + `SERVER_DISPATCH` without a parallel execution path?
2. Does Atticus have a planner/verifier worth adopting as an `AgentDeps`
   implementation, while keeping JARVIS’s task store and approvals?
3. Does Atticus solve multi-step memory or retrieval in a way that fits the
   `memory.ts` interface?
4. Does it have a safer shell/sandbox model that can replace `run_command`
   without weakening the confirm tier?
5. Does it have any voice/streaming work that would conflict with the existing
   audio-clock reveal design? (If so, keep JARVIS’s.)

---

## 14. Key file map

```
src/routes/index.tsx              chat UI + SSE + TTS/reveal orchestration
src/routes/api/stream.ts          chat pipeline and tool loop
src/routes/api/agent.ts           coding-agent control plane (auth)
src/routes/api/confirm.ts         confirm-tier decisions
src/routes/api/proactive.ts       proactive poll/callback
src/routes/api/transcribe.ts      whisper.cpp STT
src/lib/ai/provider.ts            AIProvider + Ollama/ZAI/Gemini
src/lib/ai/router.ts              regex route classifier
src/lib/ai/system-prompt.ts       chat persona + metadata contract
src/lib/ai/data-tools.ts          Gmail/Calendar/Notion pre-pass
src/lib/ai/task-registry.ts       per-request abort controllers
src/lib/context-cache.ts          write-through context cache
src/lib/automation/schedule.ts    recurrence parser + next-run arithmetic
src/lib/automation/routines.ts    file-backed routines with atomic claiming
src/lib/automation/watches.ts     no-AI window/command watches
src/lib/automation/procedures.ts  learned phrases + replay safety
src/lib/automation/replay.ts      pre-model replay decision + outcome wording
src/lib/automation/tick.ts        one automation pass on the 15 s clock
src/lib/profile.ts                "about you" facts + sensitive masking
src/lib/history-search.ts         conversation search (query normalisation, snippets)
src/lib/mcp/registry.ts           tool catalog + dispatch
src/lib/guardrails.ts             permission tiers + activity log
src/lib/agent/engine.ts           bounded agent state machine
src/lib/agent/repo-tools.ts       repo read/search/edit/script tools
src/lib/agent/workspace.ts        path containment + secret screening
src/lib/agent/task-store.ts       .jarvis/tasks.json persistence
src/lib/agent/memory.ts           .jarvis/memory.json persistence
src/lib/agent/prompt.ts           agent system prompt + tool specs
src/lib/audio-queue.ts            Web Audio scheduling + reveal driver
src/lib/speech-text.ts            speech-safe chunking/normalization
src/lib/reveal.ts                 audio-clock → text math
local-agent/server.ts             loopback tool server (Bun)
local-agent/tools/mac.ts          Spotlight / Contacts / Spotify
native/jarvis-hands/              read-only screen observation helper
native/jarvis-hands-control/      computer-control helper (argv only)
native/jarvis-menubar/            menu-bar app: dictation, wake word, overlay, meetings
vscode-extension/src/             sidebar client, webview, diff viewer
xtts_server.py                    XTTS-v2 HTTP server
supabase/migrations/              schema
```
