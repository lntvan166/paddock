import type { AgentState } from "@shared/types";
import { StatusDot } from "@web/components/ui/StatusDot";

/**
 * An agent's state, in words, with its dot.
 *
 * The data-terminal redesign moved the state off the tile's corner and into the
 * row's trailing column, where it is READ rather than decoded: a 7px dot on a
 * 28px tile was the only place the state appeared, and it relied on colour
 * alone. Colour goes on the dot and the word together and nowhere else — the
 * card behind it stays neutral, so red is spent once per agent.
 *
 * `suffix` is what follows the word on the same line ("· 2m" in a card,
 * "waiting 2m" in a terminal header), kept in the same run so it cannot wrap
 * away from the word it qualifies.
 */
export const STATE_WORD: Record<AgentState, string> = {
  blocked: "Blocked",
  working: "Working",
  done: "Finished",
  idle: "Idle",
  error: "Error",
};

export function StateWord({
  state, suffix, surfaceVar,
}: {
  state: AgentState;
  suffix?: string;
  /** Passed through to the dot: the ground an idle agent's hollow ring shows. */
  surfaceVar?: string;
}) {
  return (
    <span className="state-word" data-state={state}>
      <StatusDot state={state} surfaceVar={surfaceVar} />
      {STATE_WORD[state]}
      {suffix ? <span className="state-word-suffix">{suffix}</span> : null}
    </span>
  );
}
