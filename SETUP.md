# JARVIS — Setup Guide

> Written for a fresh Mac. The app works without Supabase or voice; those add
> persistence and speech.

## What you are setting up

- A React/TanStack Start app at **http://localhost:3000**
- **Ollama** running a local model (default `qwen2.5:14b`)
- **XTTS-v2** voice server on `127.0.0.1:8080` (optional)
- **Local tool agent** on `127.0.0.1:3008` for filesystem/desktop/system actions
- Optional **Supabase** for history, memory, schedules and Google/Notion tokens
- Optional **VS Code extension** for the coding agent

---

## Step 1: Install the runtimes

### Bun (required — starts the app and the local agent)

```sh
curl -fsSL https://bun.sh/install | bash
```

Then open a new Terminal and check `bun --version`.

### Node 20+ (required for tests/build tooling)

Download from <https://nodejs.org> if `node --version` is older than 20.

### Ollama (required for the model)

1. Install from <https://ollama.com>.
2. Pull the default model:

```sh
ollama pull qwen2.5:14b
```

3. Leave `ollama serve` running (the macOS app does this for you).

Optional: use a stronger coding model without code edits:

```sh
ollama pull qwen2.5-coder:32b
export OLLAMA_CODING_MODEL=qwen2.5-coder:32b
```

### Python 3.10–3.12 + FFmpeg (required for voice only)

XTTS-v2 needs PyTorch wheels that do not exist for Python 3.13+ on Apple
Silicon. `start-jarvis.command` finds `python3.12`, `python3.11` or `python3.10`
automatically.

```sh
brew install ffmpeg
```

### whisper.cpp (required for microphone input)

```sh
brew install whisper-cpp
mkdir -p models
curl -L -o models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
```

Override paths with `WHISPER_BIN` / `WHISPER_MODEL` if needed.

---

## Step 2: Configure environment variables

```sh
cp .env.local.template .env.local
```

Open `.env.local` and fill in only what you use. The app starts with an empty
file; Supabase-dependent features report a clear error instead of crashing.

### Supabase (optional)

1. Create a project at <https://supabase.com>.
2. Project Settings → API: copy the URL, anon key, and service-role key.
3. Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.
4. In Supabase → SQL Editor, run these files **in order**:
   - `supabase/migrations/001_initial_schema.sql`
   - `supabase/migrations/002_google_tokens.sql`
   - `supabase/migrations/003_proactive.sql`

The tables are `messages`, `memory`, `learned_behaviors`, `activity_log`,
`google_tokens`, `proactive_schedules`, `proactive_messages`.

### Google OAuth (optional — Gmail + Calendar)

1. In Google Cloud Console create an OAuth client of type **Web application**.
2. Add redirect URI: `http://localhost:3000/api/auth/google/callback`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
4. Start JARVIS and visit <http://localhost:3000/api/auth/google>.
5. Re-visit that URL after this upgrade if Gmail send or Calendar writes ask
   for scopes the old token lacks.

### Notion (optional)

Create an internal integration at <https://www.notion.so/my-integrations>,
share the pages/databases with it, and set `NOTION_API_KEY`.

---

## Step 3: Voice sample (optional)

1. Record 5–15 seconds of clear speech, no music.
2. Convert to WAV if needed and save it as `voice_sample.wav` in the project
   root.
3. Without it, XTTS uses its default voice.

---

## Step 4: Security keys, permissions and the screen helper

### Keys JARVIS creates for you

| File | Created by | Purpose |
| --- | --- | --- |
| `local-agent/.agent-secret` | first local-agent start (mode 0600) | bearer secret for `127.0.0.1:3008` |
| `local-agent/.approval-key` | first local-agent start (mode 0600) | HMAC key that signs per-call approval tokens for confirm-tier tools |
| `.jarvis/agent-token` | first `/api/agent` request | coding-agent control-plane token |

Start the local agent once (`bun local-agent/server.ts`) to create the first
two. All three are git-ignored — keep them out of anything you share.

The bearer secret alone can never run a confirm-tier tool (open an app, write a
file, run a command): the JARVIS server mints a short-lived approval token only
after you approve, and the local agent verifies it before executing.

### Rotation

- **Approval key:** delete `local-agent/.approval-key` and restart the local
  agent; the app must be restarted too so it re-reads the key. Every pending
  approval becomes invalid and actions must be approved again.
- **Bearer secret:** delete `local-agent/.agent-secret` and restart the agent.
  The app reads the file per call, so it needs no restart.
- **Coding-agent token:** delete `.jarvis/agent-token` and make one request to
  `/api/agent` to regenerate; update the VS Code setting if you pinned it.
- **Google tokens:** set `TOKEN_ENCRYPTION_KEY` (32 bytes, base64 or hex)
  BEFORE connecting Google — without it the integration stays disabled rather
  than storing plaintext. To rotate: move the current value to
  `TOKEN_ENCRYPTION_KEY_PREVIOUS`, set a new key, and let rows re-encrypt as
  they are read.

### Allowed origins

Local `/api/*` routes accept only loopback `Host`/`Origin` values, and the
local agent echoes CORS only for loopback origins. Set
`JARVIS_ALLOWED_ORIGINS` (comma-separated exact origins) only if you
deliberately serve the UI from somewhere else. Never expose ports 3000 or 3008
beyond your machine.

### Screen reading and computer control (Hands): build + two permissions

Hands is **two binaries on purpose**. macOS grants Accessibility per binary, so
reading and acting are separate permissions you can revoke independently.

```sh
./native/jarvis-hands/build.command                    # observation helper
./native/jarvis-hands-control/build.command            # control helper
./native/jarvis-hands/bin/jarvis-hands permissions     # observation grant?
./native/jarvis-hands-control/bin/jarvis-hands-control permissions  # control grant?
```

`native/build-all.command` builds both.

**`jarvis-hands` — observation only.** Lists windows, reads a window's
accessibility text, OCRs a screenshot when the window has no accessible text,
and can capture a PNG. It contains no click, type, key-press, drag, scroll or
menu code at all — a test fails the build if one appears.

**`jarvis-hands-control` — acting only.** Click (by label or coordinates),
type, press keys, scroll, drag, walk menus, move/resize windows, raise a window.
Every one of its tools is **confirm tier**: JARVIS shows you exactly what it will
do and waits for approval, and the local agent refuses the call without an
approval token — the bearer secret alone cannot click.

**Grant permissions:** System Settings → Privacy & Security →

1. **Accessibility** → enable `jarvis-hands` (reading window text).
2. **Accessibility** → enable `jarvis-hands-control` (only if you want it to
   click/type — skip it and JARVIS simply cannot act).
3. **Screen Recording** → enable the process that runs JARVIS. This is what the
   OCR fallback and `hands_look` need; the full-screen capture is attributed to
   the parent app, not to the helper.

Without (1) the `hands_*` tools return `accessibility_denied`; without (2) every
`control_*` action returns `accessibility_denied`; without (3) `hands_look`
returns `screen_recording_denied` and OCR falls back to reporting that the
window has no readable text. JARVIS says which one is missing rather than
guessing.

Set `JARVIS_HANDS_BIN` / `JARVIS_HANDS_CONTROL_BIN` only to point at helpers
built somewhere else.

### Routines and watches

Routines and watches need no setup beyond the app running: they live in
`.jarvis/routines.json` and `.jarvis/watches.json`, which are created on first
use and are git-ignored. Supabase is not required.

Say what you want in plain words — "every weekday at 8, summarise my inbox" or
"tell me when the Xcode build window appears". Accepted schedules are:
`every N minutes`, `every N hours`, `every hour`, `every day at HH:MM`,
`every weekday at HH:MM`, and `every <weekday> at HH:MM` (with `am`/`pm`
allowed). Anything else is refused rather than stored with a guessed schedule.

A routine fires on the same 15-second tick as reminders; its prompt then runs
as your own request (never while another answer is streaming). A watch fires a
banner when the window appears, goes away or has settled — or when a shell test
starts passing — and uses no model while it waits. Screenshots live in a private `0700` temp directory
(`JARVIS_HANDS_LOOK_DIR` to relocate) and are pruned after 10 minutes.

### Menu-bar app (optional — dictation, wake word, drawing)

`native/jarvis-menubar` is a small accessory app: no Dock icon, one menu-bar
item. Build and launch it once:

```bash
./native/jarvis-menubar/build.command
open native/jarvis-menubar/bin/JARVISMenuBar.app
```

It gives you:

| Item | What it does |
| --- | --- |
| Open JARVIS | Opens the web UI |
| Dictate… (⌃⌥D) | Records, transcribes through `/api/transcribe` (local whisper.cpp), then **types the text into the frontmost app** |
| Wake word “Jarvis” | On-device speech recognition while idle; saying the word starts a dictation |
| Draw on screen | Transparent overlay on every display — drag to draw an arrow; Esc clears, then closes |
| Record meeting… | Records the mic and saves `<timestamp>.m4a` plus a `.md` transcript in `~/Documents/JARVIS/meetings` |

First use asks for Microphone and Speech Recognition. Dictation types through
`jarvis-hands-control`, so Accessibility must be granted for that helper (see
above); if it is not, the text goes to the clipboard and the app says so.

The app posts to whatever `JARVIS_APP_ORIGIN` says, default
`http://127.0.0.1:4173` — launch the dev server on that port if you want
dictation, or export the variable before `open`:

```bash
JARVIS_APP_ORIGIN=http://127.0.0.1:3000 open native/jarvis-menubar/bin/JARVISMenuBar.app
```

---

## Step 5: Start JARVIS

### One-click

Double-click **`start-jarvis.command`** in Finder. It:

1. Checks `.env.local`, Bun, FFmpeg and a compatible Python
2. Creates/reuses `.xtts-venv` and installs PyTorch, coqui-tts and Flask
3. Starts the local tool agent (`bun local-agent/server.ts`)
4. Starts the XTTS server (`python xtts_server.py`) and waits for `/health`
5. Runs `bun run dev` and opens <http://localhost:3000>

First run installs several GB of Python packages and downloads the XTTS model.

### Manual (no voice)

```sh
bun install
bun local-agent/server.ts &     # optional, for macOS tools
bun run dev
```

Press `Ctrl+C` to stop. The one-click script stops the child processes for you.

---

## Step 6: Verify

1. Type “Hello, JARVIS”. The core changes `thinking` → `speaking` and the reply
   is revealed in sync with audio.
2. Click the mic and speak. `/api/transcribe` should return text.
3. Ask “what's my battery?” — the local agent should answer with a real value.
4. Ask a code question with the VS Code extension open (see below).

### VS Code extension (optional)

```sh
cd vscode-extension
npm install
npm run compile
npm run package
code --install-extension jarvis-coding-agent-0.1.0.vsix
```

Start the app, open this repo as the workspace folder, then run
`JARVIS: New Task`. The backend creates `.jarvis/agent-token` on the first
`/api/agent` request; no token is stored in settings.

---

## Troubleshooting

**“Bun is not installed”**
Install from <https://bun.sh> and open a new Terminal.

**Ollama unreachable**
Run `ollama serve` and check `curl http://localhost:11434/api/tags`. The app
defaults to `qwen2.5:14b`; pull it or set `OLLAMA_*_MODEL`.

**“Supabase is not configured — persistence is disabled”**
Expected on first use when Supabase is not configured (the warning is logged
once). Chat and streaming keep working; reads return empty results and writes
report `supabase_not_configured`. History, memory, schedules and Google/Notion
token storage need credentials — see above.

**JARVIS says it cannot read the screen / `accessibility_denied`**
The helper is built but macOS has not granted Accessibility. Run
`./native/jarvis-hands/bin/jarvis-hands permissions`, then System Settings →
Privacy & Security → Accessibility → enable `jarvis-hands`. If READING works
but ACTING refuses, the grant for `jarvis-hands-control` is the missing one —
check it with `./native/jarvis-hands-control/bin/jarvis-hands-control permissions`.

**`screen_recording_denied`**
Screen Recording is not granted to the app running JARVIS, so the OCR fallback
and `hands_look` cannot capture. Grant it in System Settings → Privacy &
Security → Screen Recording, then restart the app that launches JARVIS.

**A control action was refused with `ambiguous`**
Several controls matched the label JARVIS used. That is deliberate: it will not
guess which button you meant. Ask it to use one of the candidates, or give it a
more specific label.

**`helper_missing`**
Build it: `./native/jarvis-hands/build.command` and/or
`./native/jarvis-hands-control/build.command` (needs the Xcode Command Line
Tools). JARVIS will say the helper is missing rather than pretend it read the
screen or clicked.

**Confirm-tier tool refuses to run (“approval key not configured”)**
Start the local agent once so `local-agent/.approval-key` exists, then restart
the app. Nothing in that tier runs on the bearer secret alone — that is
deliberate.

**Voice server is slow (2–5 s)**
Normal on Apple Silicon CPU. First request is slowest. Check `curl
http://127.0.0.1:8080/health`.

**PyTorch install failed**
Your Python is probably 3.13+. Install 3.12 from <https://www.python.org> and
rerun `start-jarvis.command`.

**coqui-tts import failed**
```sh
source .xtts-venv/bin/activate
pip install --force-reinstall "coqui-tts[codec]" "transformers>=4.57,<5.1"
```

**Mic says “network error”**
The old Web Speech API is gone; JARVIS uses local whisper.cpp. Check
`WHISPER_BIN`, `WHISPER_MODEL`, and `ffmpeg -version`.

**Camera not working**
Camera access requires `localhost` or HTTPS. Allow Camera for your browser in
System Settings → Privacy & Security.

**Coding agent returns 401**
Bootstrap once: `curl -i http://127.0.0.1:3000/api/agent` (a 401 reply still
creates `.jarvis/agent-token`). Ensure `.jarvis/` is never committed.

---

## Environment variable reference

| Variable | Purpose | Browser-safe? |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL | Yes |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Server DB access | **No** |
| `OLLAMA_BASE_URL` | Ollama OpenAI-compatible endpoint | No |
| `OLLAMA_KEEP_ALIVE` | Keep model loaded (`-1`) | No |
| `OLLAMA_*_MODEL` | Per-route model overrides | No |
| `XTTS_URL` | Local voice server | No |
| `VOICE_SAMPLE_PATH` | Reference voice WAV | No |
| `WHISPER_BIN` / `WHISPER_MODEL` | Local STT | No |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth | **No** |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for stored Google tokens (required for Google) | **No** |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | Old key, accepted for re-encryption on rotation | **No** |
| `JARVIS_APPROVAL_KEY_FILE` | Override the approval-key path | **No** |
| `JARVIS_ALLOWED_ORIGINS` | Extra exact origins allowed to call local routes | No |
| `JARVIS_HANDS_BIN` | Override the read-only screen helper path | No |
| `NOTION_API_KEY` | Notion integration | **No** |
| `LOCAL_AGENT_PORT` | Tool agent port (default 3008) | No |
| `JARVIS_AGENT_MAX_ITERATIONS` | Coding-agent iteration cap (3–40) | No |
| `JARVIS_AGENT_TIMEOUT_MS` | Coding-agent deadline | No |

---

## Development checks

```sh
bun run typecheck
bun run test
bun run build
python3 -m py_compile xtts_server.py
```

Extension:

```sh
cd vscode-extension
npm run typecheck
npm test
```

`npm run lint` (whole repo) is very slow on this machine; lint changed paths
directly with `npx eslint <paths>`.

---

## File structure

```
src/
  routes/
    index.tsx              chat UI + SSE client + TTS/reveal
    api/stream.ts          chat pipeline (tools, confirmations, memory)
    api/agent.ts           coding-agent control plane (bearer token)
    api/transcribe.ts      local whisper.cpp STT
    api/proactive.ts       reminders/check-ins/task callbacks
    api/confirm.ts         confirm-tier tool decisions
    api/auth/google/       OAuth start + callback
  components/              chat UI, amber core, camera, overlays
  functions/               server functions: speak, Gmail, Google, Notion, tasks
  lib/
    ai/                    provider, router, prompts, data-tool pre-pass
    agent/                 coding-agent engine, workspace, memory, task store
    mcp/registry.ts        tool catalog + dispatch
    audio-queue.ts         Web Audio scheduling + synchronized reveal
    speech-text.ts         speech-safe chunking/normalization
    reveal.ts              audio-clock → text-reveal math
local-agent/               Bun macOS tool server (tools/, approval.ts, validate.ts)
native/jarvis-hands/       read-only screen observation + OCR helper (Swift) + build
native/jarvis-hands-control/ acting helper: click/type/keys/menu/windows (Swift) + build
vscode-extension/          VS Code sidebar client
xtts_server.py             XTTS-v2 voice server
supabase/migrations/       database schema
start-jarvis.command       one-click startup
```

Architecture details and the Atticus integration boundary are in
[ARCHITECTURE.md](ARCHITECTURE.md).
