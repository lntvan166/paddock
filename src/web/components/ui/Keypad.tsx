import type { NavKey } from "@shared/types";
import type { KeypadPref } from "@web/prefs";
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
export const PRIMARY_KEYS: ReadonlyArray<{ key: NavKey; label: string }> = [
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
export const SECONDARY_KEYS: ReadonlyArray<{ key: NavKey; label: string }> = [
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
