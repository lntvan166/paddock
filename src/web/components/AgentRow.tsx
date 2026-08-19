import type { Agent } from "@shared/types";
import { formatElapsed } from "@web/components/elapsed";

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
 * Colour is never the only channel: `StateDot` is `aria-hidden` and the state
 * is carried as text beside it, because red-and-green is the classic
 * indistinguishable pair and this palette now uses both.
 */
const DOT: Record<Agent["state"], string> = {
  blocked: "var(--danger)",
  done: "var(--ok)",
  working: "var(--warn)",
  idle: "var(--fg-dim)",
};

export function StateDot({ state }: { state: Agent["state"] }) {
  return (
    <span
      aria-hidden="true"
      className="h-[7px] w-[7px] shrink-0 rounded-full"
      style={{ background: DOT[state] }}
    />
  );
}

/** Dense row. Task text truncates to keep the list scannable. */
export function AgentRow({
  agent, now, onSelect,
}: {
  agent: Agent;
  now: number;
  /** Opens the detail sheet for this agent. Optional so the row still
   * renders standalone. */
  onSelect?: () => void;
}) {
  return (
    <div
      className="tap flex items-center gap-2.5 px-3 py-2.5"
      style={{ borderTop: "1px solid var(--border)" }}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
    >
      <StateDot state={agent.state} />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold">{agent.name}</div>
        <div className="truncate text-[11px]" style={{ color: "var(--fg-dim)" }}>
          {agent.task}
        </div>
      </div>
      <span className="shrink-0 text-[10px]" style={{ color: "var(--fg-dim)" }}>
        {formatElapsed(now - agent.stateSince)}
      </span>
    </div>
  );
}

/**
 * The collapsed form of an idle agent.
 *
 * It opens the terminal like every other representation of an agent. It used
 * to be an inert `<span>`, which made the Idle section — five of six agents on
 * a typical screen — completely untappable: the operator taps a name, nothing
 * happens, and there is no way to tell a dead control from a slow one. Every
 * place an agent's name appears is a way in.
 *
 * A real `<button>` rather than a div with a click handler, so it is
 * focusable, keyboard-activatable and announced as a control for free.
 */
export function AgentChip({ agent, onSelect }: { agent: Agent; onSelect?: () => void }) {
  return (
    <button
      type="button"
      className="tap rounded-full px-2.5 py-1 text-[10px]"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--fg-dim)" }}
      onClick={onSelect}
    >
      {agent.name}
    </button>
  );
}
