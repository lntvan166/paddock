import { sectionFor, type Agent, type Section } from "@shared/types";
import { Mark } from "@web/components/Mark";
import { elapsedLabel } from "@web/components/elapsed";
import { groupAgents } from "@web/components/Section";


/**
 * The host label is only worth screen space when it distinguishes something.
 *
 * `PADDOCK_HOST_ID` defaults to `local` (see `.env.example`), so on a
 * single-host install the header was spending its most prominent line saying
 * "local" — true, and of no use to anyone. An operator who has set a real
 * name, which is what multi-host will need, still sees it.
 */
const DEFAULT_HOST_ID = "local";

export function HostHeader({
  hostId,
}: {
  hostId: string | null;
}) {
  return (
    /* The screen's name, then what it is scoped to. The data-terminal redesign
       made the title the noun "Agents" — a screen named after what it lists,
       the same shape Spaces and Settings use — and moved the host into a chip
       at the trailing end, where a switcher will live once there is more than
       one host. The counts sentence that used to sit here is now `Finding`,
       under the band, because it grew into a sentence that needs the width. */
    <header className="host-head">
      <h1 className="host-title">
        <Mark size={18} />
        Agents
      </h1>
      {/* The host label is only shown when it distinguishes something — see
          DEFAULT_HOST_ID above. `connecting…` still has to appear somewhere:
          the title is a constant, so it cannot carry the "we have not heard
          from the server yet" signal. */}
      {hostId === null ? (
        <span className="host-chip" data-live="no">connecting…</span>
      ) : hostId !== DEFAULT_HOST_ID ? (
        <span className="host-chip ident" data-live="yes" title={`Host ${hostId}`}>
          <span className="host-chip-dot" aria-hidden="true" />
          <span className="truncate">{hostId}</span>
        </span>
      ) : null}
    </header>
  );
}

/**
 * The one sentence the dashboard leads with: the fact that most needs a
 * person, named, with how long it has waited.
 *
 * Counted with `sectionFor` and ordered by the shared comparator (through
 * `groupAgents`), so it cannot contradict the section headers under it — the
 * defect this file's counts used to guard against, when "2 needs you" sat
 * over sections reading "Needs you 1".
 *
 * When nothing needs anyone, it falls back to the counts by section, which
 * is the answer to "is everything fine?".
 */
export function Finding({ agents, now }: { agents: Agent[]; now: number }) {
  const g = groupAgents(agents);
  const blocked = g["needs-you"];
  const ready = g["ready-unseen"];
  const age = (a: Agent) => elapsedLabel(now - a.stateSince, a.stateSinceExact);

  if (blocked.length > 0) {
    const first = blocked[0]!;
    const more = blocked.length - 1;
    return (
      <p className="finding">
        <b className="ident">{first.name}</b> has waited {age(first)} for you.
        {more > 0 ? ` ${more} more ${more === 1 ? "needs" : "need"} you.` : ""}
      </p>
    );
  }
  if (ready.length > 0) {
    const first = ready[0]!;
    const more = ready.length - 1;
    return (
      <p className="finding">
        <b className="ident">{first.name}</b> finished {age(first)} ago.
        {more > 0 ? ` ${more} more ready.` : ""}
      </p>
    );
  }
  const n = (s: Section) => agents.filter((a) => sectionFor(a) === s).length;
  const parts = [
    n("working") > 0 ? `${n("working")} working` : null,
    n("idle") > 0 ? `${n("idle")} idle` : null,
  ].filter(Boolean);
  return <p className="finding">{parts.length ? `Nothing needs you. ${parts.join(" · ")}.` : "No agents yet."}</p>;
}
