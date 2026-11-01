# JARVIS — local-first macOS AI assistant

JARVIS is a personal AI assistant that runs on this Mac: a React/TanStack Start
interface, a local Ollama model, a local XTTS-v2 voice server, a local tool
agent for macOS actions, and an authenticated coding agent with a VS Code
sidebar.

Nothing is sent to a hosted model provider by default. Gmail, Calendar, Notion
and Supabase are optional integrations.

## What is in the box

| Area | Implementation |
| --- | --- |
| UI | React 19 + TanStack Start/Router, Vite 8, Tailwind 4, Canvas amber core |
| Chat | SSE endpoint `/api/stream`, streaming reply + voice + tool orchestration |
| Model | Local Ollama via OpenAI-compatible API (default `qwen2.5:14b`) |
| Voice out | XTTS-v2 Python server, sentence-aware streaming TTS and audio-clock text reveal |
| Voice in | `MediaRecorder` → `/api/transcribe` → local `whisper-cli` |
| Tools | Local agent on `127.0.0.1:3008`, plus server-side Gmail/Calendar/Notion |
| Screen | Observe (windows, accessibility text, OCR, screenshots) and control (click, type, keys, menus, window placement) — two separate helpers, two separate macOS permissions; every acting tool needs your approval |
| Coding agent | Bounded investigate → edit → verify loop, `/api/agent`, VS Code extension |
| Automation | Routines ("every weekday at 8am"), no-model watches ("tell me when the deploy window appears"), learned procedures replayed **before** any model call — file-backed in `.jarvis/`, no Supabase needed |
| Persistence | Supabase (optional) for chat/memory/tasks; `.jarvis/` for agent, profile and automation state |
| Mac integrations | Spotlight file search, Contacts lookup, Spotify transport, conversation-history search |
| Menu bar | `native/jarvis-menubar`: menu-bar item, ⌃⌥D dictation into any app, on-device "Jarvis" wake word, drawing overlay, meeting recorder with a saved transcript |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full map and
[SETUP.md](SETUP.md) for step-by-step setup.

## Quick start

Requirements: macOS, [Bun](https://bun.sh), Node 20+, Python 3.10–3.12 (voice),
FFmpeg, and [Ollama](https://ollama.com).

```sh
cp .env.local.template .env.local   # fill in what you use
bun install
ollama pull qwen2.5:14b
bun run dev                         # http://localhost:3000
```

`./start-jarvis.command` starts the voice server, the local tool agent and the
app together. Voice is optional; the app runs without it.

Supabase is optional but required for persistent chat history, long-term
memory, proactive schedules and Google/Notion integrations. Apply the SQL in
`supabase/migrations/` in order, then set the keys in `.env.local`.

## Commands

```sh
bun run dev          # dev server on :3000
bun run build        # production build (.output, Cloudflare/Nitro target)
bun run test         # vitest (208 tests)
bun run typecheck    # tsc --noEmit
bun run lint         # eslint
bun run format       # prettier --write
python3 -m py_compile xtts_server.py
```

VS Code extension (`vscode-extension/`):

```sh
cd vscode-extension
npm install
npm run typecheck
npm test
npm run compile
npm run package      # jarvis-coding-agent-0.1.0.vsix
```

## Repository layout

```
src/
  routes/            file-based pages and API routes
    index.tsx        chat UI, SSE client, TTS/reveal orchestration
    api/stream.ts    chat pipeline (tools, confirmations, memory)
    api/agent.ts     authenticated coding-agent control plane
    api/transcribe.ts local speech-to-text
  components/        chat UI and amber-core renderer
  functions/         TanStack server functions (speak, Gmail, Google, Notion, tasks)
  lib/
    ai/              provider, router, system prompt, data-tool pre-pass
    agent/           coding-agent engine, workspace, memory, task store
    mcp/             tool registry and dispatch
    audio-queue.ts   Web Audio scheduling + synchronized text reveal
    speech-text.ts   speech-safe text chunking/normalization
    reveal.ts        audio-clock → text-reveal math
local-agent/         Bun HTTP server for macOS filesystem/desktop/system tools
vscode-extension/    sidebar client for /api/agent
xtts_server.py       local XTTS-v2 voice server
supabase/migrations/ database schema
```

## Security notes

- `.env.local`, `.jarvis/`, `local-agent/.agent-secret`, models, the Python venv
  and the voice sample are git-ignored. Never commit them.
- `/api/agent` requires a bearer token in `.jarvis/agent-token` (mode 0600).
- The local tool agent binds to loopback and requires its shared secret.
- Paths the coding agent touches are constrained to the workspace; sensitive
  files and dependency/build directories are refused.
- Google tokens are currently stored in Supabase as plain text despite the
  migration comment claiming pgcrypto. This is documented technical debt — do
  not expose the `google_tokens` table publicly.

## Status

The chat, voice, tool, and coding-agent paths are implemented and unit-tested.
End-to-end voice quality, the VS Code UI and Gmail/Calendar/Notion flows need a
live smoke test on this machine. Known gaps and integration boundaries are
listed in [ARCHITECTURE.md](ARCHITECTURE.md).
