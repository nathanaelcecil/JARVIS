import {
  useLayoutEffect,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  attachments?: { kind: string; name: string }[] | undefined;
}

interface MessageListProps {
  messages: ChatMessage[];
  isThinking?: boolean;
  onEditSubmit?: (id: string, newText: string) => void;
}

export interface MessageListHandle {
  scrollToBottom: () => void;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(
  function MessageList({ messages, isThinking, onEditSubmit }, ref) {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draft, setDraft] = useState("");

    const scrollToBottom = () => {
      // Scroll the nearest scrollable parent (the messages container in index.tsx)
      const el = scrollContainerRef.current;
      if (!el) return;
      requestAnimationFrame(() => {
        // Walk up to find the overflow-y-auto container
        let parent: HTMLElement | null = el.parentElement;
        while (parent) {
          const style = window.getComputedStyle(parent);
          if (style.overflowY === "auto" || style.overflowY === "scroll") {
            parent.scrollTop = parent.scrollHeight;
            return;
          }
          parent = parent.parentElement;
        }
        // Fallback: scroll the element itself
        el.scrollTop = el.scrollHeight;
      });
    };

    useImperativeHandle(ref, () => ({ scrollToBottom }));

    useLayoutEffect(() => {
      scrollToBottom();
    }, [messages, isThinking]);

    const startEdit = (id: string, content: string) => {
      setEditingId(id);
      setDraft(content);
    };

    const submitEdit = () => {
      if (!editingId) return;
      const trimmed = draft.trim();
      const original = messages.find((m) => m.id === editingId);
      if (!trimmed || !original || trimmed === original.content) return;
      onEditSubmit?.(editingId, trimmed);
      setEditingId(null);
      setDraft("");
    };

    return (
      <div
        ref={scrollContainerRef}
        className="flex flex-col gap-3 px-1 py-2"
      >
        {messages.map((msg) => {
          const isEditing = msg.id === editingId;
          const canEdit =
            msg.role === "user" && !!onEditSubmit && !isThinking;

          return (
            <div
              key={msg.id}
              className={
                "flex " +
                (msg.role === "user" ? "justify-end group" : "justify-start")
              }
            >
              <div
                className={
                  "max-w-[80%] px-3 py-2 text-[12px] hud-mono leading-relaxed border " +
                  (msg.role === "user"
                    ? "border-amber-500/15 text-hud bg-transparent"
                    : "border-amber-500/10 text-hud-bright bg-transparent")
                }
              >
                {isEditing ? (
                  <div className="w-full min-w-[260px]">
                    <textarea
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          submitEdit();
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      rows={4}
                      className="hud-mono w-full bg-transparent text-hud text-[12px] resize-none focus:outline-none border border-hud-line px-2 py-1"
                    />
                    <div className="flex gap-2 mt-1 justify-end">
                      <button
                        onClick={() => setEditingId(null)}
                        className="hud-mono text-[9px] text-hud-dim hover:text-hud tracking-wider"
                      >
                        ESC
                      </button>
                      <button
                        onClick={submitEdit}
                        disabled={!draft.trim()}
                        className="hud-mono text-[9px] border border-hud-line px-2 py-0.5 text-hud-bright hover:border-hud-edge disabled:opacity-40 tracking-wider"
                        title="Re-run this prompt (drops the old reply branch)"
                      >
                        RE-RUN ⏎
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1">
                        {msg.attachments.map((a, i) => (
                          <span
                            key={i}
                            className="hud-mono text-[9px] text-hud-dim border border-hud-line px-1"
                          >
                            {a.kind === "image"
                              ? "🖼"
                              : a.kind === "video"
                                ? "🎬"
                                : "📄"}{" "}
                            {a.name}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                    <div className="flex items-center justify-between mt-1">
                      <p className="text-[9px] text-hud-dim tracking-wider">
                        {new Date(msg.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                      {canEdit && (
                        <button
                          onClick={() => startEdit(msg.id, msg.content)}
                          className="hud-mono text-[9px] text-hud-dim hover:text-hud opacity-0 group-hover:opacity-100 transition-opacity tracking-wider"
                          title="Edit this prompt and re-run it"
                        >
                          ✎ EDIT
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}

        {isThinking && (
          <div className="flex justify-start">
            <div className="px-3 py-2 border border-amber-500/10 bg-transparent">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-hud-dim rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 bg-hud-dim rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 bg-hud-dim rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    );
  }
);
