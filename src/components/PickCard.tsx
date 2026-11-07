import { useState } from "react";

interface PickCardProps {
  prompt: string;
  options: string[];
  onPick: (choice: string) => void;
  onDismiss: () => void;
}

/**
 * The model asked a question with a fixed set of answers. The turn is paused
 * server-side until one of these is chosen, so the card must always resolve:
 * picking sends the choice, dismissing cancels the pick.
 */
export function PickCard({ prompt, options, onPick, onDismiss }: PickCardProps) {
  const [answered, setAnswered] = useState<string | null>(null);

  const choose = (choice: string) => {
    if (answered !== null) return;
    setAnswered(choice);
    onPick(choice);
  };

  const dismiss = () => {
    if (answered !== null) return;
    setAnswered("");
    onDismiss();
  };

  return (
    <div
      data-testid="pick-card"
      className="border border-hud-edge/60 bg-hud-fill/10 px-4 py-3 max-w-[80%]"
    >
      <p className="hud-mono text-[10px] tracking-wider text-hud-dim mb-2">JARVIS — YOUR CALL</p>
      <p className="hud-mono text-[12px] text-hud leading-relaxed mb-3">{prompt}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option}
            onClick={() => choose(option)}
            disabled={answered !== null}
            className="hud-mono px-3 py-1 border border-hud-edge text-hud-bright text-[10px] tracking-wider hover:bg-hud-fill transition-colors disabled:opacity-40"
          >
            {option}
          </button>
        ))}
        <button
          onClick={dismiss}
          disabled={answered !== null}
          className="hud-mono px-3 py-1 border border-hud-line text-hud-dim text-[10px] tracking-wider hover:text-hud hover:border-hud-edge transition-colors disabled:opacity-40"
        >
          NEVER MIND
        </button>
      </div>
      {answered !== null && (
        <p className="hud-mono text-[9px] text-hud-dim mt-2">
          {answered === "" ? "dismissed" : `chosen: ${answered}`}
        </p>
      )}
    </div>
  );
}
