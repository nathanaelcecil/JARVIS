# JARVIS — what it can do, and how to test it

This is the operator's guide: every capability, the exact way to trigger it, and
the command that proves it works. Anything that needs a macOS permission says so,
because those are the only steps I cannot do for you.

Start here:

```bash
bun run verify            # typecheck, tests, lint, helpers, model, agent, STT, menu bar
bun run dev               # the app, http://localhost:4173
bun local-agent/server.ts # the tool agent, 127.0.0.1:3008 (normally started for you)
```

`bun run verify` is the honest gate: it prints a ✓ / ✗ / – line per check, exits
non-zero on a real failure, and marks anything it could not run as skipped with
the reason. A skipped line is never a pass.

---

## 1. Talking to it

| Capability | How to trigger it | What "working" looks like |
| --- | --- | --- |
| Chat with a local model | Type in the box and press Enter | Reply streams in; text appears with the voice (or immediately when TTS is off) |
| Voice input | Mic button, or just speak when the microphone is enabled | Your words appear as text, then the reply is spoken |
| Interruption | Say "stop", or press the stop control | Reply is cut, partial text is kept and marked cut off |
| Kill switch | `◻ KILL SWITCH` | Stream, audio and tools stop; state returns to standby |
| Edit and re-run | `✎ EDIT` on any of your messages | Branch after that message is truncated and re-asked |
| Attachments | Paperclip: image, video, or markdown | Image goes to the vision model, markdown is fenced into the prompt |

Test: `bun run verify` covers the model and the pipeline; the chat itself is
`bun run dev` → ask "what's my battery".

## 2. Acting on your Mac

Two separate helpers, two separate permissions — you can revoke control and keep
observation.

```bash
./native/build-all.command                                       # build both
./native/jarvis-hands/bin/jarvis-hands permissions                # observer
./native/jarvis-hands-control/bin/jarvis-hands-control permissions # control
```

| Capability | Tool | Tier | Try saying |
| --- | --- | --- | --- |
| Read windows and text | `hands_list_windows`, `hands_read_window`, `hands_read_focused` | auto | "what windows are open?" |
| OCR a screen | `hands_read_screen`, `hands_look` | auto | "read my screen" |
| Crop a region (point and ask) | `hands_crop(x, y, width, height)` | auto | "what does this say?" while pointing at a region |
| Ask you to choose | `ask_user(prompt, options[])` | auto | "ask me which file to open" — a card appears and the reply waits for your pick |
| Control map | `control_map` | auto | "what's clickable in Chrome?" |
| Click | `control_click` | confirm | "click Save" |
| Type | `control_type` | confirm | "type 'done' into the search field" |
| Keys | `control_key` | confirm | "press cmd+t" |
| Scroll | `control_scroll`, `control_scroll_to` | confirm | "scroll to the pricing section" |
| Drag | `control_drag` | confirm | "drag that window edge left" |
| Menus | `control_menu` | confirm | "File > Export > PDF" |
| Window placement | `control_place`, `control_focus` | confirm | "put Terminal on the left half" |
| Wait for a UI to settle | `control_wait` | auto | "wait two seconds, then click Continue" |
| Open a permission pane | `open_settings` | confirm | "open the accessibility settings" |

Every confirm-tier call shows a card first and only executes once you approve it;
the approval token is bound to the exact tool and arguments and can be used once.

The card also offers **"Always allow <tool> for this task"**. That widens the
approval to the rest of the current chat turn only — the scope is dropped when
the reply finishes or you cancel — and every call it lets through still gets its
own single-use token. A plain Approve stays single-use as before.

When a cheap route comes back empty or fails, the non-streamed completion is
retried once on the work model (`OLLAMA_ESCALATION_MODEL`, default: the smart
model); streams are never re-run, so output is not duplicated. The wrapper
stays transparent: `chatStream` and `parseMetadata` are delegated, because
hiding them made replies arrive as one late blob and silently dropped tool
calls (both pinned by `provider-escalation.test.ts`).

Test (real, non-destructive):

```bash
./native/jarvis-hands-control/bin/jarvis-hands-control type --text "hello" --global
./native/jarvis-hands-control/bin/jarvis-hands-control key --combo "escape"
```

Test the region crop (read-only, same private directory as `hands_look`):

```bash
curl -s -X POST http://127.0.0.1:3008/call \
  -H "Authorization: Bearer $(cat local-agent/.agent-secret)" \
  -H 'Content-Type: application/json' \
  -d '{"tool":"hands_crop","args":{"x":0,"y":0,"width":400,"height":300}}'
# → {"ok":true,"tool":"crop","path":"/var/folders/…/crop-….png",…}
# a region under 8×8 is refused: invalid_arguments, width must be between 8 and 20000
```

## 3. macOS integrations

| Capability | Tool | Try saying |
| --- | --- | --- |
| Search inside files | `spotlight_search(query, path?)` | "find the file where I wrote about the Q3 plan" |
| Look up a contact | `contacts_search(query)` | "what's Sarah's number?" |
| Spotify state | `spotify_status()` | "what's playing?" |
| Spotify transport | `spotify_control(playpause/next/previous/volume/playuri/queue)` | "pause the music", "play spotify:track:<id>" |

Spotify search is a UI task (its AppleScript has none): "find <song>" opens
`spotify:search:` and picks a result with `control_*`.

Needs: one-time **Automation** grants for Contacts and Spotify; Spotlight needs
indexing on. Test: `bun run verify`, then ask the phrases above.

## 4. Memory, history and "about you"

| Capability | Tool | Try saying |
| --- | --- | --- |
| Recall earlier conversation | `history_search(query, limit?, days?, role?)` | "what did we decide about the deploy?" |
| Remember a fact | `profile_set(category, value, kind?)` | "remember that I'm vegetarian" |
| Read the profile | `profile_get(category?)` | "what do you know about me?" |
| Forget | `profile_forget(id \| source)` | "forget everything from contacts" |

Facts live in `.jarvis/profile.json`. Anything that looks like an SSN, card
number, CVV, password or bank number is **masked before it is written**, so the
raw value never lands on disk and can never be sent back to a model.

Test: "remember my wifi password is hunter2" → `profile_get` shows `•••• (hidden)`
and `.jarvis/profile.json` contains no `hunter2`.

## 5. Automation without a model

| Capability | Tool | Try saying |
| --- | --- | --- |
| Routines | `routine_add(prompt, when, label?)` | "every weekday at 8, summarise my inbox" |
| List / remove | `routine_list()`, `routine_remove(id)` | "what runs on a schedule?" |
| Watches | `watch_add(title?, app?, event? \| command?, then?)` | "tell me when the Xcode build window appears, then read it" |
| List / remove | `watch_list()`, `watch_remove(id)` | "what are you watching?" |
| Taught phrases | `procedure_learn(trigger, steps[])` | "remember this as 'morning status'" then say "morning status" |

How it actually behaves:

- A routine is claimed exactly once per due time (a locked read-modify-write), so
  two ticks can never double-fire it. Its prompt is submitted as **your own
  request** in the chat, one at a time.
- A watch costs nothing while waiting: it is evaluated on the existing 15 s tick
  and fires only on a transition. A watch with `then` submits that prompt as a
  turn; without one it is just a banner.
- A taught phrase with only auto-tier steps is intercepted in `/api/stream`
  **before any model call** and replayed inline. If a step is confirm-tier or
  fails, the phrase falls through to the model so you still get a real approval.

Test:

```bash
# 1. In the chat: "every 1 minute, say exactly: tick"
# 2. Watch the routine arrive as a user turn in the same conversation.
# 3. Stop it: "remove routine <id>" (routine_list shows the id).
```

## 6. Coding agent

| Capability | Where | Notes |
| --- | --- | --- |
| Bounded repo task | `start_coding_agent(task)` in chat, or the VS Code sidebar | investigate → edit → verify, with snapshot/revert |
| Status / cancel | `coding_task_status()`, `/api/agent` | `/api/agent` needs its bearer token; VS Code holds it |

It always runs against `process.cwd()` from chat — the model cannot re-aim it at
another folder. Paths are contained to the workspace and secret files are refused.

Test: ask "add a comment to the top of README.md and verify the build" — you get
a diff-style report and a verification result, not a claim.

## 7. Menu-bar app

```bash
./native/jarvis-menubar/build.command
open native/jarvis-menubar/bin/JARVISMenuBar.app
```

| Item | Trigger | Needs |
| --- | --- | --- |
| Open JARVIS | menu | — |
| Dictate… | menu or **⌃⌥D** anywhere | Microphone + Accessibility (types through the control helper) |
| Wake word "Jarvis" | menu toggle | Microphone + Speech Recognition |
| Draw on screen | menu | drag = arrow, **shift-drag** = box, **option-click** = label, Esc clears then closes |
| Record meeting… | menu | Microphone — saves `.m4a` + `.md` transcript under `~/Documents/JARVIS/meetings` |
| Open meetings folder | menu | — |
| Check permissions | menu | — |

If Accessibility is missing, dictation copies the text to your clipboard and says
so instead of silently losing it.

Every dictation is also appended to `~/Documents/JARVIS/dictation/YYYY-MM-DD.md`
(time + text) as soon as it is transcribed, so nothing is lost when there is no
text field to type into. Menu → **Open dictation folder** takes you there.

The app logs to `/tmp/jarvis-logs/menubar.log` — including
`accessibility trusted = true|false` at startup, which is the fastest way to
check the grant. `build.command` signs the bundle by **identifier**
(`identifier "local.jarvis.menubar"`) so a rebuild no longer invalidates the
grant; if it is ever lost anyway, remove and re-add the app in the Accessibility
list once.

Test: menu → **Check permissions** (shows the helper's JSON), then ⌃⌥D, say a
sentence, press ⌃⌥D again, and watch it type wherever the cursor is.

## 8. Security posture you can check

- The local agent binds loopback and requires its shared secret; confirm-tier
  tools additionally require a single-use, argument-bound approval token.
- `/api/stream`, `/api/confirm`, `/api/proactive`, `/api/transcribe` reject
  non-loopback `Host` headers and cross-site `Origin`s (DNS-rebinding and CSRF
  defence), while still allowing the local agent's server-to-server callbacks.
- Every tool result is wrapped as untrusted data before it reaches the model, and
  screen text offering "instructions" is treated as content.
- Google tokens are encrypted at rest when `TOKEN_ENCRYPTION_KEY` is set.

Test:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: evil.example" http://127.0.0.1:4173/api/stream -X POST
# → 403
```

Test the two Phase-4 behaviours:

- **Task scope** — in one turn ask for the same confirm-tier tool twice (e.g.
  "type X into the field, then type Y into another field"). On the first card
  pick *Always allow “Type on Screen” for this task*: the second call runs with no
  card. Start a new message and it asks again — scope never outlives the turn.
- **Escalation** — point `OLLAMA_ESCALATION_MODEL` at a stronger model and ask
  something that makes the fast model return an empty answer (very short/garbled
  prompt). The server log shows
  `[Provider] empty answer — escalating <cheap> → <work>` and the turn still
  answers; aborted turns never retry.

## 9. Known limits (stated, not hidden)

- Meetings capture the microphone, not system audio, so other participants are
  only heard through the speakers.
- Spotify has no search in AppleScript; finding a track by name is a UI task.
- Whisper mishears the wake name sometimes ("Javis"); the wake-word matcher
  accepts the common variants, but dictation text is whatever whisper heard.
- The drawing overlay draws arrows, boxes and labels — not freehand ink or
  multi-step shapes.
- System Settings panes are opened, not clicked: you still flip the toggle.

## 10. Troubleshooting in one place

| Symptom | Cause | Fix |
| --- | --- | --- |
| "model not found" | the routed model was never pulled | `ollama pull qwen2.5:14b`; JARVIS now falls back to an installed model and says so in the log |
| Reply text appears only when you focus the window | old build | Fixed: the reveal loop keeps a timer beside `requestAnimationFrame` |
| Tools all fail with `approval_required` | expected for confirm-tier | approve the card; auto-tier tools run without one |
| `automation_denied` | Contacts/Spotify Automation not granted | ask JARVIS to `open_settings automation` |
| Dictation types nothing | Accessibility missing for the app/helper | `open_settings accessibility`; check `/tmp/jarvis-logs/menubar.log` for `accessibility trusted`; remove and re-add JARVISMenuBar once |
| "Nothing transcribed" after speaking | system input volume too low, or the dev server is down | raise it: `osascript -e 'set volume input volume 80'`; `curl 127.0.0.1:4173/api/transcribe` |
| Menu bar can't reach the app | dev server on a different port | the app and the verifier both expect `127.0.0.1:4173`; `bun run dev` now serves that port |
| Wake word shows "off" while listening | stale menu state (fixed) | update the menu-bar build |
| Dictation works but the app says the helper is missing | wrong helper path (fixed) | rebuild with `native/jarvis-menubar/build.command` |
| Voice is silent | XTTS server not running | `.xtts-venv/bin/python -u xtts_server.py`; `curl 127.0.0.1:8080/health` → `{"status":"ok"}` |
| Voice silent even though the server runs | its audio library wants FFmpeg 4 sonames (`libavutil.56`) while Homebrew ships 61+, so `/speak` returned 500 | fixed: `xtts_server.py` decodes the reference WAV itself; a synthesis log line `[XTTS] 45 chars -> … bytes` means it works |
| Wake word shows on but nothing happens | the listener never re-armed after a dictation (fixed) | rebuild `native/jarvis-menubar/build.command`; the menu now stays "on" and returns to listening when a recording ends |
| Replies arrive all at once, and tool calls do nothing | a provider wrapper hid `chatStream`/`parseMetadata` (fixed) | expect `event: token` lines and a visible tool round-trip |
| Meeting transcript empty | whisper/model missing | check `WHISPER_BIN` and `models/ggml-small.en.bin`; `bun run verify` reports it |
