#!/bin/bash
# ============================================================
#  JARVIS Amber-Core: One-Click Startup
#  Double-click this file to start everything.
# ============================================================

cd "$(dirname "$0")"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     J A R V I S  —  Starting...     ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Step 1: Check if .env.local exists
if [ ! -f ".env.local" ]; then
    echo "⚠  .env.local not found."
    echo "   Please copy .env.local.example to .env.local and fill in your keys."
    echo "   See SETUP.md for details."
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

# ────────────────────────────────────────────────────────────
#  Check for FFmpeg (required by torchcodec for audio I/O)
# ────────────────────────────────────────────────────────────
if command -v ffmpeg &>/dev/null; then
    echo "  ✓  FFmpeg found."
else
    echo ""
    echo "  ╔══════════════════════════════════════════════════════════╗"
    echo "  ║  FFmpeg is not installed — required for voice audio.    ║"
    echo "  ╚══════════════════════════════════════════════════════════╝"
    echo ""
    if command -v brew &>/dev/null; then
        echo "  Homebrew is available. Installing FFmpeg..."
        brew install ffmpeg
        if [ $? -ne 0 ]; then
            echo ""
            echo "  ✗  FFmpeg install failed. Check the brew output above."
            read -p "Press Enter to exit..."
            exit 1
        fi
        echo "  ✓  FFmpeg installed."
    else
        echo "  Homebrew is not installed. You need it to install FFmpeg."
        echo ""
        echo "  To install Homebrew:"
        echo "    1. Open Terminal"
        echo "    2. Paste this command and press Enter:"
        echo "       /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        echo "    3. Follow the on-screen instructions"
        echo "    4. Once done, double-click start-jarvis.command again"
        echo ""
        read -p "Press Enter to exit..."
        exit 1
    fi
fi

# ────────────────────────────────────────────────────────────
#  Find a compatible Python (3.10 – 3.12)
#  Python 3.13+ and 3.14 lack PyTorch wheels for Apple Silicon.
# ────────────────────────────────────────────────────────────
find_python() {
    # Try known versioned names first (most common on macOS after brew install)
    for cmd in python3.12 python3.11 python3.10; do
        if command -v "$cmd" &>/dev/null; then
            if "$cmd" -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3,10) and sys.version_info[:2] <= (3,12) else 1)" 2>/dev/null; then
                echo "$cmd"
                return 0
            fi
        fi
    done

    # Fallback: check if plain python3 is in the compatible range
    if command -v python3 &>/dev/null; then
        if python3 -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3,10) and sys.version_info[:2] <= (3,12) else 1)" 2>/dev/null; then
            echo "python3"
            return 0
        fi
        # Show what version python3 actually is (to stderr so it doesn't pollute the return value)
        PYVER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null)
        echo "  ✗  python3 is version $PYVER — too new for PyTorch" >&2
    fi

    return 1
}

PYTHON=$(find_python)
if [ $? -ne 0 ]; then
    echo ""
    echo "  ╔══════════════════════════════════════════════════════════╗"
    echo "  ║  JARVIS needs Python 3.10, 3.11, or 3.12 for voice.    ║"
    echo "  ╚══════════════════════════════════════════════════════════╝"
    echo ""
    echo "  Python 3.13+ doesn't have PyTorch wheels for Apple Silicon yet."
    echo ""
    echo "  To install Python 3.12:"
    echo "    1. Go to https://www.python.org/downloads/"
    echo "    2. Download Python 3.12 (look for the macOS installer)"
    echo "    3. Run the installer — click through the defaults"
    echo "    4. Once installed, double-click start-jarvis.command again"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

PYVER=$($PYTHON -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo "[1/5] Found compatible Python: $PYTHON (v$PYVER)"

# ────────────────────────────────────────────────────────────
#  Create / activate virtual environment
# ────────────────────────────────────────────────────────────
if [ ! -d ".xtts-venv" ]; then
    echo "      Creating virtual environment..."
    $PYTHON -m venv .xtts-venv
    if [ $? -ne 0 ]; then
        echo ""
        echo "  ✗  Failed to create virtual environment."
        echo "     Make sure the Python above is working correctly."
        read -p "Press Enter to exit..."
        exit 1
    fi
    echo "      Created .xtts-venv with $PYTHON."
else
    # Verify existing venv uses a compatible Python
    VENV_PY=$(.xtts-venv/bin/python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null)
    if [ "$VENV_PY" != "$PYVER" ]; then
        echo "      Existing venv uses Python $VENV_PY, but $PYVER is available."
        echo "      Recreating venv with Python $PYVER..."
        rm -rf .xtts-venv
        $PYTHON -m venv .xtts-venv
        if [ $? -ne 0 ]; then
            echo "  ✗  Failed to recreate virtual environment."
            read -p "Press Enter to exit..."
            exit 1
        fi
    fi
fi
source .xtts-venv/bin/activate

# ────────────────────────────────────────────────────────────
#  Step 2: Install PyTorch + Torchaudio (must be explicit —
#  coqui-tts doesn't pull them in automatically)
# ────────────────────────────────────────────────────────────
echo "[2/5] Installing PyTorch and Torchaudio..."
echo "      (This is a large download — 2+ GB — and takes a few minutes.)"
pip install torch torchaudio 2>&1
TORCH_EXIT=$?
if [ $TORCH_EXIT -ne 0 ]; then
    echo ""
    echo "  ╔══════════════════════════════════════════════════════════╗"
    echo "  ║  ✗  PyTorch install failed (exit code $TORCH_EXIT)                ║"
    echo "  ╚══════════════════════════════════════════════════════════╝"
    echo ""
    echo "  Check the pip output above for the real error."
    echo ""
    echo "  If you see 'No matching distribution found for torch',"
    echo "  your Python version ($PYVER) may not have a compatible wheel."
    echo "  Try installing Python 3.12 from https://www.python.org/downloads/"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi
echo "      PyTorch installed."

# ────────────────────────────────────────────────────────────
#  Step 3: Install coqui-tts + flask + pinned transformers
#  coqui-tts 0.27.5 declares transformers>=4.57 with no upper bound,
#  but transformers 5.1+ removed isin_mps_friendly which XTTS needs.
#  Pin to <5.1 until the upstream fix lands in a release.
# ────────────────────────────────────────────────────────────
echo "[3/5] Installing coqui-tts, flask, and compatible transformers..."
pip install "coqui-tts[codec]" "transformers>=4.57,<5.1" flask 2>&1
TTS_EXIT=$?
if [ $TTS_EXIT -ne 0 ]; then
    echo ""
    echo "  ╔══════════════════════════════════════════════════════════╗"
    echo "  ║  ✗  coqui-tts install failed (exit code $TTS_EXIT)                ║"
    echo "  ╚══════════════════════════════════════════════════════════╝"
    echo ""
    echo "  Check the pip output above for the real error."
    echo "  Common fix: make sure Xcode Command Line Tools are installed:"
    echo "    xcode-select --install"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi
echo "      coqui-tts installed."

# ────────────────────────────────────────────────────────────
#  Step 4: Verify imports actually work
#  (pip can return 0 even when native deps are broken)
# ────────────────────────────────────────────────────────────
echo "[4/5] Verifying imports..."
python -c "import torch; print(f'      PyTorch {torch.__version__} OK')" 2>&1
if [ $? -ne 0 ]; then
    echo ""
    echo "  ╔══════════════════════════════════════════════════════════╗"
    echo "  ║  ✗  PyTorch installed but import failed                 ║"
    echo "  ╚══════════════════════════════════════════════════════════╝"
    echo ""
    echo "  Try: source .xtts-venv/bin/activate && pip install --force-reinstall torch torchaudio"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

python -c "import transformers; print(f'      transformers {transformers.__version__} OK')" 2>&1
if [ $? -ne 0 ]; then
    echo ""
    echo "  ╔══════════════════════════════════════════════════════════╗"
    echo "  ║  ✗  transformers installed but import failed            ║"
    echo "  ╚══════════════════════════════════════════════════════════╝"
    echo ""
    echo "  Try: source .xtts-venv/bin/activate && pip install \"transformers>=4.57,<5.1\""
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

python -c "from TTS.api import TTS; print('      coqui-tts import OK')" 2>&1
if [ $? -ne 0 ]; then
    echo ""
    echo "  ╔══════════════════════════════════════════════════════════╗"
    echo "  ║  ✗  coqui-tts installed but import failed               ║"
    echo "  ╚══════════════════════════════════════════════════════════╝"
    echo ""
    echo "  Try: source .xtts-venv/bin/activate && pip install --force-reinstall coqui-tts"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi
echo "      All imports verified."

# ────────────────────────────────────────────────────────────
#  Step 5: Set up DYLD path for FFmpeg (torchcodec needs this)
# ────────────────────────────────────────────────────────────
# torchcodec on macOS has no LC_RPATH entries, so it can't find
# FFmpeg's .dylibs without this hint.
if command -v brew &>/dev/null; then
    export DYLD_FALLBACK_LIBRARY_PATH="$(brew --prefix)/lib:$DYLD_FALLBACK_LIBRARY_PATH"
    echo "[5/6] DYLD_FALLBACK_LIBRARY_PATH set for FFmpeg."
else
    echo "[5/6] Homebrew not found — voice server may fail to load FFmpeg."
fi
# Playwright Chromium check skipped (install manually: cd local-agent && bunx playwright install chromium)

# Start local agent (filesystem, desktop control, system tools)
echo "[6/6] Starting local agent..."
bun local-agent/server.ts &
AGENT_PID=$!
echo "      Local agent PID: $AGENT_PID"
sleep 1

# ─── Step 5: Start voice server (XTTS-v2) ───
# Start voice server
python xtts_server.py &
XTTS_PID=$!
echo "      Voice server PID: $XTTS_PID"

echo "      Waiting for voice server to initialize..."
for i in $(seq 1 30); do
    if curl -s http://127.0.0.1:8080/health > /dev/null 2>&1; then
        echo "      Voice server is ready!"
        break
    fi
    sleep 2
done

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   JARVIS is running!                ║"
echo "  ║   http://localhost:3000              ║"
echo "  ║                                      ║"
echo "  ║   Press Ctrl+C to stop everything.   ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Cleanup on exit
cleanup() {
    echo ""
    echo "Shutting down..."
    kill $AGENT_PID 2>/dev/null
    kill $XTTS_PID 2>/dev/null
    exit 0
}
trap cleanup INT TERM

bun run dev

# If bun exits, also kill local agent and XTTS
kill $AGENT_PID 2>/dev/null
kill $XTTS_PID 2>/dev/null
