import { Button } from "@web/components/shadcn/button";
import { FlashIcon } from "@web/components/ui/icons";

/**
 * The short replies an operator sends over and over, one tap each.
 *
 * WHAT KEEPS THESE LEGAL. `CLAUDE.md` forbids guessing a keystroke for a
 * blocked agent — a mislabelled Approve button is worse than no button. These
 * are not keystrokes: the label IS the payload, so a button reading "Go ahead"
 * types `Go ahead`, which is what the operator would have typed. Nothing here
 * interprets the agent's prompt or claims to know which option a word maps to.
 * That remains the job of the parsed option buttons above, which carry the
 * agent's OWN digits.
 *
 * THEY SEND, they do not compose. Measured on Collie, which solves the same
 * problem: tapping a quick action runs it, and the reply field is left empty.
 * The argument for composing instead is that you see what you commit — but
 * when the button's label is the whole payload, there is nothing to review
 * that the label did not already say. The cost is that a mis-tap reaches the
 * agent, which is why the panel is closed at rest, the targets are full-height
 * rather than dense, and sending closes it again.
 */

/**
 * The defaults.
 *
 * Deliberately all affirmative, because that is what was asked for — and worth
 * naming as a limit rather than leaving implicit: this makes approving one tap
 * while declining still costs typing. A refusal belongs here too if the
 * asymmetry ever bites.
 */
export const QUICK_REPLIES = ["Yes", "Go ahead", "Approve"] as const;

export function QuickToggle({ open, onToggle }: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="term-quick-toggle"
      aria-expanded={open}
      onClick={onToggle}
    >
      {/* Glyph BESIDE the word, never instead of it — the visible text is this
          control's accessible name, and an icon alone leaves a button a
          voice-control user cannot say. The same WCAG 2.5.3 constraint
          `KeypadToggle` records, and the reason this is not the bare bolt the
          request described. */}
      <FlashIcon className="term-quick-toggle-glyph" />
      Quick
    </button>
  );
}

/**
 * The panel, hook-free: the caller owns when it is open and what a tap does.
 *
 * Sits directly above the reply row, so the thing being sent is adjacent to the
 * field it stands in for.
 */
export function QuickActions({ replies, onSend, busy = false }: {
  replies: readonly string[];
  onSend: (text: string) => void;
  busy?: boolean;
}) {
  return (
    <div className="term-quick" role="group" aria-label="Quick replies">
      {replies.map((text) => (
        <Button
          key={text}
          type="button"
          variant="outline"
          className="term-quick-action"
          disabled={busy}
          // Same reasoning as Send's: a tap begins with a pointerdown, which
          // moves focus off the field and lets iOS dismiss the keyboard — the
          // layout then reflows and this button is no longer under the finger
          // when the tap completes.
          onPointerDown={(e) => { e.preventDefault(); }}
          onClick={() => onSend(text)}
        >
          {text}
        </Button>
      ))}
    </div>
  );
}
