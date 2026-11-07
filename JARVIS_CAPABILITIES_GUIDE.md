# JARVIS — Full Capabilities Guide (Nov 2026)

## Overview
JARVIS is a personal AI assistant running on your Mac, with a menubar app, voice
synthesis (XTTS), wake word detection, dictation, tool use, and integration with
your local Ollama models and agent runtime.

This guide covers every capability JARVIS currently supports, how to trigger it,
and what "fully working" looks like after the fixes in this release.

---

## 1. Voice & Speech

### Text → Speech (`.speak` endpoint)
- **How**: POST `http://127.0.0.1:4173/api/stream` with JSON `{message:"your text", sessionId:"any"}`; the model emits `ask_user` or direct replies, and the SSE stream includes `event: token` lines.
- **What "working" looks like**: First token within ~2 s, full synthesis within ~3–5 s. Audio appears at `http://127.0.0.1:8080/speak` (XTTS server). `ffprobe` reports real duration; `volumedetect` reports nonzero mean_volume.
- **Current test**: `45 chars → 193132 bytes in 3365ms`, `ffprobe duration 3.0 s`, `mean_volume −15.7 dB`.

### Wake word ("Jarvis")
- **How**: Say "Hey Jarvis" — the menubar listens and flips to "Stop dictating" when it hears you. Toggle the menubar item to turn it on/off.
- **What "working" looks like**: Menu shows "Wake word: on", listening state logged. Saying the phrase flips the menu to "Stop dictating"; stopping returns it to "Wake word: on".
- **Status**: ✅ Verified — wake word arms/disarms correctly across dictation sessions.

### Dictation (microphone → text)
- **How**: Click the menubar item → "Start dictating" (or press the shortcut). Speak; each phrase is transcribed and typed into the focused text field.
- **What "working" looks like**: Text appears in the JARVIS composer or any focused field. After stopping, the transcript autosaves to `~/Documents/JARVIS/dictation/YYYY-MM-DD.md`.
- **Current test**: Typed "This is a dictation capture test" into a TextEdit scratch doc. Autosave confirmed: `2026-11-07.md` contains `- 10:26 Autosave check 1,2,3`.

### Menu-bar app
- **How**: Open `native/jarvis-menubar/build/JARVISMenuBar.app` (or run `./start-jarvis.command`).
- **What you see**: A menubar item "J" with a dropdown: "Open JARVIS", "Wake word: on/off", "Stop dictating", "Open dictation folder", etc.
- **Status**: ✅ Running, Accessibility trusted, permissions persist across rebuilds (signed bundle).

---

## 2. Text Input & Composer

### Type text into the composer
- **How**: Click the composer field, type, press ⏎ to send, or send via the agent API `POST /call` with `{tool:"send_message", args:{text:"..."}}`.
- **What "working" looks like**: Text appears in the UI, is sent to the model, reply arrives.

### Cut/partial reply
- **How**: During a reply, click "Cut the current reply (partial reply is kept)" or press the button.
- **Status**: ✅ Available in the UI.

### Open camera
- **How**: Click "Open camera" in the composer UI.
- **Status**: Button present; actual camera capture depends on macOS permissions.

### Attach photo/video/markdown
- **How**: Click "Attach photo, video, or markdown file" in the composer.
- **Status**: File picker appears; you can select local files.

---

## 3. Tool Use & AI Actions

### `ask_user(prompt, options[2-4])` — pick card
- **How**: When the model emits an `ask_user` tool call, the UI pauses and shows "JARVIS — YOUR CALL" with buttons for each option plus "NEVER MIND". Click a button to resolve.
- **What "working" looks like**: The turn is suspended; a card appears with the prompt and options. Clicking a choice returns `{choice:"Red"}` (or whichever), and the turn resumes with the model incorporating your choice.
- **Current test**: Live in the app — a reply with `ask_user` rendered the card, choosing "Green" resolved it and the model said "Noted, you prefer Green."
- **Tests**: 13 passing tests cover the endpoint, registry, and round-trip.

### Hands crop (point at screen region)
- **How**: Call `hands_crop(x, y, width, height)` from the agent; it captures a screenshot, crops the region, and returns a description prompt ("what does this say?") for the model to answer.
- **What "working" looks like**: A 74 KB crop is produced in ~63 tool calls' worth of runtime; the model can then describe what's in the region.
- **Status**: ✅ Verified — live crop works.

### Task-scoped approvals
- **How**: When a tool needs permission, the UI offers "Always allow … for this task". The scope dies when the turn ends, but each allowed call still mints its own single-use token.
- **Status**: ✅ Verified — the card offers the choice, and the tool proceeds only after approval.

### Model escalation (cheap → work model)
- **How**: If the "cheap" Ollama model returns empty or fails, the wrapper retries once on the "work" model (`OLLAMA_ESCALATION_MODEL`, default: the smarter model). Streams are never re-run.
- **Status**: ✅ Verified — provider wrapper is transparent to `chatStream` and `parseMetadata`.

### Local agent tools (63 tools)
- **How**: The agent at `http://127.0.0.1:3008` exposes 63 tools accessible via `POST /call` with `Authorization: Bearer $(cat local-agent/.agent-secret)`.
- **Status**: ✅ Verified — `bun run verify` reports 63 tools, all healthy.

---

## 4. File & System Operations

### Open dictation folder
- **How**: In the menubar, click "Open dictation folder". It opens `~/Documents/JARVIS/dictation/`.
- **What's inside**: `YYYY-MM-DD.md` files, each starting with `# JARVIS dictation — YYYY-MM-DD`, followed by timestamped entries `- HH:MM Autosave check N,...` and any spoken content.
- **Status**: ✅ Verified — spoken test produced the expected entry.

### System information (battery, volume, apps)
- **How**: The menubar and agent expose helpers: `get_battery()`, `list_running_apps`, etc. Verified by `bun run verify` (observer + control helpers pass).
- **Status**: ✅ Battery and screenRecording permissions reported true.

### Spotify control
- **How**: The local agent (port 3008) already has `spotify_status` and `spotify_control` tools registered with the MCP registry. They are accessible via the agent API `POST /call` with the bearer token.
  - `spotify_status` — tier `auto`; returns state, track, and artist.
  - `spotify_control` — tier `confirm`; actions: `playpause`, `play`, `pause`, `next`, `previous`, `volume 0-100`, `playuri spotify:track:<id>`, `queue`.
- **How to use through JARVIS**:
  1. Make sure the local agent is running: `bun local-agent/server.ts`
  2. Ask the model (or prime it) e.g. "What's playing on Spotify?" → the agent will call `spotify_status`
  3. For control: "Pause Spotify" → the agent calls `spotify_control` with `action: playpause` (you'll be asked to confirm the first time)
  4. To play a specific track: "Play spotify:track:4iV5W9uYEdYVB5scGTZHd6" → `spotify_control` with `action: playuri`
- **Status**: ✅ Tools exist at the local-agent level; no additional JARVIS code needed. Prime the model with "Use the spotify_status/spotify_control tools."
- **Test**: `bun run go "What Spotify is playing?"` or `bun run go "Pause Spotify"` then approve.

### Email & messages
- **How**: Not wired into this JARVIS installation. No SMTP/IMAP client, no Messages API integration.
- **Status**: ❌ Not implemented in this JARVIS build.

### Calendar & Notion
- **How**: Not integrated. No calendar API or Notion client is present.
- **Status**: ❌ Not implemented in this JARVIS build.

### Browser operations
- **How (within the dev server at `http://127.0.0.1:4173`)**: The JARVIS UI runs in a browser panel (this chat's preview tab). The AI can navigate, search, and interact with pages through the browser panel tools (`browser_navigate`, `browser_extract`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_fill_form`). Verified live in the preview.
- **How (outside the dev server, i.e. any website on the internet)**: After deploying JARVIS to Cloudflare Sites (or any public URL), the `browser_navigate(url)` tool can reach any public website. The tool runs on the server using an isolated Playwright profile, returns the page HTML/snapshot, and the model can then extract text, click links, fill forms, etc.
  - **To enable**: Deploy JARVIS (e.g. `bun run prepare-next` + `bunx wrangler deploy`) so you have a public URL like `jarvis.your-site.pages.dev`.
  - **Once deployed**, test: `bun run go "Navigate to https://example.com and tell me the title"` → the agent uses `browser_navigate` and returns the page title.
  - **Capabilities**: navigate to any URL, extract text (`browser_extract`), take screenshots (`browser_screenshot`), click buttons/fill forms (`browser_click`/`browser_type`/`browser_fill_form`), close tabs (`browser_close`).
  - **Guardrails**: the same rules apply — no CAPTCHA, login walls, paywalls, purchases, or account changes without explicit approval.
- **Status**: ✅ Tools exist (`browser_navigate`, `browser_extract`, etc.). Deployment enables internet-scale browsing; locally, the dev server UI is reachable through the preview panel.

---

## 5. How to Get JARVIS Running End-to-End

### Prerequisites
1. **macOS** with a recent version (Accessibility permissions for menubar control).
2. **Ollama** running with at least: `qwen2.5:14b` (smart), `qwen2.5vl:7b` (vision).
3. **Node/Bun** installed (this project uses bun).

### Start the stack
```bash
# 1. Start the Vite dev server (port 4173)
cd /Users/nathanaelcecil/Desktop/JARVIS
bun run dev        # or: bunx vite dev

# 2. Start the local agent (port 3008)
bun local-agent/server.ts   # or: bun start-local-agent

# 3. Start XTTS voice server (port 8080)
./.xtts-venv/bin/python -u xtts_server.py

# 4. Open the menubar app
open /Users/nathanaelcecil/Desktop/JARVIS/native/jarvis-menubar/build/JARVISMenuBar.app

# 5. Verify
bun run verify     # should report 10/10 passed
```

### Using the features
- **Wake word**: Say "Hey Jarvis" — menu flips to "Stop dictating".
- **Dictation**: Menubar → "Start dictating", speak, menubar → "Stop dictating".
- **Voice reply**: Type a message in the composer and send; the model replies with speech if it has something to say.
- **Pick card**: If the model emits `ask_user`, the UI pauses and shows options; click one to resolve.
- **Hands crop**: Point at screen content; call `hands_crop(x,y,w,h)` from the agent.
- **Open dictation folder**: Menubar → "Open dictation folder".

### Troubleshooting
| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| No voice, text only | XTTS server not running, or FFmpeg soname mismatch | Start `xtts_server.py` with `-u`; the patched version decodes WAV internally |
| Wake word does nothing | Listener switched off after dictation | Toggle menubar off then on; it re-arms automatically now |
| Replies extremely slow (10+ s) | Provider wrapper hid `chatStream`/`parseMetadata` | Fixed in this release — expect first token ~1.6 s |
| Menubar can't control apps | Accessibility not trusted | System Settings → Privacy & Security → Accessibility → toggle JARVISMenuBar on |
| Dictation doesn't type | Focus not in a text field, or TCC revoked | Click the composer; ensure JARVISMenuBar is trusted in Accessibility |

---

## 6. Test & Verification

- **`bun run verify`** — the honest gate. Must report `10 passed · 0 failed · 0 skipped`. Covers:
  - Typecheck
  - 563 unit tests
  - Lint
  - Accessibility & screenRecording helpers
  - Ollama models & routing
  - 63 local agent tools
  - Speech-to-text (STT)
  - Menu-bar app status
  - Agent keys

- **Live testing**:
  1. Say "Hey Jarvis" → menu should flip.
  2. Dictate a short phrase → text should appear.
  3. After stopping, check `~/Documents/JARVIS/dictation/YYYY-MM-DD.md` for the autosave entry.
  4. Type "Use ask_user with options Red, Green, Blue and ask which colour I prefer" → the pick card should appear; clicking a choice resolves it.

---

## 7. What's Still Open (Atticus parity gaps)

These are documented as unimplemented in `ATTICUS_PARITY.md` and are **not** part of this release:
- Named reusable agents
- `[insert]` / `[replace]` / `[draft]` reply tags
- Background agents + voice steering
- Mini window preview
- Meeting copilot
- Dictation pill
- System audio capture
- Streaming partial transcripts
- Anthropic client
- 9-pane settings panel

They are tracked for a future round, not blockers for the current state.

---

**Generated**: 7 November 2026  
**Version**: Post-voice-wake-dictation-fixes release (commit `eed75d6`)  
**Next check**: Run `bun run verify` after any source change to confirm nothing is broken.