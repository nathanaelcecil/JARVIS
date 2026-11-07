# JARVIS — status report (7 Nov 2026)

Scope: the three faults reported after the last round (no voice, wake word not
arming the mic, replies extremely slow), the autosave request, the permissions
guarantee, and the remaining Atticus parity work.

## 1. Faults found and fixed

### Voice was silent while text appeared
Two independent causes, both on the speech path:

1. **No server.** `/speak` posts to `127.0.0.1:8080`; nothing was listening, so
   every clip failed instantly and the UI fell back to text only.
2. **The server crashed on every synthesis.** `xtts_server.py` loaded, then
   raised `OSError: Could not load this library:
   …/torchcodec/libtorchcodec_core4.dylib`. Its bundled library links against
   FFmpeg 4 sonames (`libavutil.56`, `libavcodec.58`); this Mac has Homebrew
   FFmpeg 8 (`libavutil.61`). `/speak` returned 500 with an empty body, which the
   app reported as nothing at all.

Fix: `xtts_server.py` now decodes the reference voice WAV itself (stdlib `wave` +
torch, 8/16/24/32-bit, mono/stereo, resampled with `torchaudio.functional`), so
torchcodec is never invoked. Requests are logged unbuffered (`python -u`).

Evidence — real audio, not silence:

```
GET  /health            {"status": "ok", "model": "xtts_v2"}
POST /speak  45 chars → 193132 bytes in 3365ms
POST /speak  34 chars → 143980 bytes in 2617ms
ffprobe      duration=2.998667s
volumedetect mean_volume: -15.7 dB, max_volume: -0.0 dB
```

In the running app a nearby turn produced `[XTTS] 68 chars → 240236 bytes`, so the
browser asked for speech and received it.

### Wake word never turned the mic on
The listener was **off**: `wakeEnabled` was set to false by `stopWakeWord()`,
which dictation and meetings both call, and nothing set it back. Toggling the
menu item looked like it did nothing because the next recording switched it off
again.

Fix (`native/jarvis-menubar/main.swift`):
- a separate `wakeWanted` flag records intent, and the menu reflects that;
- `rearmWakeWord()` runs when dictation or a meeting recording ends;
- the toggle turns off only when the user says so.

Evidence: with the wake word on, playing "Hey Jarvis, are you there?" through the
speakers flipped the menu to **Stop dictating** (the listener fired and recording
started); stopping it returned the menu to *Wake word: on* and the log to
`wake: listening (onDevice=true)`.

### Replies extremely slow, and tool calls did nothing
Regression from the previous round: the new `EscalatingProvider` wrapped the
Ollama provider but only implemented `chat()`. Callers feature-detect
`chatStream` and `parseMetadata`, so:

- streaming was silently lost — the whole reply arrived at once (a measured turn
  spent **13.7 s** producing a blob);
- `metadata.tools` was never parsed, so **every** tool call in a reply was
  dropped, including `ask_user`.

Fix: the wrapper now delegates `chatStream` and `parseMetadata` to the wrapped
provider, pinned by two regression tests.

Evidence, same endpoint and prompt after the fix:

```
first_token = 1.59s   (events: ack, perf×5, token…token)
turn total  = 2.36s   (was 13.7s to first visible text)
```

## 2. Autosave (requested)

Every transcribed dictation is appended to
`~/Documents/JARVIS/dictation/YYYY-MM-DD.md` before anything else happens, so a
dictation survives even when there is no text field to type into, Accessibility
refuses the keystrokes, or the window has moved on. Menu → **Open dictation
folder** opens it.

Evidence: a spoken test wrote

```
# JARVIS dictation — 2026-11-07

- 10:26 Autosave check 1,2,3
```

Meeting recordings already auto-save their `.m4a` and `.md` next to it.

## 3. Permissions kept across rebuilds

The bundle is signed by identifier (`identifier "local.jarvis.menubar"`) rather
than by hash, so rebuilding does not invalidate the Accessibility grant. Verified
after two rebuilds in this session:

```
[JARVISMenuBar] ready — app origin http://127.0.0.1:4173
[JARVISMenuBar] accessibility trusted = true
[JARVISMenuBar] wake: speech authorization status = 3   (authorized)
[JARVISMenuBar] wake: mic granted = true
```

## 4. Atticus parity this round

| Item | State | Where |
| --- | --- | --- |
| Point-at-screen crop | ✅ `hands_crop(x, y, w, h)`; rejects regions under 8×8 | `local-agent/tools/hands.ts` |
| Task-scoped approval | ✅ card offers "Always allow … for this task"; scope dies with the turn; each allowed call still mints its own single-use token | `src/lib/task-approvals.ts` |
| Cheap → work model escalation | ✅ `EscalatingProvider`, transparent to streaming/metadata | `src/lib/ai/provider.ts` |
| Pick card (`ask_user`) | ✅ card pauses the turn; `POST /api/pick` resolves it; dismissal and abort release it; 3-minute timeout | `src/lib/picks.ts`, `src/components/PickCard.tsx` |

Verified live: a reply containing an `ask_user` tool call rendered **JARVIS — YOUR
CALL** with Red / Green / Blue / Never mind; clicking a choice resolved the pick
and the turn completed.

Still open, and still marked open in `ATTICUS_PARITY.md`: named reusable agents,
`[insert]`/`[replace]`/`[draft]` reply tags, background agents with voice
steering, mini window preview, meeting copilot, dictation pill, plus the partial
items (system audio capture, streaming transcripts, Anthropic client, settings
panes).

## 5. Checks run

```
bun run verify   →  10 passed · 0 failed · 0 skipped
                    typecheck, 563 tests, lint, both helpers (AX + screen
                    recording), models, 63 agent tools, STT, menu bar, keys
```

Manual, on this machine: voice synthesis + playback request, wake word →
dictation → re-arm, dictation typing, dictation autosave, pick card render and
resolution.

Not verified: whether the audio was audible (levels and duration were verified,
but hearing it needs a person), and `ask_user` chosen freely by the model rather
than by an explicit instruction — the plumbing is proven, the model's judgement
is not.

## 6. Using it

```bash
./start-jarvis.command        # app on 127.0.0.1:4173, agent on :3008
./.xtts-venv/bin/python -u xtts_server.py   # voice on :8080 (health check)
open native/jarvis-menubar/bin/JARVISMenuBar.app
bun run verify                # the honest gate
```

`CAPABILITIES.md` is the operator's guide: every capability, how to trigger it,
what "working" looks like, and a troubleshooting table that now covers each fault
above.
