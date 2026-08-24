import { useRef } from "react";

/**
 * A row of mutually exclusive options, all visible at once.
 *
 * Replaces a native `<select>` for the small fixed choices in settings. On iOS
 * a select opens a full-screen wheel to pick between three values, which is
 * more ceremony than the choice deserves and hides the alternatives while you
 * choose among them.
 *
 * Selection is rendered as a filled high-contrast pill rather than a hue
 * change, so the chosen member survives greyscale like everything else in this
 * layer.
 */
export function Segmented<T extends string>({
  value, options, onChange, label,
}: {
  value: T;
  options: { value: T; label: string; icon?: React.ReactNode }[];
  onChange: (next: T) => void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = options.findIndex((o) => o.value === value);

  /**
   * Move the selection, wrapping at both ends.
   *
   * An unknown current value (idx < 0) is treated as sitting before the first
   * option rather than throwing — a prefs file holding a value this build no
   * longer offers must still leave the control operable.
   */
  function move(delta: number) {
    if (options.length === 0) return;
    const next = ((idx < 0 ? 0 : idx) + delta + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  }

  function jump(to: number) {
    onChange(options[to]!.value);
    refs.current[to]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="seg"
      // A radiogroup that only carried the ROLE would be the "role added,
      // behaviour not" anti-pattern: assistive tech announces a radiogroup, the
      // user presses an arrow key by convention, and nothing moves. Both axes
      // are handled because the control is horizontal on a phone and a screen
      // reader user may try either.
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        else if (e.key === "Home") { e.preventDefault(); jump(0); }
        else if (e.key === "End") { e.preventDefault(); jump(options.length - 1); }
      }}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            ref={(n) => { refs.current[i] = n; }}
            /* Roving tabindex: the whole group is ONE tab stop, which is what a
               radiogroup promises. One tab stop per option would cost three
               presses to get past a three-option control, and the settings
               screen has two of them. */
            tabIndex={selected || (idx < 0 && i === 0) ? 0 : -1}
            data-selected={selected ? "yes" : "no"}
            className="seg-item"
            onClick={() => onChange(o.value)}
          >
            {o.icon ? <span className="seg-icon">{o.icon}</span> : null}
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
