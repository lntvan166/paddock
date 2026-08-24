import { Switch } from "@web/components/shadcn/switch";

/**
 * A switch, and only a switch.
 *
 * Radix's Switch does the semantics — `role="switch"`, `aria-checked`, keyboard
 * activation, disabled — and this keeps paddock's API and its touch target on
 * top of it. The API is deliberately unchanged from the hand-rolled version, so
 * that swapping the internals touched no consumer and no consumer's tests.
 *
 * The wrapper exists for one reason: Radix's switch is 18.4px tall, and this
 * app's floor is 2.75rem / 44px (`.tap`, `.term-keys`, `.settings-mute
 * button`). The control you can hit is the wrapper; the thing you can see is
 * the switch inside it. `tests/ui-styles.test.ts` guards that floor.
 *
 * It deliberately does NOT take a `reason` for being disabled. The explanation
 * belongs to the SETTING rather than to the control — paddock's own case is a
 * quick-tunnel URL, which is a fact about the deployment — so the caller passes
 * it to `Card`'s `footer`. Keeping this to one job is also what lets it be
 * tested without a card around it.
 */
export function Toggle({
  checked, onChange, label, disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. The visible label lives in the card row beside it, so
   *  without this the switch would be announced as an unnamed control. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <span className="toggle" data-on={checked ? "yes" : "no"}>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
        disabled={disabled}
      />
    </span>
  );
}
