import { useEffect, useRef, useState } from "react";
import { isCtrlKey, type CtrlKey } from "@shared/types";

/**
 * The armed Ctrl field: tap `Ctrl`, type a letter, the combination is sent.
 *
 * WHY THIS EXISTS AT ALL. herdr's `pane.send_keys` enforces an allowlist its
 * schema does not advertise — `up down left right enter esc escape tab space
 * backspace C-c f1 f2`, and nothing else. `pane.send_text` forwards bytes
 * without inspecting them, so a control key travels as its control character
 * instead. That makes all twenty-six reachable, and a button each would be
 * twenty-six buttons: one latch and one field is the same reach in two taps.
 *
 * SENDS ON THE FIRST CHARACTER, with no Send button. Collie — where this idea
 * comes from — types into a field and taps Send, which is three actions. A
 * one-character field has nothing worth reviewing before it commits, so this
 * is two. The latch clears afterwards, so a mis-tap sends one wrong key rather
 * than arming a trap for the next one.
 *
 * There is no `lock` mode. Termux's modifier has two tiers — tap latches,
 * long-press locks — and the second tier is redundant here: this field stays
 * armed while it is open, which IS the lock, and an unhinted long-press is the
 * gesture class paddock's UI rules ban.
 */
export function CtrlCompose({ onSend, onDismiss, busy = false }: {
  /** Send `ctrl-<letter>`. The caller owns the transport; this owns the input. */
  onSend: (key: CtrlKey) => void;
  /** Disarm — the ✕, or a letter having been sent. */
  onDismiss: () => void;
  busy?: boolean;
}) {
  const [rejected, setRejected] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  // Focus on arm, so the native keyboard is already up. Without this the
  // operator taps Ctrl, sees a field, and has to tap the field too — which
  // would put this back at Collie's three actions.
  useEffect(() => { ref.current?.focus(); }, []);

  const take = (raw: string) => {
    const letter = raw.trim().toLowerCase().slice(0, 1);
    if (letter === "") return;
    const key = `ctrl-${letter}`;
    if (!isCtrlKey(key)) {
      // Said, never swallowed. A digit or a symbol has no control character,
      // and a field that silently ate the keystroke would look broken.
      setRejected(raw.slice(0, 1));
      return;
    }
    setRejected(null);
    onSend(key);
    onDismiss();
  };

  return (
    <div className="term-ctrl-compose" role="group" aria-label="Send a Ctrl combination">
      <span className="term-ctrl-lbl" aria-hidden="true">Ctrl +</span>
      <input
        ref={ref}
        className="term-ctrl-field"
        type="text"
        inputMode="text"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        // `maxLength` is a hint, not the guard: `take` slices to one character
        // regardless, because a paste can carry more than a keystroke can.
        maxLength={1}
        disabled={busy}
        aria-label="Type a letter to send with Ctrl"
        placeholder="a–z"
        value=""
        onChange={(e) => take(e.target.value)}
      />
      {rejected !== null && (
        <span className="term-ctrl-warn" role="status">
          {`Ctrl+${rejected} is not a control key`}
        </span>
      )}
      <button
        type="button"
        className="term-ctrl-x"
        onClick={onDismiss}
        aria-label="Cancel Ctrl"
      >
        ✕
      </button>
    </div>
  );
}
