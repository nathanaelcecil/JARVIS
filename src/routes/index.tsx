import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback, useRef } from "react";
import { JarvisCore } from "@/components/JarvisCore";
import type { JarvisState } from "@/lib/jarvis-core";
import { ChatInput } from "@/components/ChatInput";
import { MessageList, type ChatMessage, type MessageListHandle } from "@/components/MessageList";
import { PatternProposal } from "@/components/PatternProposal";
import { ConfirmAction } from "@/components/ConfirmAction";
import { StatusOverlay } from "@/components/StatusOverlay";
import { CameraPanel } from "@/components/CameraPanel";
import { killSwitch } from "@/functions/kill";
import { getTaskStatus } from "@/functions/tasks";
import { playResponseChunked, StreamingTTSManager, stopAudio } from "@/lib/audio-queue";
import type { Attachment } from "@/components/ChatInput";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "JARVIS — Intelligence Core Interface" },
      {
        name: "description",
        content: "A living computational intelligence core.",
      },
    ],
  }),
  component: Index,
});

/** Parse SSE lines from a text buffer, return [events, remaining buffer] */
function parseSSE(buffer: string): { events: Array<{ event: string; data: string }>; rest: string } {
  const events: Array<{ event: string; data: string }> = [];
  const lines = buffer.split("\n");
  let rest: string = "";
  let currentEvent = "";
  let currentData = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    } else if (line === "" && currentEvent) {
      events.push({ event: currentEvent, data: currentData });
      currentEvent = "";
      currentData = "";
    } else if (line === "" && !currentEvent && !currentData) {
      // Empty line, skip
    } else if (i === lines.length - 1 && line !== "") {
      // Incomplete line at the end
      rest = line;
    }
  }

  // If we have an event with data but no trailing empty line, it's still complete
  if (currentEvent && currentData) {
    events.push({ event: currentEvent, data: currentData });
  }

  return { events, rest };
}

/** Detect stop/cancel commands */
function isStopCommand(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return (
    lower === "stop" ||
    lower === "cancel" ||
    lower === "halt" ||
    lower === "abort" ||
    lower === "never mind" ||
    lower === "nevermind" ||
    lower === "forget it"
  );
}

/** Detect status query commands */
function isStatusQuery(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return (
    lower.includes("what are you doing") ||
    lower.includes("what are we doing") ||
    lower.includes("what tasks") ||
    lower.includes("status update") ||
    lower.includes("how are things")
  );
}

function Index() {
  const [state, setState] = useState<JarvisState>("idle");
  const [clock, setClock] = useState("--:--:--");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | undefined>();
  const [pendingPattern, setPendingPattern] = useState<{
    description: string;
    question: string;
  } | null>(null);
  const [killActive, setKillActive] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ confirmId: string; tool: string; args: Record<string, unknown> } | null>(null);
  const [viewWidth, setViewWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  const [currentRoute, setCurrentRoute] = useState<string>("");
  const [currentTaskId, setCurrentTaskId] = useState<string>("");
  const messageListRef = useRef<MessageListHandle>(null);

  // Synchronous mirror of messages for callbacks that need a lookup now
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // DB created_at per user message id (from user_saved SSE events) — the
  // exact truncation point when a prompt is edited and re-run.
  const dbCreatedRef = useRef<Map<string, string>>(new Map());

  // Abort flag for chunked audio — set true when new message sent mid-playback
  const audioAbortRef = useRef(false);

  // Track active fetch controller for streaming
  const streamAbortRef = useRef<AbortController | null>(null);

  // Session ID — stable across page loads (localStorage) so chat history and
  // proactive messages (reminders/check-ins) stay in the same conversation
  const sessionIdRef = useRef(
    (() => {
      if (typeof window === "undefined")
        return `jarvis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let sid = localStorage.getItem("jarvis-session-id");
      if (!sid) {
        sid = `jarvis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        localStorage.setItem("jarvis-session-id", sid);
      }
      return sid;
    })()
  );

  // Mirror processing state for the proactive poll (avoids re-creating it)
  const processingRef = useRef(false);
  useEffect(() => {
    processingRef.current = isProcessing;
  }, [isProcessing]);

  // ── Proactive poll: fetch initiative messages (reminders, daily check-in,
  //    task-completion reports) → append to chat + speak them ──
  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      if (disposed || processingRef.current) return;
      try {
        const res = await fetch("/api/proactive");
        if (!res.ok) return;
        const data = (await res.json()) as {
          messages?: Array<{
            id: string;
            content: string;
            kind: string;
            created_at: string;
          }>;
        };
        for (const m of data.messages ?? []) {
          if (disposed) return;
          setMessages((prev) => [
            ...prev,
            {
              id: `proactive-${m.id}`,
              role: "assistant",
              content: m.content,
              timestamp: m.created_at,
            },
          ]);
          // Voice delivery — aborts if the user starts a new message
          playResponseChunked(
            m.content,
            (speaking) => setState(speaking ? "speaking" : "idle"),
            () => audioAbortRef.current || disposed
          ).catch(() => {});
        }
      } catch {
        // Dev server not ready yet — retry next tick
      }
    };
    poll().catch(() => {});
    const interval = setInterval(() => poll().catch(() => {}), 10_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, []);

  // ── Return greeting: brief welcome-back when the user returns ──
  useEffect(() => {
    let returning = false;
    try {
      returning = localStorage.getItem("jarvis-seen") === "1";
      localStorage.setItem("jarvis-seen", "1");
    } catch {
      // storage unavailable
    }
    if (!returning) return;
    const t = setTimeout(() => {
      const greeting =
        "Welcome back, sir. All systems online — what are we working on today?";
      setMessages((prev) => [
        ...prev,
        {
          id: `proactive-greeting-${Date.now()}`,
          role: "assistant",
          content: greeting,
          timestamp: new Date().toISOString(),
        },
      ]);
      playResponseChunked(
        greeting,
        (speaking) => setState(speaking ? "speaking" : "idle"),
        () => audioAbortRef.current
      ).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, []);

  // Handle confirmation dialog
  const handleConfirm = useCallback(async (approved: boolean) => {
    if (!pendingConfirm) return;
    try {
      await fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmId: pendingConfirm.confirmId, approved }),
      });
    } catch (err) {
      console.error("[Confirm] Failed to send decision:", err);
    }
    setPendingConfirm(null);
  }, [pendingConfirm]);

  // Track viewport width for orb offset
  useEffect(() => {
    const onResize = () => setViewWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Clock tick
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(d.toISOString().slice(11, 19));
    };
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, []);

  // Update state based on UI activity
  useEffect(() => {
    if (micActive) {
      setState("listening");
    } else if (isProcessing) {
      setState("thinking");
    } else if (state === "listening" || state === "thinking") {
      setState("idle");
    }
  }, [micActive, isProcessing]);

  const handleSend = useCallback(
    async (
      message: string,
      attachments: Attachment[] = [],
      edit?: { msgId: string; truncateAfter: string },
    ) => {
      // ── Stop command: cancel the running task, don't send to LLM ──
      if (!edit && isStopCommand(message) && currentTaskId) {
        setMessages((prev) => [
          ...prev,
          {
            id: `user-${Date.now()}`,
            role: "user",
            content: message,
            timestamp: new Date().toISOString(),
          },
          {
            id: `system-${Date.now()}`,
            role: "system",
            content: `Task cancelled.`,
            timestamp: new Date().toISOString(),
          },
        ]);

        // Cancel the server-side task
        killSwitch({ data: { action: "cancel", taskId: currentTaskId } }).catch(() => {});

        // Abort the fetch stream + any audio instantly
        streamAbortRef.current?.abort();
        streamAbortRef.current = null;
        stopAudio();
        setCurrentTaskId("");
        setCurrentRoute("");
        setIsProcessing(false);
        setState("idle");
        return;
      }

      // ── Status query: ask the server what's running ──
      if (!edit && isStatusQuery(message)) {
        setMessages((prev) => [
          ...prev,
          {
            id: `user-${Date.now()}`,
            role: "user",
            content: message,
            timestamp: new Date().toISOString(),
          },
        ]);

        try {
          const status = await getTaskStatus();
          const statusMsg: ChatMessage = {
            id: `system-${Date.now()}`,
            role: "assistant",
            content: status.count > 0
              ? `Current tasks:\n${status.tasks.map((t) => `• ${t.status}: "${t.message}" (${t.route} route, ${Math.round(t.elapsedMs / 1000)}s)`).join("\n")}`
              : "No active tasks at the moment, sir.",
            timestamp: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, statusMsg]);
        } catch {
          setMessages((prev) => [
            ...prev,
            {
              id: `system-${Date.now()}`,
              role: "system",
              content: "Unable to retrieve task status.",
              timestamp: new Date().toISOString(),
            },
          ]);
        }
        return;
      }

      // ── Normal message: stream via /api/stream ──

      // Immediate interruption: halt audio + abort any in-progress stream.
      // When a reply was actually running, give the server a beat to persist
      // the partial reply so this turn can continue from it.
      const wasRunning = streamAbortRef.current !== null;
      audioAbortRef.current = true;
      stopAudio();
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      await new Promise((r) => setTimeout(r, wasRunning ? 250 : 50));
      audioAbortRef.current = false;

      const imageToSend = capturedImage;
      setCapturedImage(undefined);

      // ── Assemble attachments: images → images[], text → fenced block ──
      const imageList: string[] = [];
      if (imageToSend) imageList.push(imageToSend);
      let messageText = message;
      const attachMeta: NonNullable<ChatMessage["attachments"]> = [];
      for (const a of attachments) {
        attachMeta.push({ kind: a.kind, name: a.name });
        if (a.kind === "image") {
          imageList.push(a.dataUrl);
        } else if (a.kind === "video") {
          messageText += `\n\n[Attached video "${a.name}" — frames sampled at: ${a.timestamps
            .map((t) => `t=${t.toFixed(1)}s`)
            .join(", ")} (in order)]`;
        } else {
          const kb = Math.round(a.totalChars / 102.4) / 10;
          messageText += `\n\n--- Attached file: ${a.name} (${kb} KB${
            a.truncated
              ? `, TRUNCATED to first ~12k of ${a.totalChars} chars`
              : ""
          }) ---\n\`\`\`\n${a.content}\n\`\`\``;
        }
      }
      const fullMessage = messageText.trim();

      // ── User message: fresh, or in-place for an edit (drops the old
      //    reply branch) ──
      let userMsgId: string;
      if (edit) {
        userMsgId = edit.msgId;
        dbCreatedRef.current.delete(userMsgId);
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === edit.msgId);
          if (idx < 0) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx]!,
            content: fullMessage,
            attachments: attachMeta.length > 0 ? attachMeta : undefined,
          };
          return updated.slice(0, idx + 1);
        });
      } else {
        userMsgId = `user-${Date.now()}`;
        setMessages((prev) => [
          ...prev,
          {
            id: userMsgId,
            role: "user" as const,
            content: fullMessage,
            timestamp: new Date().toISOString(),
            attachments: attachMeta.length > 0 ? attachMeta : undefined,
          },
        ]);
      }

      // Add a streaming assistant message placeholder
      const assistantMsgId = `assistant-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: assistantMsgId,
          role: "assistant",
          content: "",
          timestamp: new Date().toISOString(),
        },
      ]);

      setIsProcessing(true);

      // ── Latency instrumentation: REQUEST → FIRST AUDIBLE AUDIO ──
      // (STT completes inside ChatInput before onSend — this is t=0 for
      // the request→audio KPI.)
      const requestStart = Date.now();
      let firstAudioLogged = false;
      const markPerf = (stage: string) => {
        const ms = Date.now() - requestStart;
        if (stage === "audio_playback_start" && !firstAudioLogged) {
          firstAudioLogged = true;
          console.log(
            `%c[Perf] REQUEST→FIRST AUDIBLE AUDIO: ${ms}ms`,
            "color:#22c55e;font-weight:bold"
          );
        } else {
          console.log(`[Perf] ${stage}: ${ms}ms`);
        }
      };
      markPerf("request_start");

      let fullText = "";
      let ttsFinalized = false;
      const streamingTTS = new StreamingTTSManager(
        (speaking) => setState(speaking ? "speaking" : "idle"),
        () => audioAbortRef.current,
        markPerf,
      );
      let streamedRoute = "";

      try {
        const controller = new AbortController();
        streamAbortRef.current = controller;

        const response = await fetch("/api/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: fullMessage,
            sessionId: sessionIdRef.current,
            images: imageList.length > 0 ? imageList : undefined,
            clientMsgId: userMsgId,
            truncateAfter: edit?.truncateAfter,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Stream error: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseSSE(buffer);
          buffer = rest;

          for (const { event, data } of events) {
            try {
              const parsed = JSON.parse(data);

              switch (event) {
                case "ack":
                  // FAST ack — show immediately in the streaming message
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsgId
                        ? { ...m, content: parsed.text || "One moment, sir." }
                        : m
                    )
                  );
                  break;

                case "perf":
                  // Server-side milestone (db_start, first_token, ...)
                  markPerf(parsed.stage || "server_event");
                  break;

                case "user_saved":
                  // Exact DB timestamp for the user message — used as the
                  // truncation point if this prompt is later edited.
                  if (parsed.clientMsgId && parsed.createdAt) {
                    dbCreatedRef.current.set(parsed.clientMsgId, parsed.createdAt);
                  }
                  break;

                case "token":
                  // Append token to the streaming message + feed to streaming TTS
                  fullText += parsed.text;
                  streamingTTS.pushToken(parsed.text);
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsgId ? { ...m, content: fullText } : m
                    )
                  );
                  break;

                case "tool_start":
                  // Show tool execution status in the streaming message
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsgId
                        ? { ...m, content: fullText + `\n\n⚙ Executing ${parsed.tool}...` }
                        : m
                    )
                  );
                  break;

                                case "confirm_request":
                  // Show confirmation prompt
                  setPendingConfirm({
                    confirmId: parsed.confirmId || "",
                    tool: parsed.tool,
                    args: parsed.args || {},
                  });
                  break;

                case "tool_result":
                  // Show tool result in the streaming message
                  const toolResultStr = parsed.result?.error
                    ? `\n⚠ ${parsed.tool}: ${parsed.result.error}`
                    : parsed.result?.success === false
                      ? `\n⚠ ${parsed.tool}: ${parsed.result.error || "Failed"}`
                      : `\n✓ ${parsed.tool} completed`;
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsgId
                        ? { ...m, content: fullText + toolResultStr }
                        : m
                    )
                  );
                  break;

                case "done":
                  streamedRoute = parsed.route || "";
                  setCurrentRoute(streamedRoute);
                  setCurrentTaskId(parsed.taskId || "");

                  // Final-flush audit: adopt the server's full text if any
                  // tokens were missed client-side (dropped chunk / reconnect)
                  if (
                    typeof parsed.text === "string" &&
                    parsed.text.length > fullText.length
                  ) {
                    fullText = parsed.text;
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === assistantMsgId
                          ? { ...m, content: fullText }
                          : m
                      )
                    );
                  }

                  // Finalize streaming TTS (flush remaining text)
                  if (fullText && parsed.status !== "CANCELLED") {
                    ttsFinalized = true;
                    streamingTTS
                      .finalize()
                      .then(() => markPerf("tts_complete"))
                      .catch((e) => console.warn("[TTS] Finalize error:", e));
                  }

                  if (parsed.status === "CANCELLED") {
                    streamingTTS.cancel();
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === assistantMsgId
                          ? {
                              ...m,
                              content: fullText
                                ? fullText.trim() +
                                  "\n\n⏹ *(cut off — send your next prompt or say continue)*"
                                : "Task cancelled.",
                              role: "system" as const,
                            }
                          : m
                      )
                    );
                  }
                  break;

                case "error":
                  ttsFinalized = true; // don't flush partial text after an error
                  streamingTTS.cancel();
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsgId
                        ? { ...m, content: `Error: ${parsed.error}`, role: "system" as const }
                        : m
                    )
                  );
                  break;
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }

        // Safety net: the stream closed without a usable `done` event —
        // flush any remaining text to TTS so the reply isn't cut mid-sentence
        if (!ttsFinalized && fullText) {
          ttsFinalized = true;
          streamingTTS
            .finalize()
            .then(() => markPerf("tts_complete"))
            .catch((e) => console.warn("[TTS] Finalize error:", e));
        }

        // TTS is already streaming via StreamingTTSManager — just wait for audio to finish
        // The finalize() was already called in the 'done' event handler above.
        // If we get here, audio is still playing in the background — that's fine,
        // it will complete asynchronously. We don't block the UI on it.
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // Stream was cancelled — already handled
          ttsFinalized = true;
          console.log("[Stream] Fetch aborted (user cancelled or new message)");
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
                    role: "system" as const,
                  }
                : m
            )
          );
        }
      } finally {
        setIsProcessing(false);
        setState("idle");
        streamAbortRef.current = null;
      }
    },
    [capturedImage, currentTaskId]
  );

  // ⏹ Cut the running reply (server persists the partial for continuation)
  const handleStop = useCallback(() => {
    stopAudio();
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
  }, []);

  // ✎ Edit & re-run: truncate the branch after this message (server-side,
  //   at its exact DB timestamp) and resend the edited prompt.
  const handleEditSubmit = useCallback(
    (msgId: string, newText: string) => {
      const msg = messagesRef.current.find((m) => m.id === msgId);
      if (!msg || msg.role !== "user") return;
      const truncateAfter =
        dbCreatedRef.current.get(msgId) ??
        new Date(Date.parse(msg.timestamp) - 5_000).toISOString();
      void handleSend(newText, [], { msgId, truncateAfter });
    },
    [handleSend]
  );

  const handleAdoptPattern = useCallback(async () => {
    if (!pendingPattern) return;
    setPendingPattern(null);
  }, [pendingPattern]);

  const handleDismissPattern = useCallback(() => {
    setPendingPattern(null);
  }, []);

  const handleCaptureImage = useCallback((imageData: string) => {
    setCapturedImage(imageData);
  }, []);

  const handleKillSwitch = useCallback(async () => {
    // Also abort audio and stream
    audioAbortRef.current = true;
    stopAudio();
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;

    if (killActive) {
      await killSwitch({ data: { action: "reset" } });
      setKillActive(false);
    } else {
      await killSwitch({ data: { action: "activate" } });
      setKillActive(true);
      setIsProcessing(false);
      setState("idle");
      setCurrentTaskId("");
      setCurrentRoute("");
    }
  }, [killActive]);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-void text-hud">
      <JarvisCore state={state} offsetX={messages.length > 0 ? -viewWidth * 0.15 : 0} />

      {/* Thin frame */}
      <div className="pointer-events-none absolute inset-4 border border-hud-line md:inset-6" />
      <div className="pointer-events-none absolute left-4 top-4 h-px w-16 bg-hud-edge md:left-6 md:top-6" />
      <div className="pointer-events-none absolute bottom-4 right-4 h-px w-16 bg-hud-edge md:bottom-6 md:right-6" />

      {/* Header */}
      <header className="pointer-events-none absolute left-8 top-8 space-y-1 md:left-11 md:top-11">
        <h1 className="hud-title text-[13px] tracking-[0.62em] text-hud-bright">
          J A R V I S
        </h1>
        <p className="hud-mono text-[9px] tracking-[0.34em] text-hud-dim">
          INTELLIGENCE CORE / REV 9.4
        </p>
      </header>

      {/* Status overlay */}
      <StatusOverlay state={state} clock={clock} />

      {/* Kill switch */}
      <button
        onClick={handleKillSwitch}
        className={
          "absolute left-8 top-20 md:left-11 md:top-20 hud-mono text-[8px] tracking-[0.2em] border px-2 py-1 transition-colors " +
          (killActive
            ? "border-red-500/60 text-red-400 bg-red-900/20"
            : "border-hud-line text-hud-dim hover:text-hud hover:border-hud-edge")
        }
        title={killActive ? "Resume operations" : "Halt all operations"}
      >
        {killActive ? "■ KILLED" : "◻ KILL SWITCH"}
      </button>

      {/* Route indicator — shows which model class is active */}
      {currentRoute && isProcessing && (
        <div className="pointer-events-none absolute left-8 top-32 md:left-11 md:top-32">
          <p className="hud-mono text-[8px] tracking-[0.2em] text-amber-500/60">
            ROUTE: {currentRoute}
          </p>
        </div>
      )}

      {/* Bottom-left system status */}
      <div className="pointer-events-none absolute bottom-8 left-8 space-y-[3px] md:bottom-11 md:left-11">
        {[
          ["NUCLEUS", "STABLE"],
          ["ORBITAL LATTICE", "7 ARRAYS"],
          ["FILAMENT NET", "NOMINAL"],
          ["MEM SHARDS", "1.42E6"],
        ].map(([k, v]) => (
          <p
            key={k}
            className="hud-mono text-[9px] tracking-[0.26em] text-hud-dim"
          >
            <span className="inline-block w-[132px]">{k}</span>
            <span className="text-hud">{v}</span>
          </p>
        ))}
      </div>

      {/* Chat panel — bottom right */}
      <div className="absolute bottom-4 right-4 md:bottom-6 md:right-6 w-[min(500px,80vw)] max-h-[calc(100vh-4rem)] flex flex-col z-10">
        {/* Messages — scrollable, takes remaining space */}
        {messages.length > 0 && (
          <div className="flex-1 min-h-0 mb-2 overflow-y-auto bg-transparent backdrop-blur-sm border border-amber-500/10 rounded-sm p-2">
            <MessageList
              ref={messageListRef}
              messages={messages}
              isThinking={isProcessing}
              onEditSubmit={handleEditSubmit}
            />
          </div>
        )}

        {/* Captured image preview */}
        {capturedImage && (
          <div className="mb-2 flex items-center gap-2">
            <img
              src={capturedImage}
              alt="Captured frame"
              className="w-16 h-12 object-cover border border-hud-edge/40"
            />
            <button
              onClick={() => setCapturedImage(undefined)}
              className="hud-mono text-[9px] text-hud-dim hover:text-hud"
            >
              REMOVE
            </button>
          </div>
        )}

        {/* Pattern proposal */}
        {pendingConfirm && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
          <ConfirmAction
            tool={pendingConfirm.tool}
            args={pendingConfirm.args}
            onApprove={() => handleConfirm(true)}
            onDeny={() => handleConfirm(false)}
          />
        </div>
      )}

      {pendingPattern && (
          <div className="mb-2">
            <PatternProposal
              description={pendingPattern.description}
              question={pendingPattern.question}
              onAdopt={handleAdoptPattern}
              onDismiss={handleDismissPattern}
            />
          </div>
        )}

        {/* Input — always pinned at bottom */}
        <div className="flex-shrink-0 bg-transparent backdrop-blur-sm border border-amber-500/15 rounded-sm p-2">
          <ChatInput
            onSend={handleSend}
            disabled={killActive}
            processing={isProcessing}
            onStop={handleStop}
            micActive={micActive}
            cameraActive={cameraActive}
            onMicToggle={setMicActive}
            onCameraToggle={setCameraActive}
          />
        </div>
      </div>

      {/* Camera panel */}
      <CameraPanel
        active={cameraActive}
        onClose={() => setCameraActive(false)}
        onCapture={handleCaptureImage}
      />
    </main>
  );
}
