import { useState, useRef, useCallback, useEffect } from "react";
import {
  Send,
  Mic,
  MicOff,
  Camera,
  CameraOff,
  Paperclip,
  Square,
  X,
  FileText,
  Image as ImageIcon,
  Film,
} from "lucide-react";
import { downscaleImage, readTextFile, sampleVideoFrames } from "../lib/media";

/** A processed attachment ready to send with the next message. */
export type Attachment =
  | { kind: "image"; name: string; dataUrl: string }
  | { kind: "video"; name: string; dataUrls: string[]; timestamps: number[] }
  | {
      kind: "text";
      name: string;
      content: string;
      truncated: boolean;
      totalChars: number;
    };

interface ChatInputProps {
  onSend: (message: string, attachments: Attachment[]) => void;
  disabled?: boolean;
  processing?: boolean;
  onStop?: () => void;
  onMicToggle?: (active: boolean) => void;
  onCameraToggle?: (active: boolean) => void;
  micActive?: boolean;
  cameraActive?: boolean;
}

export function ChatInput({
  onSend,
  disabled,
  processing,
  onStop,
  onMicToggle,
  onCameraToggle,
  micActive,
  cameraActive,
}: ChatInputProps) {
  const [text, setText] = useState("");
  const [micError, setMicError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const micErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const vadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const abortTranscribeRef = useRef(false);
  // Synchronous re-entry lock: React state (isListening/isTranscribing)
  // updates a render tick late, so a fast second click during openMic()'s
  // ~300ms permission/device window could start a SECOND parallel recorder
  // — both VADs would then transcribe and send the same speech twice.
  // A ref flips instantly, closing the race.
  const micBusyRef = useRef(false);

  const showMicError = useCallback((errorMsg: string) => {
    if (micErrorTimer.current) clearTimeout(micErrorTimer.current);
    setMicError(errorMsg);
    micErrorTimer.current = setTimeout(() => setMicError(null), 5000);
  }, []);

  const cleanupMic = useCallback(() => {
    if (vadTimerRef.current) {
      clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    recorderRef.current = null;
    setIsListening(false);
    onMicToggle?.(false);
  }, [onMicToggle]);

  useEffect(() => {
    return () => {
      if (micErrorTimer.current) clearTimeout(micErrorTimer.current);
      if (vadTimerRef.current) clearInterval(vadTimerRef.current);
      if (audioCtxRef.current) void audioCtxRef.current.close().catch(() => {});
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ── Attachments ─────────────────────────────────────────────
  const addAttachment = useCallback((a: Attachment) => {
    setAttachments((prev) => [...prev, a]);
  }, []);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      for (const file of Array.from(files)) {
        try {
          if (file.type.startsWith("image/")) {
            const dataUrl = await downscaleImage(file);
            addAttachment({ kind: "image", name: file.name, dataUrl });
          } else if (file.type.startsWith("video/")) {
            const frames = await sampleVideoFrames(file);
            if (frames.length === 0) throw new Error("no frames extracted");
            addAttachment({
              kind: "video",
              name: file.name,
              dataUrls: frames.map((f) => f.dataUrl),
              timestamps: frames.map((f) => f.timeSeconds),
            });
          } else {
            const { text, truncated, totalChars } = await readTextFile(file);
            addAttachment({ kind: "text", name: file.name, content: text, truncated, totalChars });
          }
        } catch (err) {
          setAttachError(
            `${file.name}: ${err instanceof Error ? err.message : "could not process"}`,
          );
          setTimeout(() => setAttachError(null), 5000);
        }
      }
    },
    [addAttachment],
  );

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // ── Send (shared by button, Enter, and voice) ───────────────
  const doSend = useCallback(
    (message: string) => {
      const trimmed = message.trim();
      if (disabled) return;
      if (!trimmed && attachments.length === 0) return;
      onSend(trimmed, attachments);
      setText("");
      setAttachments([]);
      inputRef.current?.focus();
    },
    [attachments, disabled, onSend],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend(text);
      }
      if (e.key === "Escape" && isListening) {
        // Escape aborts an in-progress recording
        if (vadTimerRef.current) {
          clearInterval(vadTimerRef.current);
          vadTimerRef.current = null;
        }
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          abortTranscribeRef.current = true;
          try {
            recorderRef.current.stop();
          } catch {
            /* already stopped */
          }
        } else {
          cleanupMic();
        }
      }
    },
    [doSend, text, isListening, cleanupMic],
  );

  // ── Voice input: local recording → local whisper ────────────
  // Deliberately NOT the Web Speech API: Chromium routes that audio to
  // Google's network speech service (fails with "Mic: network error"),
  // and plain getUserMedia grabs the OS default input — which on this
  // Mac is often the iPhone (Continuity/Handoff), not the MacBook mic.

  /** Pick the MacBook's own microphone; never an iPhone input. */
  const pickMicDeviceId = useCallback(async (): Promise<string | null> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput");
      const saved = localStorage.getItem("jarvis_mic_device");
      if (saved && inputs.some((d) => d.deviceId === saved)) return saved;
      // Labels are only visible after a permission grant — filter empties.
      const usable = inputs.filter((d) => d.label && !/iPhone/i.test(d.label));
      const builtIn = usable.find((d) =>
        /MacBook|Built-in|Internal/i.test(d.label),
      );
      return (builtIn ?? usable[0] ?? inputs[0])?.deviceId ?? null;
    } catch {
      return null;
    }
  }, []);

  /** Open a mic stream pinned to the chosen physical device. */
  const openMic = useCallback(async (): Promise<MediaStream> => {
    // First pass: request permission (device labels stay hidden until granted)
    let stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Second pass: switch from the OS default (possibly the iPhone) to the
    // chosen device, with noise/echo processing on.
    const deviceId = await pickMicDeviceId();
    const currentId = stream.getAudioTracks()[0]?.getSettings().deviceId;
    if (deviceId && currentId && deviceId !== currentId) {
      stream.getTracks().forEach((t) => t.stop());
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: deviceId },
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        localStorage.setItem("jarvis_mic_device", deviceId);
      } catch {
        // Overconstrained (device vanished) — fall back to whatever we get
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    }
    streamRef.current = stream;
    return stream;
  }, [pickMicDeviceId]);

  /** Send the recorded blob to the local whisper endpoint and deliver it. */
  const transcribeBlob = useCallback(
    async (blob: Blob) => {
      setIsTranscribing(true);
      const sttStart = performance.now();
      try {
        const audioBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
          };
          reader.onerror = () => reject(new Error("could not read recording"));
          reader.readAsDataURL(blob);
        });

        const res = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audioBase64,
            mimeType: blob.type || "audio/webm",
          }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `transcription failed (${res.status})`);
        }
        const { text } = (await res.json()) as { text?: string };
        const transcript = (text ?? "").trim();
        // Whisper hallucinates parentheticals ("(wind howling)", "(music)")
        // on non-speech noise — never send those as messages (a junk send
        // would also cut JARVIS's running reply).
        const speech = transcript.replace(/\(.*?\)/g, "").trim();
        console.log(
          `[Mic] STT_complete in ${Math.round(performance.now() - sttStart)}ms:`,
          transcript,
        );
        if (!speech) {
          showMicError("Mic: didn't catch that — try again");
          return;
        }
        setText(transcript);
        doSend(transcript);
      } catch (err) {
        console.error("[Mic] transcribe failed:", err);
        showMicError(
          `Mic: ${err instanceof Error ? err.message : "transcription failed"}`,
        );
      } finally {
        setIsTranscribing(false);
        micBusyRef.current = false; // cycle complete — mic may start again
      }
    },
    [doSend, showMicError],
  );

  const toggleMic = useCallback(async () => {
    // ── Stop (manual) ──
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      console.log("[Mic] Stopping manually");
      if (vadTimerRef.current) {
        clearInterval(vadTimerRef.current);
        vadTimerRef.current = null;
      }
      try {
        recorderRef.current.stop();
      } catch {
        /* already stopped */
      }
      return;
    }
    if (micBusyRef.current || isTranscribing || micActive || isListening) return;
    micBusyRef.current = true;

    const failStart = (msg: string) => {
      showMicError(msg);
      micBusyRef.current = false;
      setIsListening(false);
      onMicToggle?.(false);
    };

    // ── Start ──
    if (typeof MediaRecorder === "undefined") {
      failStart("Mic: recording not supported in this browser");
      return;
    }

    // Immediate visual feedback while permission/device selection resolves
    setIsListening(true);
    onMicToggle?.(true);

    let stream: MediaStream;
    try {
      stream = await openMic();
      console.log("[Mic] Opened:", stream.getAudioTracks()[0]?.label || "(default)");
    } catch (err) {
      console.error("[Mic] getUserMedia failed:", err);
      const msg =
        err instanceof DOMException
          ? err.name === "NotAllowedError"
            ? "Mic: permission denied — allow mic in browser settings"
            : err.name === "NotFoundError"
              ? "Mic: no microphone found"
              : `Mic: ${err.message}`
          : "Mic: could not access microphone";
      failStart(msg);
      return;
    }

    let recorder: MediaRecorder;
    try {
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : undefined;
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (err) {
      console.error("[Mic] MediaRecorder failed:", err);
      cleanupMic();
      failStart(
        `Mic: ${err instanceof Error ? err.message : "could not start recording"}`,
      );
      return;
    }

    chunksRef.current = [];
    abortTranscribeRef.current = false;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onerror = () => {
      showMicError("Mic: recording error");
    };
    recorder.onstop = () => {
      const abort = abortTranscribeRef.current;
      abortTranscribeRef.current = false;
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || "audio/webm",
      });
      chunksRef.current = [];
      if (!abort && blob.size > 0) {
        void transcribeBlob(blob); // releases micBusyRef when transcription ends
      } else {
        micBusyRef.current = false; // nothing to transcribe — free the mic
      }
      cleanupMic();
    };
    recorderRef.current = recorder;

    // ── Voice-activity detection (client-side, mic-level only) ──
    // Auto-stop after 1.6s of silence once speech was heard; give up after
    // 10s of pure silence; hard cap at 60s. This keeps the original
    // hands-free "speak → it sends" flow without Google's network VAD.
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const startedAt = Date.now();
      let lastVoice = 0;
      vadTimerRef.current = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i]! - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();
        if (rms > 0.03) lastVoice = now;

        const stopRecording = () => {
          if (vadTimerRef.current) {
            clearInterval(vadTimerRef.current);
            vadTimerRef.current = null;
          }
          if (recorder.state !== "inactive") recorder.stop();
        };

        if (now - startedAt > 60_000) {
          console.log("[Mic] Max recording length reached");
          stopRecording();
        } else if (lastVoice && now - lastVoice > 1600 && now - startedAt > 1200) {
          console.log("[Mic] Silence detected — stopping");
          stopRecording();
        } else if (!lastVoice && now - startedAt > 10_000) {
          console.log("[Mic] No speech for 10s");
          abortTranscribeRef.current = true;
          stopRecording();
          showMicError("Mic: no speech detected — try speaking louder or check mic");
        }
      }, 100);
    } catch {
      /* VAD is optional — manual stop still works */
    }

    recorder.start();
    setIsListening(true);
    onMicToggle?.(true);
    console.log("[Mic] Recording started (local whisper STT, no network)");
  }, [
    micActive,
    isListening,
    isTranscribing,
    onMicToggle,
    showMicError,
    cleanupMic,
    openMic,
    transcribeBlob,
  ]);

  const placeholder = micError
    ? micError
    : isTranscribing
      ? "Transcribing locally..."
      : isListening
        ? "Listening... speak now (Esc to cancel)"
        : disabled
          ? "Halted by kill switch"
          : processing
            ? "JARVIS is responding — type to cut in, or ⏹ to stop"
            : "Speak, sir.";

  return (
    <div className="w-full">
      {/* Attachment chips + errors */}
      {(attachments.length > 0 || attachError) && (
        <div className="flex flex-wrap gap-1 mb-1">
          {attachments.map((a, i) => (
            <span
              key={`${a.name}-${i}`}
              className="hud-mono text-[9px] border border-hud-line text-hud-dim px-1.5 py-0.5 flex items-center gap-1"
            >
              {a.kind === "image" ? (
                <ImageIcon size={9} />
              ) : a.kind === "video" ? (
                <Film size={9} />
              ) : (
                <FileText size={9} />
              )}
              {a.name}
              {a.kind === "video" && ` (${a.dataUrls.length} frames)`}
              {a.kind === "text" && a.truncated && " (truncated)"}
              <button
                onClick={() => removeAttachment(i)}
                className="hover:text-hud"
                title="Remove attachment"
              >
                <X size={9} />
              </button>
            </span>
          ))}
          {attachError && (
            <span className="hud-mono text-[9px] text-red-400">{attachError}</span>
          )}
        </div>
      )}

      <div className="flex items-end gap-2 w-full">
        {/* Mic button — show Mic (on) when listening, MicOff (off) when idle */}
        <button
          onClick={toggleMic}
          disabled={disabled}
          className={
            "flex-shrink-0 w-10 h-10 flex items-center justify-center border transition-colors " +
            (isListening
              ? "border-hud-edge bg-hud-fill text-hud-bright animate-pulse"
              : "border-hud-line text-hud-dim hover:text-hud hover:border-hud-edge")
          }
          title={isListening ? "Stop listening" : "Start voice input"}
        >
          {isListening ? <Mic size={16} /> : <MicOff size={16} />}
        </button>

        {/* Attach button — images, video, markdown/text files */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="flex-shrink-0 w-10 h-10 flex items-center justify-center border border-hud-line text-hud-dim hover:text-hud hover:border-hud-edge transition-colors"
          title="Attach photo, video, or markdown file"
        >
          <Paperclip size={15} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,.md,.markdown,.txt"
          className="hidden"
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = ""; // allow re-selecting the same file
          }}
        />

        {/* Text input — stays enabled while JARVIS replies: typing + send
            cuts the running reply and JARVIS continues from there */}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          rows={1}
          className="hud-mono flex-1 bg-transparent border border-hud-line text-hud placeholder:text-hud-dim px-3 py-2 text-[12px] tracking-wide resize-none focus:outline-none focus:border-hud-edge transition-colors max-h-32 overflow-y-auto"
          style={{ minHeight: "40px" }}
        />

        {/* Stop button — visible only while a reply is running */}
        {processing && onStop && (
          <button
            onClick={onStop}
            className="flex-shrink-0 w-10 h-10 flex items-center justify-center border border-red-500/60 text-red-400 hover:bg-red-900/20 transition-colors animate-pulse"
            title="Cut the current reply (partial reply is kept)"
          >
            <Square size={14} />
          </button>
        )}

        {/* Send button */}
        <button
          onClick={() => doSend(text)}
          disabled={disabled || (!text.trim() && attachments.length === 0)}
          className={
            "flex-shrink-0 w-10 h-10 flex items-center justify-center border transition-colors " +
            ((text.trim() || attachments.length > 0) && !disabled
              ? "border-hud-edge text-hud-bright hover:bg-hud-fill"
              : "border-hud-line text-hud-dim cursor-not-allowed")
          }
          title="Send message"
        >
          <Send size={16} />
        </button>

        {/* Camera toggle */}
        <button
          onClick={() => onCameraToggle?.(!cameraActive)}
          disabled={disabled}
          className={
            "flex-shrink-0 w-10 h-10 flex items-center justify-center border transition-colors " +
            (cameraActive
              ? "border-hud-edge text-hud-bright hover:bg-hud-fill"
              : "border-hud-line text-hud-dim hover:text-hud hover:border-hud-edge")
          }
          title={cameraActive ? "Close camera" : "Open camera"}
        >
          {cameraActive ? <CameraOff size={16} /> : <Camera size={16} />}
        </button>
      </div>
    </div>
  );
}
