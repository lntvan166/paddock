/**
 * A switch, and only a switch.
 *
 * It deliberately takes no `reason` for being disabled. The explanation belongs
 * to the SETTING rather than to the control — paddock's own case is a browser
 * permission, which is a fact about the device — so the caller passes it to
 * `Card`'s `footer`. Keeping this component to one job is also what lets it be
 * tested without a card around it.
 *
 * `role="switch"` on a real `<button>`, so it is focusable, keyboard-operable
 * and announced as a control without any of that being re-implemented here.
 */
export function Toggle({
  checked, onChange, label, disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. The visible label lives in the card header, so without
   *  this the switch would be announced as an unnamed control. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="toggle"
      data-on={checked ? "yes" : "no"}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" className="toggle-track">
        <span className="toggle-knob" />
      </span>
    </button>
  );
}
