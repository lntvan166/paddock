import type { NavKey } from "@shared/types";
import { writePref, type KeypadPref } from "@web/prefs";
import { Button } from "@web/components/shadcn/button";

/**
 * The keypad, laid out as it is rendered.
 *
 * Only keys herdr accepts appear (verified against herdr 0.8.0 — `pageup`,
 * `home` and friends are rejected with `invalid_key`, so offering them would
 * be a button that always fails). The order puts ↑/↓/Enter where a thumb
 * reaches them, because moving a selection and committing it is the whole
 * reason this pad exists.
 *
 * One of paddock's own hand-rolled shared primitives (`CLAUDE.md`'s list),
 * not a `PaneTerminal` internal: it has no coupling to the transcript's
 * polling, ANSI pass or scroll handling, and both terminals drive it —
 * `AgentTerminal` (`agent.send_keys`) and `PaneTerminal`'s own shell
 * composition (`pane.send_keys`, §16.3) — through the same markup, so the two
 * cannot drift apart the way two separate implementations could.
 */
const PRIMARY_KEYS: ReadonlyArray<{ key: NavKey; label: string }> = [
  { key: "up", label: "↑" },
  { key: "down", label: "↓" },
  { key: "enter", label: "⏎ Enter" },
];

/**
 * Everything else, on a shorter row.
 *
 * The split is by frequency, not by category: answering a prompt from a phone
 * is ↑/↓ to move and Enter to commit, and those three had been sharing equal
 * billing with Space and Tab across three tall rows that took 40% of the
 * viewport — on the screen whose whole job is showing a transcript.
 */
const SECONDARY_KEYS: ReadonlyArray<{ key: NavKey; label: string }> = [
  { key: "esc", label: "Esc" },
  { key: "left", label: "←" },
  { key: "right", label: "→" },
  { key: "tab", label: "Tab" },
  // Spelled out, not "␣": the symbol renders as a tofu box in several mobile
  // system fonts, which is a button whose label is a rendering failure.
  { key: "space", label: "Space" },
];

export interface KeypadProps {
  pad: KeypadPref;
  busy: boolean;
  onPress: (key: NavKey) => void;
}

/**
 * The nav keypad, rendered once and shared by both callers that can drive it:
 * `AgentTerminal` (`agent.send_keys`) and `PaneTerminal`'s own shell
 * composition (`pane.send_keys`). Only the sender differs — `onPress` — which
 * is exactly the asymmetry §16.3 calls out: same control, different verb,
 * decided by the pane's `harness`.
 */
export function Keypad({ pad, busy, onPress }: KeypadProps) {
  if (pad === "hidden") return null;
  return (
    <div className="term-keys" data-keypad={pad} role="group" aria-label="Send key">
      <div className="term-keys-primary">
        {PRIMARY_KEYS.map((k) => (
          <Button
            key={k.key} type="button" variant="outline"
            /* Enter carries the commit — see .term-key-enter. The other two
               only move a highlight, so they stay quiet. */
            className={k.key === "enter" ? "term-key term-key-enter" : "term-key"}
            data-key={k.key}
            disabled={busy} onClick={() => onPress(k.key)}
          >
            {k.label}
          </Button>
        ))}
      </div>
      {pad === "full" && (
        <div className="term-keys-secondary">
          {SECONDARY_KEYS.map((k) => (
            <Button
              key={k.key} type="button" variant="outline" className="term-key term-key-sm"
              data-key={k.key}
              disabled={busy} onClick={() => onPress(k.key)}
              aria-label={k.key}
            >
              {k.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The pad's three states, in the order the toggle cycles them.
 *
 * A cycle rather than two controls because the row it sits in has 36px and
 * already carries Wrap and refresh.
 */
const NEXT_PAD: Record<KeypadPref, KeypadPref> = {
  hidden: "compact", compact: "full", full: "hidden",
};

/**
 * The pad's own collapse control, shared by both terminals for the same reason
 * the pad itself is: it was duplicated verbatim in `AgentTerminal` and
 * `PaneTerminal` — identical markup, identical cycle, identical `writePref` —
 * differing only in the name of the state variable behind it. And the WCAG
 * reasoning below existed in ONE of the two copies, while the other pointed at
 * it with "for the reason recorded there", which is a reference a future editor
 * of that file will not follow.
 *
 * Beside Wrap because both are view controls, and because a collapse button
 * INSIDE the pad would spend the height it exists to reclaim. Its OWN class:
 * sharing `.term-wrap-toggle` made a selector written for the wrap control
 * match this one too, by DOM order rather than by intent. Text rather than a
 * keyboard glyph because a symbol renders as a tofu box in several mobile
 * system fonts — the same measurement that spells out "Space" above.
 *
 * The pad is 106px of a 390x844 phone, measured, and its default is `hidden`:
 * a parsed prompt renders real option buttons and tapping one answers in a
 * single tap, so on the commonest blocked screen the arrows were a duplicate
 * path charging a quarter of the transcript.
 *
 * THE ACCESSIBLE NAME IS EXACTLY "Keys", and it is not replaced by an
 * `aria-label`: an accessible name that does not contain the visible label is
 * a WCAG 2.5.3 hazard for voice control, and "Keys ·" against "Keys: arrows
 * and Enter" is that hazard. `aria-expanded` carries the part that matters —
 * the pad is a disclosure, which is what that attribute is for — and the dots
 * are decorative, so they are hidden from the name rather than spoken as
 * punctuation. Which of the two open sizes is showing is audible the way it is
 * visible: the keys themselves appear.
 *
 * The stored preference is written HERE, because this control is the operator
 * making a choice. `AgentTerminal`'s auto-reveal on a blocked agent
 * deliberately does not persist — that is the agent's doing, not a choice —
 * which is why it sets its own state directly and does not come through here.
 */
export function KeypadToggle({ pad, onChange }: {
  pad: KeypadPref;
  onChange: (pad: KeypadPref) => void;
}) {
  return (
    <button
      type="button"
      className="term-keys-toggle"
      data-state={pad}
      aria-expanded={pad !== "hidden"}
      onClick={() => {
        const v = NEXT_PAD[pad];
        onChange(v);
        writePref("keypad", v);
      }}
    >
      Keys
      {pad !== "hidden" && (
        <span aria-hidden="true">{pad === "compact" ? " ·" : " ··"}</span>
      )}
    </button>
  );
}
