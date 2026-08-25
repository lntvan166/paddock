import { sectionFor, type Agent, type Section } from "@shared/types";
import { Mark } from "@web/components/Mark";

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
  hostId, agents, onOpenSettings, onOpenSpaces,
}: {
  hostId: string | null;
  agents: Agent[];
  /**
   * REQUIRED, not optional. This is the only route into `#/settings`, and
   * this branch already lost that entry point once. Optional made the
   * callback's absence a type-checked non-event: a render that forgot to pass
   * it compiled, and the gear silently did nothing. Tests that do not care
   * about navigation pass `() => {}` — one explicit character of noise, in
   * exchange for the compiler catching a dropped entry point.
   *
   * Follows the same "component takes a callback, the hash write lives in
   * App.tsx" convention as AgentCard/AgentRow's `onSelect`.
   */
  onOpenSettings: () => void;
  /** The only route into `#/spaces`. REQUIRED for the same reason
   *  `onOpenSettings` is: an optional prop makes a dropped call site a
   *  silent no-op instead of a compile error. */
  onOpenSpaces: () => void;
  /**
   * `latestKnown` was here, REQUIRED so that an edit which stopped passing it
   * would be a type error rather than a silently absent line. The line it fed
   * has moved to `ReleaseBanner`, so the prop is gone rather than left required
   * and unrendered — a required prop nothing reads is the same trap pointing
   * the other way. The guarantee now lives in `App.tsx`, which is the one
   * caller that has the value.
   */
}) {
  // Counted by SECTION, never by raw state. Deriving these from `state` was how
  // the header came to read "2 needs you" over sections reading "NEEDS YOU · 1"
  // and "READY · 1" — and why an acknowledged finish, which renders under Idle,
  // was still tallied as needing attention. sectionFor is the one rule.
  const n = (s: Section) => agents.filter((a) => sectionFor(a) === s).length;
  const parts = [
    n("needs-you") > 0 ? `${n("needs-you")} needs you` : null,
    n("ready-unseen") > 0 ? `${n("ready-unseen")} ready` : null,
    n("working") > 0 ? `${n("working")} working` : null,
    n("idle") > 0 ? `${n("idle")} idle` : null,
  ].filter(Boolean);
  return (
    <header
      className="px-3 py-2.5"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      {/* Two rows, not one.
          Everything used to sit on a single line: wordmark, host id, the whole
          section summary, and the gear. At the type sizes this file now uses
          that line overflowed at 390px — `demo-box` hyphenated into "demo-" /
          "box", which is the one thing an identifier must never do, and the
          summary wrapped under itself. Identity and the way out belong on the
          top line; the summary is a sentence and gets its own. */}
      <div className="flex items-center justify-between gap-2">
        <h1 className="flex min-w-0 items-center gap-1.5 font-semibold" style={{ fontSize: "var(--t-lg)" }}>
          <Mark size={16} />
          paddock
          {/* The host label, demoted from the title but not dropped — see
              DEFAULT_HOST_ID above. `connecting…` still has to appear
              somewhere: the title is now a constant, so it can no longer carry
              the "we have not heard from the server yet" signal it used to.
              `whitespace-nowrap` because a hostname that breaks across a
              hyphen reads as a different hostname. */}
          {hostId === null ? (
            <span className="row-state ml-1 whitespace-nowrap">connecting…</span>
          ) : hostId !== DEFAULT_HOST_ID ? (
            <span className="ident row-meta ml-1 truncate whitespace-nowrap">{hostId}</span>
          ) : null}
        </h1>
        {/* The new-release notice USED to live here, as one dim line among the
            other dim metadata. The reasoning was sound — `paddock update` is
            not an alarm — but a 10px line the colour of its neighbours is not
            read, it is skipped, and an operator a version behind did not know.
            It is now `ReleaseBanner`, shown once and dismissible. Do not add a
            second copy here: one fact, one channel. */}
        {/* Same shape and focus treatment as the settings button beside it —
            a real button, not a hover-revealed affordance, since this is the
            only route into #/spaces and must be reachable by touch on the
            first tap. */}
        <button
          type="button"
          className="host-spaces-btn tap shrink-0"
          aria-label="Spaces"
          onClick={onOpenSpaces}
        >
          ▦
        </button>
        {/* A real button, not a hover-revealed affordance — the only route
            into #/settings, so it must be reachable by touch on the first
            tap, not discoverable only with a mouse. */}
        <button
          type="button"
          className="host-settings-btn tap shrink-0"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          ⚙
        </button>
      </div>
      {/* paddock's own sentence about the list, so sans — the counts inside it
          are part of the sentence, not a data readout. */}
      <p className="row-state mt-1">
        {parts.length ? parts.join(" · ") : "no agents"}
      </p>
    </header>
  );
}
