import type { Agent, Section } from "@shared/types";
import { formatElapsed } from "@web/components/elapsed";
import { IconTile } from "@web/components/ui/IconTile";
import { StatusDot } from "@web/components/ui/StatusDot";

/** Re-exported for the card and the terminal header, which imported it from
 *  here before the primitive layer existed. */
export { StatusDot };

export type RowEmphasis = "alert" | "card" | "bare";

/**
 * How loud a row is, by SECTION rather than by state.
 *
 * The ladder answers "how much of your attention does this group deserve",
 * which is a property of the group. Deriving it from state would put the same
 * decision in two places, and they would disagree the first time a state maps
 * somewhere new — which is exactly what just happened to `done`.
 *
 * This is the second channel the palette comment has always claimed: a bordered
 * tinted card versus a bare row survives greyscale, where two hues of dot do
 * not.
 */
export function emphasisFor(section: Section): RowEmphasis {
  if (section === "needs-you") return "alert";
  if (section === "ready-unseen") return "card";
  return "bare";
}

/** Dense row. Task text truncates to keep the list scannable. */
export function AgentRow({
  agent, now, emphasis = "bare", onSelect,
}: {
  agent: Agent;
  now: number;
  emphasis?: RowEmphasis;
  /** Opens the detail sheet for this agent. Optional so the row still
   * renders standalone. */
  onSelect?: () => void;
}) {
  return (
    <div
      className="tap row flex items-center gap-2.5 px-3 py-2.5"
      data-emphasis={emphasis}
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
      <IconTile harness={agent.harness} badge={<StatusDot state={agent.state} />} />
      <span className="sr-only">{agent.state}</span>
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
