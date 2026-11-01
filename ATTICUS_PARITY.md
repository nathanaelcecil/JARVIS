# Atticus parity matrix

Living checklist for bringing [atticus-mac](https://github.com/SaarthurR/atticus-mac)'s
capabilities into JARVIS **in JARVIS's own design, format and code**.

Two rules govern this document:

1. **No Atticus code is copied.** Atticus was reviewed as a reference only. Every
   item below is implemented (or planned) independently against macOS APIs and
   this repo's own architecture. `THIRD_PARTY_NOTICES.md` records this.
2. **A capability counts as done only when it is tested and its failure path is
   explicit.** "Tool exists" is not done; "tool exists, refuses safely, and a
   test pins the refusal" is done.

Legend: ✅ done · 🟡 partial · ⬜ not started. Phase = when it lands.

---

## 1. Screen observation

| Atticus                                                | JARVIS                                                                | Status                     |
| ------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------- |
| `--window` readable window text, DOM → AX → OCR ladder | `hands_read_window` (AX) + `hands_read_screen` (AX→OCR via Vision)    | ✅                         |
| `--front` frontmost window text + focused element      | `hands_read_focused`                                                  | ✅                         |
| `--look` labelled screenshots of every display         | `hands_look` (screencapture, private 0700 dir, 10-min prune)          | ✅                         |
| `--hands see` control map as the addressing model      | `control_map` (role, label, x/y, enabled, pressable)                  | ✅                         |
| OCR fallback when the document has no text             | `hands_read_screen` → Vision `accurate`, en-US                        | ✅                         |
| DOM tier for the browser                               | `browser_extract` / `browser_navigate` (Playwright, isolated profile) | ✅ (different trust model) |
| Point-at-your-screen crop ("point here and ask")       | —                                                                     | ⬜ Phase 5                 |
| Mini window preview while an agent works               | —                                                                     | ⬜ Phase 6                 |

## 2. Acting on the Mac ("Hands")

| Atticus                                           | JARVIS                                                                                                                  | Status                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `click <target> [near <label>] [double] [right]`  | `control_click` (AXPress first, then synthetic click; `ambiguous` instead of guessing)                                  | ✅                                           |
| Coordinate clicks (`[point N X Y]`, pixel rings)  | `control_click --x --y` with on-screen bounds checking                                                                  | ✅                                           |
| `type <field> "text" [submit] [append]`           | `control_type(text, label?, submit?, verify?)`; refuses secure fields                                                   | ✅                                           |
| `type-after "<anchor>"` | `control_type(text, label)` puts the caret in the labelled field first | 🟡 field-anchored, not text-anchored |
| `--type` at the current cursor                    | `control_type(text)` with no pid                                                                                        | ✅                                           |
| `press "cmd+t" [times]`                           | `control_key(combo, times?)` from a fixed key table                                                                     | ✅                                           |
| `scroll down/up/left/right`, `scroll-to "<text>"` | `control_scroll(dy, dx?)`; `control_scroll_to(pid, text)` checks what is visible first, then scrolls up to 20 steps and says so when the words never appear | ✅ |
| `drag <from> <to>`                                | `control_drag(from, to)`                                                                                                | ✅                                           |
| `menu <app> "<path>"`                             | `control_menu(pid, "File>Export>PDF")`                                                                                  | ✅                                           |
| `--place <proc> left/right/full` | `control_place(pid, where, screen?)` | ✅ |
| `--show <url or path or app>`, `--bg` | `open_app`, `open_in_finder`, `browser_navigate` | 🟡 no on-another-screen variant |
| Background delivery (no pointer/focus steal)      | `CGEvent.postToPid`, `--global` opt-in                                                                                  | ✅                                           |
| `wait [seconds]` | `control_wait(seconds, 0-30)`, cancellable with the request | ✅ |
| `--draw` overlay (arrows, boxes, labels, pointer) | menu-bar "Draw on screen": drag = arrow, shift-drag = box, option-click = text label, Esc clears then closes | ✅ |

## 3. Permissions, confirmations, approvals

| Atticus                                                        | JARVIS                                                                      | Status        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------- |
| `PreToolUse` gate returning allow/deny                         | `tool-authorization.ts` single decision point + local-agent `authorizeCall` | ✅            |
| "Allow" cards per action class (Click this? Press this key? …) | `ConfirmAction.tsx` + `formatConfirmArgs` per-tool rendering                | ✅            |
| Task-scoped approval ("always allow for this task")            | — (every confirm is one-shot, nonce-replay-protected)                       | ⬜ Phase 4    |
| Hard denials (`rm`, `sudo`, `git push`, …)                     | `never` tier in `guardrails.ts` + argv-only tools                           | ✅            |
| Agent asks the user to choose (`--pick` card)                  | —                                                                           | ⬜ Phase 4    |
| Bearer secret is not enough for actions                        | HMAC approval token, args-bound, single-use                                 | ✅ (stronger) |

## 4. Agent loop, tasks, persistence

| Atticus                                              | JARVIS                                                                                                                                                                                                                                                                   | Status                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Loop owned by an external CLI (Claude Code/Devin/Pi) | Own bounded state machine (`engine.ts`) with snapshot/revert and baseline verification                                                                                                                                                                                   | ✅ (different architecture)                                                                        |
| Escalation from a cheap model to a work model        | — (`OLLAMA_CODING_MODEL` only)                                                                                                                                                                                                                                           | ⬜ Phase 4                                                                                         |
| Background agents + voice steering of a running task | —                                                                                                                                                                                                                                                                        | ⬜ Phase 6                                                                                         |
| Named, reusable agents                               | —                                                                                                                                                                                                                                                                        | ⬜ Phase 5                                                                                         |
| Routines ("every weekday at 8…", "every 30 minutes") | `routine_add` with a parsed schedule (interval / daily / weekday / weekly), claimed on the 15 s tick, queued to `/api/proactive`, submitted by the UI as your own request                                                                                                | ✅ (no arbitrary cron expressions)                                                                 |
| Watches (`--watch app "title" gone\|shows`, no AI)   | `watch_add` window watches (shows / gone / settled) and command watches, polled on the same tick, banner on transition                                                                                                                                                   | ✅                                                                                                 |
| Learned shortcuts/procedures, replayed without AI    | `procedures.ts` + `procedure_learn` / `procedure_list` / `procedure_forget`; `/api/stream` intercepts an exact taught phrase **before any model call** and runs the auto-tier steps inline, falling through to the model if a step fails or the phrase needs an approval | ✅ verified in the UI: taught "morning status check" replayed 2 steps and answered without a model |
| Task state on disk, resumable, cancellable           | `.jarvis/tasks.json`, resumable, single active task                                                                                                                                                                                                                      | ✅                                                                                                 |

## 5. Memory

| Atticus                                                 | JARVIS                                                                                                                                                                                                    | Status                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| "About you" fact store (`me.json`, categories, sources) | `profile.ts` (`.jarvis/profile.json`): typed categories, sources, `profile_get` / `profile_set` / `profile_forget`; name and answer-style always in the prompt, other facts only when the request matches | ✅                                          |
| Sensitive masking (SSN, cards, passwords never sent)    | `isSensitive` / `maskValue` mask SSN, card, CVV, password and bank numbers **before** the fact is written, so the raw value never lands on disk                                                           | ✅                                          |
| Rules (`memory.md`) sent with every request             | `LearnedBehavior` rows in the system prompt                                                                                                                                                               | ✅                                          |
| Search your own history (`--history`)                   | `history_search(query, limit?, days?, role?)` over the saved conversation, newest first, snippets centred on the match, says so plainly when nothing matches                                              | ✅                                          |
| Meeting archive with search/export                      | menu-bar "Record meeting" saves `<timestamp>.m4a` + a `.md` transcript under `~/Documents/JARVIS/meetings`; `spotlight_search` finds them by content                                                      | 🟡 mic only (no system audio), no export UI |

## 6. Voice and dictation

| Atticus                                          | JARVIS                                                                                                                                                                                        | Status                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| On-device STT (Apple `SpeechTranscriber`)        | `whisper.cpp` via `/api/transcribe`                                                                                                                                                           | ✅ (different engine)                                                   |
| Streaming partial transcripts                    | `/api/transcribe` streaming                                                                                                                                                                   | 🟡                                                                      |
| Local TTS                                        | XTTS-v2 + audio-clock reveal sync (`speech-text.ts` → `audio-queue.ts` → `reveal.ts`)                                                                                                         | ✅ (stronger sync)                                                      |
| Wake word ("Atticus")                            | menu-bar app: on-device `SFSpeechRecognizer` listens for "Jarvis" (common mishearings accepted) and starts a dictation                                                                        | ✅ built; needs the Speech Recognition + Microphone grants on first use |
| Global hotkey / menu-bar app / overlay           | `native/jarvis-menubar`: menu-bar item, ⌃⌥D global hotkey, on-screen drawing overlay (arrows, Esc clears then closes)                                                                         | ✅ built and running                                                    |
| Dictation mode into any text field, with cleanup | menu-bar Dictate (⌃⌥D): records, transcribes through local `whisper.cpp`, types via `jarvis-hands-control type --global`; falls back to the clipboard and says so if Accessibility is missing | ✅ built (mic leg needs your first-time grant)                          |
| `[insert]` / `[replace]` / `[draft]` reply tags  | —                                                                                                                                                                                             | ⬜ Phase 5                                                              |

## 7. Integrations

| Atticus                                       | JARVIS                                                                                                   | Status               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------- |
| Mail: read on screen, reply, **never sends**  | Gmail read/search/reply **and send** (confirm tier)                                                      | ✅ (beyond Atticus)  |
| Calendar list/add/move/delete                 | Calendar list/search/create/update/delete                                                                | ✅                   |
| Contacts                                      | `contacts_search(query)`: name, first email, first phone; reports `automation_denied` with the exact fix | ✅                   |
| Notes/Reminders                               | Notion pages/databases                                                                                   | 🟡 different surface |
| File search by content (Spotlight `mdfind`)   | `spotlight_search(query, path?)` runs `mdfind`, so it matches inside documents                           | ✅                   |
| `--read <url>`, `--search`                    | `browser_extract`, `browser_navigate`                                                                    | ✅                   |
| Spotify play/queue | `spotify_status()` and `spotify_control(playpause, play, pause, next, previous, volume, playuri, queue)`; URIs are shape-checked, and search stays a UI task because AppleScript has none | ✅ (transport + URI; no search) |
| Drive System Settings panes | `open_settings(pane)`: accessibility, screen-recording, microphone, speech, automation, notifications, sound, network, battery | ✅ opens the pane; the toggle is still yours |
| MCP connectors / skills                       | MCP registry (`src/lib/mcp/registry.ts`)                                                                 | ✅                   |
| Coding agents in the terminal                 | Own coding agent + VS Code extension                                                                     | ✅ (beyond Atticus)  |
| Meeting Copilot (live answers, local archive) | —                                                                                                        | ⬜ Phase 6           |

## 8. Models and routing

| Atticus                                       | JARVIS                                  | Status                            |
| --------------------------------------------- | --------------------------------------- | --------------------------------- |
| Claude Code / Devin / Pi (Anthropic Messages) | `AIProvider` (Ollama, ZAI, Gemini stub) | 🟡 no Anthropic-compatible client |
| Local servers auto-discovered (`/v1/models`) | `ollama-models.ts` reads `/api/tags` (5 min cache); the provider swaps in an installed model instead of failing with "model not found" | ✅ |
| Cheapest / balanced / most-capable routing    | regex router (`ai/router.ts`)           | 🟡 Phase 4                        |

## 9. Interface

| Atticus                                                    | JARVIS                                         | Status     |
| ---------------------------------------------------------- | ---------------------------------------------- | ---------- |
| Menu-bar app, overlay ask box, onboarding, 9-pane settings | `native/jarvis-menubar` (dictation, wake word, overlay, meetings, permission panes); settings live in the web UI and native System Settings panes | 🟡 menu bar + overlay done; no bespoke 9-pane settings window |
| Agents shelf with live steps + mini screen                 | Coding-task panel                              | 🟡         |
| Dictation pill, drawing layer                              | —                                              | ⬜ Phase 6 |

---

## Design decisions that deliberately differ

These are not gaps; they are choices made because JARVIS is a different product.

1. **Two binaries, two permissions.** Atticus is one Python helper plus one Swift
   app. JARVIS splits observation (`jarvis-hands`) and control
   (`jarvis-hands-control`) so the read-only guarantee is enforceable by a test,
   and so a user can revoke control without losing sight.
2. **Approval tokens, not a gate hook.** Atticus relies on the external CLI's
   `PreToolUse` hook. JARVIS mints a short-lived HMAC token bound to the exact
   tool and arguments, single-use, verified inside the tool server — so even a
   process holding the bearer secret cannot click.
3. **Background delivery by default.** Acting goes to the pid, not the pointer.
   The user's cursor and front app stay where they were unless they asked to
   switch.
4. **Refuse to guess.** An ambiguous label returns candidates instead of picking
   the first. Atticus resolves ambiguity by preferring AX frames; JARVIS makes
   the model ask or use explicit coordinates.
5. **Its own agent loop.** Atticus delegates planning to an external CLI. JARVIS
   keeps its own bounded state machine, task store and snapshot/revert, and adds
   local-model tolerance instead of depending on a cloud agent.

## Verifying the ✅ rows

```bash
npx tsc --noEmit && npm test          # 460 tests incl. Hands v2 + automation
native/jarvis-hands/build.command
native/jarvis-hands-control/build.command
native/jarvis-hands-control/bin/jarvis-hands-control permissions
```

The control helper's refusals are testable without any grant: `accessibility_denied`,
`bad_coordinates`, `unknown_key`, `unknown_modifier` and `usage` are asserted in
`local-agent/tools/control.test.ts` and were exercised against the real binary.
The permission-_granted_ path needs a one-time Accessibility grant and is the
remaining unproven branch (see `ARCHITECTURE.md` §10).
