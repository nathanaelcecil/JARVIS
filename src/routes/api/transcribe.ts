/**
 * POST /api/transcribe — local speech-to-text (whisper.cpp, fully offline).
 *
 * Body: { audioBase64: string, mimeType?: string }
 * Resp: { text: string } | { error: string }
 *
 * The browser records mic audio (MediaRecorder → webm/opus) and posts it
 * here; ffmpeg converts to 16kHz mono WAV and whisper-cli transcribes it
 * locally on this machine. This replaces the Web Speech API, which routes
 * audio through Google's network speech service and failed with
 * "Mic: network error" whenever that service was unreachable.
 */

import { createFileRoute } from "@tanstack/react-router";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const WHISPER_BIN =
  process.env["WHISPER_BIN"] ?? "/opt/homebrew/bin/whisper-cli";
const WHISPER_MODEL =
  process.env["WHISPER_MODEL"] ??
  path.resolve(process.cwd(), "models/ggml-small.en.bin");
const STT_LANG = process.env["STT_LANG"] ?? "en";
const MAX_BASE64_CHARS = 30 * 1024 * 1024; // ≈22MB raw audio

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function run(
  cmd: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after 60s`));
    }, 60_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let audioBase64: string | undefined;
        let mimeType: string | undefined;
        try {
          const body = (await request.json()) as {
            audioBase64?: string;
            mimeType?: string;
          };
          audioBase64 = body.audioBase64;
          mimeType = body.mimeType;
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        if (!audioBase64 || audioBase64.length < 100) {
          return Response.json({ error: "Missing audio" }, { status: 400 });
        }
        if (audioBase64.length > MAX_BASE64_CHARS) {
          return Response.json({ error: "Audio too long" }, { status: 413 });
        }

        const ext = mimeType?.includes("ogg")
          ? "ogg"
          : mimeType?.includes("aiff") || mimeType?.includes("aif")
            ? "aiff"
            : mimeType?.includes("wav")
              ? "wav"
              : mimeType?.includes("mp4")
                ? "m4a"
                : "webm";

        const dir = await fs.mkdtemp(path.join(tmpdir(), "jarvis-stt-"));
        const inPath = path.join(dir, `in.${ext}`);
        const wavPath = path.join(dir, "in16.wav");

        try {
          await fs.writeFile(inPath, Buffer.from(audioBase64, "base64"));

          // Normalize to 16kHz mono WAV — what whisper.cpp expects.
          const ff = await run("ffmpeg", [
            "-y",
            "-i",
            inPath,
            "-ar",
            "16000",
            "-ac",
            "1",
            wavPath,
          ]);
          if (ff.code !== 0 || !(await exists(wavPath))) {
            console.error("[STT] ffmpeg failed:", ff.stderr.slice(-400));
            return Response.json(
              { error: "Audio conversion failed" },
              { status: 422 }
            );
          }

          const wp = await run(WHISPER_BIN, [
            "-m",
            WHISPER_MODEL,
            "-f",
            wavPath,
            "-l",
            STT_LANG,
            "-np",
            "-t",
            "8",
          ]);
          if (wp.code !== 0) {
            console.error("[STT] whisper failed:", wp.stderr.slice(-400));
            return Response.json(
              { error: "Transcription failed" },
              { status: 500 }
            );
          }

          // Lines look like: "[00:00:00.000 --> 00:00:02.480]   Hello, ..."
          const text = wp.stdout
            .split("\n")
            .map((line) => {
              const idx = line.lastIndexOf("]");
              return (idx >= 0 ? line.slice(idx + 1) : line).trim();
            })
            .filter(Boolean)
            .join(" ")
            .trim();

          console.log(`[STT] "${text.slice(0, 80)}"`);
          return Response.json({ text });
        } catch (err) {
          console.error("[STT] error:", err);
          return Response.json(
            { error: err instanceof Error ? err.message : "STT failed" },
            { status: 500 }
          );
        } finally {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      },
    },
  },
});
