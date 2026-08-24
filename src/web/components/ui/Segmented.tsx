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
  return (
    <div role="radiogroup" aria-label={label} className="seg">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
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
