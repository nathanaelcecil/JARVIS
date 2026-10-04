"""
JARVIS XTTS-v2 Voice Server
Runs alongside the TanStack app to provide text-to-speech with voice cloning.

Usage:
  python xtts_server.py

This server:
- Loads XTTS-v2 model at startup (first request will be slow, subsequent ones fast)
- Accepts POST /speak with { "text": "..." }
- Returns WAV audio bytes
- Uses a reference voice sample for cloning (configurable via VOICE_SAMPLE_PATH env var)

Apple Silicon (M4 Pro): runs on CPU/MPS. Expect 2-5 seconds latency per response.
"""

import os
import sys
import io
import json
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Auto-accept the CPML non-commercial license so the model can download
# without an interactive prompt (this script runs in the background).
os.environ["COQUI_TOS_AGREED"] = "1"

# Configuration
HOST = "127.0.0.1"
PORT = 8080
VOICE_SAMPLE_PATH = os.environ.get("VOICE_SAMPLE_PATH", "./voice_sample.wav")

# Global model reference
tts_model = None


def load_model():
    """Load the XTTS-v2 model. This takes a while on first run."""
    global tts_model
    try:
        from TTS.api import TTS as TTSApi

        print("[XTTS] Loading XTTS-v2 model...")
        print("[XTTS] This may take 30-60 seconds on first run.")
        print("[XTTS] On Apple Silicon, using CPU/MPS backend.")

        # Use the XTTS v2 model specifically
        tts_model = TTSApi(model_name="tts_models/multilingual/multi-dataset/xtts_v2")
        print("[XTTS] Model loaded successfully.")
        return True
    except ImportError:
        print("[XTTS] ERROR: coqui-tts library not installed.")
        print("[XTTS] Run: pip install coqui-tts")
        return False
    except Exception as e:
        print(f"[XTTS] ERROR loading model: {e}")
        return False


def synthesize(text: str) -> bytes:
    """Synthesize speech from text, optionally using a reference voice."""
    global tts_model

    if tts_model is None:
        raise RuntimeError("Model not loaded")

    # Create an in-memory buffer for the WAV output
    wav_buffer = io.BytesIO()

    # Check if reference voice exists
    voice_path = Path(VOICE_SAMPLE_PATH)
    if voice_path.exists():
        print(f"[XTTS] Using reference voice: {voice_path}")
        tts_model.tts_to_file(
            text=text,
            file_path=wav_buffer,
            speaker_wav=str(voice_path),
            language="en",
        )
    else:
        print("[XTTS] No reference voice found, using default voice.")
        print(f"[XTTS] To use voice cloning, place a .wav file at: {VOICE_SAMPLE_PATH}")
        tts_model.tts_to_file(
            text=text,
            file_path=wav_buffer,
            language="en",
        )

    wav_buffer.seek(0)
    return wav_buffer.read()


class SpeakHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/speak":
            self.send_error(404, "Not found")
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body)
            text = data.get("text", "")

            if not text:
                self.send_error(400, "Missing 'text' field")
                return

            print(f"[XTTS] Synthesizing: {text[:80]}{'...' if len(text) > 80 else ''}")

            audio_bytes = synthesize(text)

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio_bytes)))
            self.end_headers()
            self.wfile.write(audio_bytes)

            print(f"[XTTS] Done. {len(audio_bytes)} bytes sent.")

        except Exception as e:
            print(f"[XTTS] Error: {e}")
            self.send_error(500, str(e))

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "model": "xtts_v2"}).encode())
        else:
            self.send_error(404, "Not found")

    def log_message(self, format, *args):
        # Suppress default HTTP logging, we do our own
        pass


def main():
    print("=" * 50)
    print("  JARVIS XTTS-v2 Voice Server")
    print("=" * 50)

    if not load_model():
        print("[XTTS] Failed to load model. Exiting.")
        sys.exit(1)

    server = HTTPServer((HOST, PORT), SpeakHandler)
    print(f"[XTTS] Server running at http://{HOST}:{PORT}")
    print("[XTTS] Endpoint: POST /speak  (body: {\"text\": \"...\"})")
    print("[XTTS] Health:   GET  /health")
    print("[XTTS] Press Ctrl+C to stop.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[XTTS] Shutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
