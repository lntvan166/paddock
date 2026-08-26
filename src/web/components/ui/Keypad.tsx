import type { NavKey } from "@shared/types";
import { BackspaceIcon, KeyboardIcon } from "@web/components/ui/icons";
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
/**
 * The three keys that answer a prompt, and the whole of `compact`.
 *
 * The split is by frequency, not category: answering a prompt from a phone is
 * ↑/↓ to move and Enter to commit. `compact` exists to give the transcript its
 * height back, so it stays ONE row — the inverted-T below is a `full` layout,
 * and there is no T to preserve here because ←/→ are not in this set at all.
 */
const PRIMARY_KEYS: ReadonlyArray<{ key: NavKey; label: string }> = [
  { key: "up", label: "↑" },
  { key: "down", label: "↓" },
  { key: "enter", label: "⏎ Enter" },
];

/**
 * `full`, as an inverted T.
 *
 * `↑` above and `← ↓ →` beneath is the shape every physical keyboard uses and
 * every other mobile terminal copies. This pad used to run the arrows in
 * reading order across two rows — ↑ ↓ then ← → — which matches nothing an
 * operator's hands already know.
 *
 * `null` is a deliberate hole, not a missing key: it is the cell an inverted T
 * leaves empty, and filling it would break the shape that makes the cluster
 * readable.
 */
const GRID: ReadonlyArray<ReadonlyArray<{ key: NavKey; label: string; icon?: "backspace" } | null>> = [
  [
    { key: "esc", label: "Esc" },
    { key: "backspace", label: "Backspace", icon: "backspace" },
    { key: "up", label: "↑" },
    // The WORD stays, at four columns as at three. `⏎` (U+23CE) alone is the
    // same bare-codepoint gamble `Space` is spelled out to avoid — and this is
    // the committing key, so it is the worst one to render as a tofu box.
    { key: "enter", label: "⏎ Enter" },
  ],
  [
    { key: "tab", label: "Tab" },
    { key: "left", label: "←" },
    { key: "down", label: "↓" },
    { key: "right", label: "→" },
  ],
];

export interface KeypadProps {
  pad: KeypadPref;
  busy: boolean;
  onPress: (key: NavKey) => void;
  /**
   * Which control keys this pane can actually accept.
   *
   * `"shell"` gets all eight, because a pane with no harness takes control
   * characters on the text path. `"agent"` gets `^C` alone — see
   * `AGENT_CONTROL_KEYS`. The caller knows which it is; the pad does not
   * guess, and must not, because guessing wrong renders a button that errors.
   */
  context?: "shell" | "agent";
  /**
   * Whether the Ctrl latch is armed, and how to change it.
   *
   * Supplied only by a SHELL caller. An agent pane cannot receive a control
   * character at all — herdr has no `agent.send_text` — so a latch there would
   * arm a field that could reach nothing, which is the "control that lies"
   * defect this project refuses elsewhere.
   */
  ctrlArmed?: boolean;
  onCtrlArm?: (armed: boolean) => void;
}

/**
 * The nav keypad, rendered once and shared by both callers that can drive it:
 * `AgentTerminal` (`agent.send_keys`) and `PaneTerminal`'s own shell
 * composition (`pane.send_keys`). Only the sender differs — `onPress` — which
 * is exactly the asymmetry §16.3 calls out: same control, different verb,
 * decided by the pane's `harness`.
 */
export function Keypad({
  pad, busy, onPress, context = "agent", ctrlArmed = false, onCtrlArm,
}: KeypadProps) {
  if (pad === "hidden") return null;

  // The latch belongs to a shell and only a shell. `onCtrlArm` being absent is
  // how an agent caller says so — the pad does not infer it from `context`
  // twice.
  const canLatch = context === "shell" && onCtrlArm !== undefined;

  return (
    <div className="term-keys" data-keypad={pad} role="group" aria-label="Send key">
      {pad === "compact" && (
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
      )}

      {pad === "full" && (
        <>
          {GRID.map((row, i) => (
            <div className="term-keys-row" key={i}>
              {row.map((k, j) => (
                k === null
                  // The T's empty cell. A span rather than a disabled button:
                  // a disabled control is still a control a screen reader
                  // announces, and there is nothing here to announce.
                  ? <span className="term-key-gap" key={`gap-${j}`} aria-hidden="true" />
                  : (
                    <Button
                      key={k.key} type="button" variant="outline"
                      className={k.key === "enter" ? "term-key term-key-enter" : "term-key"}
                      data-key={k.key}
                      disabled={busy} onClick={() => onPress(k.key)}
                      /* Backspace shows a glyph, so its accessible name has to
                         carry BOTH what it is and what it does — the label was
                         ambiguous about whether it clears one character or the
                         line, and it is one. */
                      aria-label={k.icon === "backspace" ? "Backspace — delete one character" : undefined}
                    >
                      {k.icon === "backspace" ? <BackspaceIcon className="term-key-glyph" /> : k.label}
                    </Button>
                  )
              ))}
            </div>
          ))}

          <div className="term-keys-row">
            <Button
              type="button" variant="outline" className="term-key term-key-space"
              data-key="space" disabled={busy} onClick={() => onPress("space")}
            >
              Space
            </Button>
            {/* `^C` keeps a button of its own even though the latch could reach
                it, because interrupting is the one control act reached for in a
                hurry — and it is the ONLY control key an agent pane can take,
                so this is also the whole control row over there. */}
            <Button
              type="button" variant="outline" className="term-key term-key-ctrl"
              data-key="ctrl-c" disabled={busy} onClick={() => onPress("ctrl-c")}
              aria-label="Interrupt"
            >
              ^C
            </Button>
            {canLatch && (
              <Button
                type="button" variant="outline"
                className="term-key term-key-latch"
                data-ctrl-latch
                aria-pressed={ctrlArmed}
                disabled={busy}
                onClick={() => onCtrlArm(!ctrlArmed)}
              >
                Ctrl
              </Button>
            )}
          </div>
        </>
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
      {/* Glyph BESIDE the word, never instead of it. The visible text is this
          control's accessible name — replacing it with an icon alone would
          leave a button whose name a voice-control user cannot say, which is
          the WCAG 2.5.3 hazard this file already records for the three-state
          cycle below. */}
      <KeyboardIcon className="term-keys-toggle-glyph" />
      Keys
      {pad !== "hidden" && (
        <span aria-hidden="true">{pad === "compact" ? " ·" : " ··"}</span>
      )}
    </button>
  );
}
