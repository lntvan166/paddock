import { CircleAlert, CircleCheck } from "lucide-react";
import type { AgentState } from "@shared/types";

/**
 * A shape for the two states an operator has to tell apart under pressure.
 *
 * Colour and text already carry these — a red card saying "Waiting for input",
 * a green one saying "Finished". This adds the third channel, because
 * red-and-green is the classic indistinguishable pair and this palette spends
 * both on exactly those two. A shape survives what a hue does not.
 *
 * Only `blocked` and `done`. `working` already has a pulsing dot and `idle` has
 * nothing to say; giving all four an icon would spend the distinction that
 * makes these two carry weight.
 *
 * From lucide rather than `ui/icons.tsx`, which is a departure worth stating:
 * the eight glyphs there are hand-written because an icon library was not worth
 * 30kB for eight paths. lucide is already a dependency now — shadcn's Checkbox
 * renders a lucide tick on this very screen — so these two cost a few hundred
 * bytes each and, more to the point, are not two more paths for me to
 * hand-transcribe and get subtly wrong.
 *
 * `aria-hidden` throughout: every call site writes the state out in words
 * beside it, so announcing the shape would only repeat that.
 */
const ICONS: Partial<Record<AgentState, { Icon: typeof CircleAlert; colour: string }>> = {
  blocked: { Icon: CircleAlert, colour: "var(--danger)" },
  done: { Icon: CircleCheck, colour: "var(--ok)" },
};

export function StateIcon({ state, size = 13 }: { state: AgentState; size?: number }) {
  const entry = ICONS[state];
  if (!entry) return null;
  const { Icon, colour } = entry;
  return <Icon aria-hidden="true" focusable="false" size={size} color={colour} />;
}
