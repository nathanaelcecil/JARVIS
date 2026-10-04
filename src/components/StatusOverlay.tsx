import { useState, useEffect } from "react";
import type { JarvisState } from "@/lib/jarvis-core";

interface StatusOverlayProps {
  state: JarvisState;
  clock: string;
}

const STATE_LABELS: Record<JarvisState, string> = {
  idle: "STANDBY",
  listening: "LISTENING",
  thinking: "PROCESSING",
  speaking: "BROADCASTING",
  burst: "DATA BURST",
  system: "SYSTEM",
};

const STATE_COLORS: Record<JarvisState, string> = {
  idle: "text-hud-dim",
  listening: "text-hud",
  thinking: "text-hud-bright",
  speaking: "text-hud",
  burst: "text-hud-bright",
  system: "text-hud",
};

export function StatusOverlay({ state, clock }: StatusOverlayProps) {
  // Compute load is time-dependent — only render after hydration to avoid SSR mismatch
  const [computeLoad, setComputeLoad] = useState<string | null>(null);

  useEffect(() => {
    setComputeLoad((42 + Math.sin(Date.now() / 3000) * 15).toFixed(1));
    const id = setInterval(() => {
      setComputeLoad((42 + Math.sin(Date.now() / 3000) * 15).toFixed(1));
    }, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="pointer-events-none absolute right-8 top-8 space-y-1 text-right md:right-11 md:top-11">
      <p className="hud-mono text-[9px] tracking-[0.3em] text-hud-dim">
        UTC {clock}
      </p>
      <p className="hud-mono text-[9px] tracking-[0.3em] text-hud-dim">
        COMPUTE LOAD {computeLoad ?? "--.-"}%
      </p>
      <p
        className={
          "hud-mono text-[9px] tracking-[0.3em] transition-colors duration-500 " +
          STATE_COLORS[state]
        }
      >
        STATE · {STATE_LABELS[state]}
      </p>
      {state === "thinking" && (
        <p className="hud-mono text-[8px] tracking-[0.2em] text-hud-dim animate-pulse">
          LOCAL MODEL PROCESSING
        </p>
      )}
      {state === "speaking" && (
        <p className="hud-mono text-[8px] tracking-[0.2em] text-hud-dim animate-pulse">
          TTS RENDERING
        </p>
      )}
    </div>
  );
}
