# JARVIS Amber-Core — Setup Guide

> Zero command-line experience required. Every step is click-by-click.

> **Python version matters:** The voice engine (XTTS-v2) requires **Python 3.10, 3.11, or 3.12**.
> Python 3.13+ does not yet have compatible PyTorch wheels for Apple Silicon.
> The startup script will detect this automatically, but if you only have Python 3.13+
> installed, download Python 3.12 from [python.org](https://www.python.org/downloads/) first.

---

## What You're Building

A personal AI assistant with:
- A stunning visual core (the amber orb you already have)
- Text chat powered by GLM (Z.ai's AI)
- Voice cloning via XTTS-v2 (runs locally on your Mac)
- Camera support for image analysis
- Memory that compounds over time
- Pluggable tool system (MCP)

---

## Step 1: Get a Z.ai API Key

1. Open your browser and go to **https://open.bigmodel.cn**
2. Click **Sign Up** (top right) and create an account
3. Once logged in, click **API Keys** in the left sidebar
4. Click **Create API Key**
5. Give it a name like `jarvis` and click **Create**
6. **Copy the key** — it looks like a long string of letters and numbers
7. Keep this page open — you'll need it in Step 3

---

## Step 2: Set Up Your Environment Variables

1. In your project folder, find the file called **`.env.local`**
2. Open it with any text editor (TextEdit, VS Code, etc.)
3. You'll see several lines that need your actual values:

```
# === Supabase ===
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...your_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=eyJ...your_service_role_key_here

# === Z.ai (GLM) ===
ZAI_API_KEY=your_zai_api_key_here

# === XTTS-v2 (local voice server) ===
XTTS_URL=http://127.0.0.1:8080
VOICE_SAMPLE_PATH=./voice_sample.wav
```

4. Replace each placeholder with your actual values:

**For Supabase** (you said you already have this):
- Go to your Supabase dashboard: **https://supabase.com/dashboard**
- Select your project
- Click **Project Settings** (gear icon, bottom left)
- Click **API** in the sidebar
- Copy the **Project URL** → paste as `VITE_SUPABASE_URL`
- Copy the **anon public** key → paste as `VITE_SUPABASE_ANON_KEY`
- Copy the **service_role** key → paste as `SUPABASE_SERVICE_ROLE_KEY`

**For Z.ai**:
- Paste the API key you created in Step 1 → `ZAI_API_KEY`

5. Save the file

---

## Step 3: Create the Database Tables

1. Go to your Supabase dashboard
2. Click **SQL Editor** in the left sidebar
3. Click **New query**
4. Open the file `supabase/migrations/001_initial_schema.sql` in your project folder
5. Select all the text in that file and copy it
6. Paste it into the SQL Editor in Supabase
7. Click **Run** (bottom right, green button)
8. You should see "Success. No rows returned" — the tables are created

---

## Step 4: Prepare a Voice Sample (Optional, for Voice Cloning)

To make JARVIS sound like a specific voice:

1. Record a short audio clip (5-15 seconds) of someone speaking clearly
   - Can be you, or anyone whose voice you want to clone
   - Just speak naturally — no background music
   - WAV format is best, but MP3 works too
2. If it's not already a .wav file, convert it:
   - Go to **https://audio.online-convert.com/convert-to-wav**
   - Upload your file, click **Convert**, download the result
3. Rename the converted file to **`voice_sample.wav`**
4. Place it in your project folder (same folder as `start-jarvis.command`)
5. If you skip this, JARVIS will use a default voice (still works, just not cloned)

---

## Step 5: Start JARVIS

1. Open Finder and navigate to your project folder
2. Find the file called **`start-jarvis.command`**
3. **Double-click it**
4. A Terminal window will open and show startup messages
5. Wait for it to say "JARVIS is running!" (takes 30-60 seconds on first run while the voice model downloads)
6. Your browser should open to **http://localhost:3000**

**That's it!** You should see the amber orb with the chat input at the bottom.

---

## Step 6: Test the Round-Trip

1. **Type a message** in the chat box (e.g., "Hello, JARVIS")
2. Press **Enter** or click the send button
3. Watch the orb change to **THINKING** state (amber flares up)
4. Wait for the response text to appear
5. The orb changes to **SPEAKING** as the audio plays back
6. After playback, it returns to **IDLE**

If you see an error about the Z.ai API key, double-check your `.env.local`.
If you see a Supabase error, make sure you ran the migration SQL in Step 3.

---

## Stopping JARVIS

- Click the Terminal window that's running
- Press **Control + C** to stop everything

---

## Troubleshooting

**"Command not found: bun"**
- You need Bun installed. Go to **https://bun.sh** and click the install button, or run `curl -fsSL https://bun.sh/install | bash` in Terminal.

**"Command not found: python3"**
- macOS should have Python 3 built in. If not, go to **https://www.python.org/downloads/** and install it.

**"No compatible Python found" / Python 3.13+ error**
- PyTorch doesn't have wheels for Python 3.13+ on Apple Silicon yet.
- Install Python 3.12: go to **https://www.python.org/downloads/** → download the macOS installer for 3.12 → run it → double-click start-jarvis.command again.
- The startup script checks for `python3.12`, `python3.11`, `python3.10` automatically.

**"PyTorch install failed" / "No matching distribution found for torch"**
- Your Python version is likely too new (3.13 or 3.14). See the note above.
- Also check: Xcode Command Line Tools (`xcode-select --install`).

**Voice install fails / "TTS library not installed"**
- The voice package is **`coqui-tts`** (the old `TTS` package was abandoned).
- The startup script installs PyTorch, coqui-tts, and flask in separate steps so you can see exactly which one failed.
- Common fix: make sure Xcode Command Line Tools are installed: `xcode-select --install`

**Voice server is slow / takes 5+ seconds**
- This is normal on Apple Silicon (M4 Pro, no GPU). The XTTS model runs on CPU. First request is slowest; subsequent ones are 2-5 seconds. Not a bug.

**Camera not working**
- Make sure you're using HTTPS or localhost (camera requires secure context)
- Check System Preferences → Privacy & Security → Camera → allow your browser

---

## Pushing Changes to GitHub

Once you have a working version and want to save it:

1. Open the project folder
2. The project is connected to Lovable — any changes you make will sync
3. To push manually via Freebuff Web:
   - Use the Git integration in Freebuff to commit and push your changes
   - Your code will be saved to your connected GitHub repository

---

## Environment Variables Reference

| Variable | Where to get it | Safe for browser? |
|----------|----------------|-------------------|
| `VITE_SUPABASE_URL` | Supabase Dashboard → Settings → API | ✅ Yes |
| `VITE_SUPABASE_ANON_KEY` | Supabase Dashboard → Settings → API | ✅ Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Settings → API | ❌ Server-only |
| `ZAI_API_KEY` | open.bigmodel.cn → API Keys | ❌ Server-only |
| `XTTS_URL` | Local (http://127.0.0.1:8080) | N/A |
| `VOICE_SAMPLE_PATH` | Your project folder | N/A |

---

## File Structure

```
amber-core/
├── src/
│   ├── components/
│   │   ├── JarvisCore.tsx      # The amber visual core
│   │   ├── ChatInput.tsx       # Chat input with mic/camera
│   │   ├── MessageList.tsx     # Message history
│   │   ├── PatternProposal.tsx # Inferred pattern confirmation
│   │   ├── StatusOverlay.tsx   # State indicator
│   │   └── CameraPanel.tsx     # Webcam feed
│   ├── lib/
│   │   ├── ai/
│   │   │   ├── provider.ts     # GLM abstraction layer
│   │   │   └── system-prompt.ts # JARVIS personality
│   │   ├── mcp/
│   │   │   └── registry.ts     # MCP server registry
│   │   ├── supabase-browser.ts # Browser Supabase client
│   │   ├── supabase-server.ts  # Server-only Supabase client
│   │   ├── supabase-types.ts   # TypeScript types for DB
│   │   ├── guardrails.ts       # Permissions + kill switch
│   │   └── jarvis-core.ts      # Visual engine
│   ├── functions/
│   │   ├── chat.ts             # Chat server function
│   │   ├── speak.ts            # Voice server function
│   │   └── kill.ts             # Kill switch endpoint
│   └── routes/
│       ├── index.tsx           # Main page
│       └── __root.tsx          # Root layout
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql
├── xtts_server.py              # XTTS-v2 Python server
├── start-jarvis.command        # One-click startup
├── .env.local                  # Your keys (don't share!)
└── SETUP.md                    # This file
```
