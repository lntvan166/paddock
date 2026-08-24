import { ToggleGroup, ToggleGroupItem } from "@web/components/shadcn/toggle-group";

/**
 * A row of mutually exclusive options, all visible at once.
 *
 * Radix's ToggleGroup supplies the roving focus and the wrap-around, and this
 * adds the one thing it does not: SELECTION FOLLOWS FOCUS.
 *
 * Radix renders `role="radiogroup"` with `role="radio"` children, but its arrow
 * keys move focus only — selecting then needs a second press of Space. Verified
 * in a real browser: ArrowRight moved focus to "Light" while `aria-checked`
 * stayed on "System". For a radiogroup that is wrong; ARIA's own pattern is
 * that arrowing moves the selection. It is also the exact defect this component
 * shipped in its first hand-rolled form — a role announced and its behaviour
 * missing — so inheriting it from a library rather than writing it would have
 * been no better.
 *
 * The `onFocus` below is the fix, and it is the pattern rather than a
 * workaround. Focus arriving on a member selects it, which makes one arrow
 * press do what a radiogroup promises. The other ways focus can arrive are all
 * harmless: tabbing in lands on the already-selected member (a no-op), and a
 * click fires focus and activation with the same value (idempotent).
 *
 * `type="single"` so exactly one member is ever selected. Radix will report
 * `""` when a member is deselected by re-pressing it, which is NOT a valid
 * state here — a theme must always be something — so that is filtered below.
 *
 * Replaces two native `<select>` elements. On iOS a select opens a full-screen
 * wheel to pick between three values, which is more ceremony than the choice
 * deserves and hides the alternatives while you choose among them.
 *
 * Selection reads as a filled high-contrast pill, never a hue change, so the
 * chosen member survives greyscale like everything else in this layer.
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
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        // Re-pressing the selected member makes Radix emit "". Ignored rather
        // than forwarded: every consumer of this control has a required value,
        // and clearing it would leave the theme or the refresh rate unset.
        if (next) onChange(next as T);
      }}
      aria-label={label}
      className="seg"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          aria-label={o.label}
          data-selected={o.value === value ? "yes" : "no"}
          className="seg-item"
          // Selection follows focus — see the note above. This is what makes a
          // single ArrowRight select rather than merely highlight.
          onFocus={() => onChange(o.value)}
        >
          {o.icon ? <span className="seg-icon">{o.icon}</span> : null}
          <span>{o.label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
