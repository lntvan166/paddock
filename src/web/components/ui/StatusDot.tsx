import type { AgentState } from "@shared/types";

/**
 * The one definition of what a state looks like, read by the list, the card and
 * the terminal header.
 *
 * Traffic-light semantics, matching herdr so an operator moving between the two
 * does not relearn a palette: red has stopped and needs a person, amber is in
 * motion, green is finished, grey is nothing to say.
 *
 * `working` was `--accent` — the token every link and button uses for "you can
 * tap this" — so a state was painted in the interaction colour and competed
 * with the affordances around it. And `blocked` borrowed amber, which left the
 * only state that actually needs a human sharing a colour with the one that
 * needs nothing.
 *
 * Colour is never the only channel: this dot is `aria-hidden` and the state is
 * carried as text beside it, because red-and-green is the classic
 * indistinguishable pair and this palette uses both.
 */
const DOT: Record<AgentState, string> = {
  blocked: "var(--danger)",
  done: "var(--ok)",
  working: "var(--warn)",
  idle: "var(--fg-dim)",
};

/**
 * Resting states are hollow, active states are solid.
 *
 * Every value in `DOT` is tuned to roughly the same lightness so it reads as
 * TEXT, which means as solid discs the resting states carry as much visual
 * weight as the one state that needs a person. On a list where five of six
 * agents are idle, the dots that mean "nothing to do" out-shout the one that
 * does. Hollowing them costs nothing and restores the ranking.
 */
const RESTING: Record<AgentState, boolean> = {
  blocked: false,
  done: false,
  working: false,
  idle: true,
};

/**
 * Which states pulse.
 *
 * `working` only. It is the state that is actually in motion, so motion says
 * what it means. `blocked` has STOPPED — animating it would claim the opposite,
 * and a blocked agent already has a red border and a tinted fill asking for a
 * person. `done` and `idle` are settled.
 */
const PULSE: Record<AgentState, boolean> = {
  blocked: false,
  done: false,
  working: true,
  idle: false,
};

/**
 * `surfaceVar` names the CSS variable the ring's interior is painted with.
 *
 * A ring MUST be filled, never left transparent. Overlaid on an `IconTile`
 * corner, a transparent interior reads as a notch cut out of the icon rather
 * than as a dot sitting on top of it. The default is the page ground; a dot on
 * a card passes `--surface`.
 */
export function StatusDot({
  state, surfaceVar = "--bg",
}: {
  state: AgentState;
  surfaceVar?: string;
}) {
  const resting = RESTING[state];
  // `--dot-hue` feeds the pulse keyframe, so the halo is the state's own colour
  // rather than a second copy of it in the stylesheet. Set for every state, not
  // just the pulsing one: a state that starts pulsing later should not also
  // have to learn to publish its colour.
  const style = {
    ...(resting
      ? { borderColor: DOT[state], background: `var(${surfaceVar})` }
      : { background: DOT[state], borderColor: DOT[state] }),
    "--dot-hue": DOT[state],
  } as React.CSSProperties;
  return (
    <span
      aria-hidden="true"
      data-fill={resting ? "ring" : "solid"}
      data-pulse={PULSE[state] ? "yes" : "no"}
      className="dot"
      style={style}
    />
  );
}
