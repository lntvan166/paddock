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
  hostId, agents,
}: {
  hostId: string | null;
  /**
   * Still required, and still counted with `sectionFor` — see the summary
   * below. The header no longer NAVIGATES anywhere: `onOpenSettings` and
   * `onOpenSpaces` moved to `TabBar`, which puts both destinations within
   * thumb reach and gives them visible labels.
   *
   * Their old doc comments argued at length that they must be REQUIRED rather
   * than optional, because an optional callback makes a dropped entry point a
   * silent no-op instead of a compile error. That reasoning was right and is
   * not lost: `TabBar`'s destinations are plain `href`s to the hashes the
   * router already owns, so there is no callback left to drop.
   */
  agents: Agent[];
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
    <header className="host-head">
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
        {/* Spaces and Settings USED to sit here, as two unlabelled 44px glyphs
            in the top-right corner — the least reachable point on a phone held
            in one hand, on a screen designed to be read one-handed. They are
            tabs now, at the bottom, with labels. Do not put a navigation
            control back in this corner. */}
      </div>
      {/* paddock's own sentence about the list, so sans — the counts inside it
          are part of the sentence, not a data readout.

          `host-summary`, not `row-state`: this is a SENTENCE, and the scale
          reserves --t-xs for "eyebrows, ages, counts, badges: metadata" and
          --t-md for "anything you read". It was set one step below what the
          app's own rule prescribes, which is why the line that says how many
          agents need you read as fine print. */}
      <p className="host-summary">
        {parts.length ? parts.join(" · ") : "no agents"}
      </p>
    </header>
  );
}
