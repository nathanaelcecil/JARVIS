import { Check, X } from "lucide-react";

interface PatternProposalProps {
  description: string;
  question: string;
  onAdopt: () => void;
  onDismiss: () => void;
}

export function PatternProposal({
  description,
  question,
  onAdopt,
  onDismiss,
}: PatternProposalProps) {
  return (
    <div className="border border-hud-edge/60 bg-hud-fill/10 px-4 py-3 max-w-[80%]">
      <p className="hud-mono text-[10px] tracking-wider text-hud-dim mb-2">
        JARVIS — PATTERN OBSERVATION
      </p>
      <p className="hud-mono text-[12px] text-hud leading-relaxed mb-1">
        {description}
      </p>
      <p className="hud-mono text-[11px] text-hud-bright italic mb-3">
        {question}
      </p>
      <div className="flex gap-2">
        <button
          onClick={onAdopt}
          className="hud-mono flex items-center gap-1 px-3 py-1 border border-hud-edge text-hud-bright text-[10px] tracking-wider hover:bg-hud-fill transition-colors"
        >
          <Check size={12} />
          ADOPT
        </button>
        <button
          onClick={onDismiss}
          className="hud-mono flex items-center gap-1 px-3 py-1 border border-hud-line text-hud-dim text-[10px] tracking-wider hover:text-hud hover:border-hud-edge transition-colors"
        >
          <X size={12} />
          DISMISS
        </button>
      </div>
    </div>
  );
}
