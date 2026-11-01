# Third-Party Notices

This file records the third-party components JARVIS depends on and the licenses
that could be verified **on this machine, from installed package metadata**
(`package.json`, Python `*.dist-info/METADATA`, and installed `LICENSE` files).
Anything that could not be verified that way is explicitly marked
**unverified**. Nothing here is legal advice, and this document does **not**
choose a license for JARVIS itself.

Verified on: macOS (Darwin 25.3.0, arm64), Node 20.19.5, Bun 1.3.14,
Python 3.12 virtualenv at `.xtts-venv`.

---

## 1. JavaScript runtime dependencies (root app)

Versions are what is installed in `node_modules`; licenses come from each
package's own `package.json` `license` field.

| Package                           | Installed     | License    |
| --------------------------------- | ------------- | ---------- |
| `@hookform/resolvers`             | 5.5.7         | MIT        |
| `@radix-ui/react-*` (28 packages) | 1.1.x – 2.3.x | MIT        |
| `@supabase/supabase-js`           | 2.115.0       | MIT        |
| `@tailwindcss/vite`               | 4.3.3         | MIT        |
| `@tanstack/react-query`           | 5.101.4       | MIT        |
| `@tanstack/react-router`          | 1.170.18      | MIT        |
| `@tanstack/react-start`           | 1.168.32      | MIT        |
| `@tanstack/router-plugin`         | 1.168.23      | MIT        |
| `class-variance-authority`        | 0.7.1         | Apache-2.0 |
| `clsx`                            | 2.1.1         | MIT        |
| `cmdk`                            | 1.1.1         | MIT        |
| `date-fns`                        | 4.4.0         | MIT        |
| `embla-carousel-react`            | 8.6.0         | MIT        |
| `input-otp`                       | 1.4.2         | MIT        |
| `lucide-react`                    | 0.575.0       | ISC        |
| `react` / `react-dom`             | 19.2.8        | MIT        |
| `react-day-picker`                | 9.14.0        | MIT        |
| `react-hook-form`                 | 7.83.0        | MIT        |
| `react-resizable-panels`          | 4.12.2        | MIT        |
| `recharts`                        | 2.15.4        | MIT        |
| `sonner`                          | 2.0.7         | MIT        |
| `tailwind-merge`                  | 3.6.0         | MIT        |
| `tailwindcss`                     | 4.3.3         | MIT        |
| `tw-animate-css`                  | 1.4.0         | MIT        |
| `vaul`                            | 1.1.2         | MIT        |
| `vite-tsconfig-paths`             | 6.1.1         | MIT        |
| `ws`                              | 8.21.1        | MIT        |
| `zod`                             | 3.25.76       | MIT        |

### Development / build-time

`@eslint/js` 9.39.5 (MIT), `@lovable.dev/vite-tanstack-config` 2.15.0 (MIT),
`@types/*` (MIT), `@vitejs/plugin-react` 5.2.0 (MIT), `eslint` 9.39.5 (MIT),
`eslint-config-prettier` 10.1.8 (MIT), `eslint-plugin-prettier` 5.5.6 (MIT),
`eslint-plugin-react-hooks` 5.2.0 (MIT), `eslint-plugin-react-refresh` 0.4.26
(MIT), `globals` 15.15.0 (MIT), `nitro` 3.0.260603-beta (MIT), `prettier` 3.9.6
(MIT), `typescript` 5.9.3 (Apache-2.0), `typescript-eslint` 8.65.0 (MIT),
`vite` 8.1.5 (MIT), `vitest` 3.2.7 (MIT).

### The shadcn/Radix component kit

`src/components/ui/` contains 46 shadcn-style components built on the
`@radix-ui/*` packages above (MIT) plus `class-variance-authority`
(Apache-2.0), `cmdk`, `vaul`, `sonner`, `embla-carousel-react` and
`react-day-picker`. 31 source files reference `@radix-ui` (including the kit
itself), so the kit is part of the distributed source even where a screen does
not import a given component. Removing unused components is a cleanup decision,
not a licensing one; their licenses still apply to anything shipped.

## 2. Local agent

| Package      | Installed                              | License    |
| ------------ | -------------------------------------- | ---------- |
| `playwright` | 1.63.0 (in `local-agent/node_modules`) | Apache-2.0 |

Playwright downloads browser binaries separately on install; those binaries
carry their own notices (Chromium/BSD-style, Firefox/MPL-2.0 and others) that
are **unverified** here because no browser was installed during this task.

## 3. VS Code extension (`vscode-extension/`)

No runtime dependencies. Development-only:

| Package         | Installed | License    |
| --------------- | --------- | ---------- |
| `typescript`    | 5.9.3     | Apache-2.0 |
| `tsx`           | 4.23.15   | MIT        |
| `@types/vscode` | 1.140.0   | MIT        |
| `@types/node`   | 20.19.43  | MIT        |

## 4. Python voice dependencies

Verified from `*.dist-info/METADATA` inside `.xtts-venv`:

| Package                                   | Installed | License (from metadata)                                                                                                                                                                           |
| ----------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `torch`                                   | 2.14.0    | Composite: `Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT` (bundles third-party components — see its `LICENSE` and `third_party/*/LICENSE`) |
| `torchaudio`                              | 2.11.0    | BSD (classifier: `License :: OSI Approved :: BSD License`)                                                                                                                                        |
| `torchcodec`                              | 0.16.0    | **unverified** (metadata present, license field not read)                                                                                                                                         |
| `coqui-tts` (`coqui_tts`)                 | 0.27.5    | MPL-2.0                                                                                                                                                                                           |
| `coqui-tts-trainer` (`coqui_tts_trainer`) | 0.3.3     | Apache-2.0                                                                                                                                                                                        |
| `flask`                                   | 3.1.3     | BSD-3-Clause                                                                                                                                                                                      |
| `transformers`                            | 5.0.0     | Apache-2.0                                                                                                                                                                                        |

`start-jarvis.command` installs `torch`, `torchaudio`, `coqui-tts[codec]`,
`transformers>=4.57,<5.1` and `flask`. Note that `transformers` 5.0.0 is
installed despite the `<5.1` pin; the pin exists because 5.1+ removed
`isin_mps_friendly`, which XTTS uses.

## 5. whisper.cpp and the GGML model

- **whisper.cpp** 1.9.4 (Homebrew `whisper.cpp`, binary at
  `/opt/homebrew/bin/whisper-cli` → Cellar): **MIT** — verified from the
  installed `LICENSE` file (`Copyright (c) 2023-2026 The ggml authors`).
- **`models/ggml-small.en.bin`** (GGML conversion of an OpenAI Whisper model):
  license **unverified**. OpenAI's Whisper weights are generally reported as
  MIT, but the conversion and redistribution terms of this specific file were
  not verified on this machine. Verify before redistributing the model.

## 6. Models served through Ollama

JARVIS talks to a locally running Ollama server and whatever model the user has
pulled (e.g. a Llama/Qwen/Gemma-family model). The model weights are **not**
vendored in this repository and their licenses are **unverified** here — they
depend entirely on the model the user pulls and are governed by that model's
own license (several popular families have community licenses with use
restrictions). Nothing in this repository grants rights to those weights.

## 7. XTTS-v2 and the Coqui Public Model License

`xtts_server.py` loads **XTTS-v2** through `coqui-tts`. Before loading, it sets:

```python
os.environ["COQUI_TOS_AGREED"] = "1"
```

That flag records acceptance of the Coqui Public Model License (CPML) on the
user's behalf. The **CPML is reported to be non-commercial** and to impose
attribution/notice obligations; **this was not verified here** (no license text
is shipped in this repository). Treat XTTS-v2 as **not cleared for commercial
distribution** until the CPML text is read and the intended use is checked
against it. The `coqui-tts` _code_ is MPL-2.0 (verified above); the _model
weights_ are governed separately by the CPML (**unverified**).

## 8. `voice_sample.wav`

The repository ignores `voice_sample.wav` (it is not tracked) and it was not
read during this task. A voice sample is personal data and may carry rights
(speaker consent, performance rights, and — depending on provenance — a
dataset license). **Rights are unverified.** Do not redistribute it, and obtain
the speaker's consent before publishing generated audio.

## 9. Reference projects (no code copied)

- **Atticus Mac** (`SaarthurR/atticus-mac`, MIT) and its `LICENSE-Plip`
  (MIT, Hussain) were reviewed as **references only**. No code, prompts, or
  assets were copied, vendored, or ported, and JARVIS takes no dependency on
  them. The read-only accessibility design in `native/jarvis-hands/` was
  written independently from Apple's Accessibility API documentation.
- **Feature-level parity is not code reuse.** `ATTICUS_PARITY.md` tracks
  capabilities that exist in both projects. Those JARVIS features (screen
  observation and OCR, computer control, and the items scheduled there) were
  implemented independently against Apple's Accessibility/Vision/CoreGraphics
  documentation and this repository's own architecture. Atticus influenced the
  _feature list and permission model_, not the implementation.
- If any logic is ever ported from an MIT-licensed project in the future, the
  MIT copyright notice and permission notice for that project **must be
  preserved** in this file (or a bundled notices file).

## 10. Unresolved licensing questions

1. **JARVIS has no `LICENSE` file.** No root `LICENSE`, `COPYING`, or
   `NOTICE` file exists. Without one, default copyright applies and others have
   no granted rights. This document deliberately **does not choose** a license.
2. **Package name is the template default** `tanstack_start_ts`
   (`package.json`), and the app still contains template scaffolding (the
   shadcn/Radix kit, template UI). Decide the project name and license before
   publishing.
3. **Model and voice assets** (XTTS-v2/CPML, Ollama weights, whisper GGML
   model, `voice_sample.wav`) are the highest-risk items for distribution and
   are unverified (see §§5–8).
4. **Playwright browser binaries** downloaded at install time carry their own
   notices, unverified here.
5. Whether the unused portions of the shadcn/Radix kit should be removed before
   distribution is a product decision; their licenses are permissive
   (MIT/Apache-2.0) either way.
