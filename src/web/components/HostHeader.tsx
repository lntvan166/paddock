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
    /* ONE line, the same shape `.spaces-head` uses — a title, then what it is
       a title OF, on the same baseline. It was two rows, and its own note gave
       the reason: at these type sizes the line overflowed at 390px and
       `demo-box` hyphenated into "demo-" / "box", which is the one thing an
       identifier must never do.

       That reason expired when navigation moved to the bottom bar. The line no
       longer carries a 44px gear and a 44px Spaces button, and the measurement
       now is 297px of content in 358px of room — 350px in the worst case that
       also shows a non-default host id.

       350 in 358 is eight pixels of slack, which is not enough to promise, so
       the row WRAPS rather than overflows. In the common case it is one line;
       in the rare long one the summary drops below instead of hyphenating the
       wordmark. */
    <header className="host-head">
      <h1 className="host-title">
        <Mark size={18} />
        paddock
        {/* The host label, demoted from the title but not dropped — see
            DEFAULT_HOST_ID above. `connecting…` still has to appear somewhere:
            the title is a constant, so it can no longer carry the "we have not
            heard from the server yet" signal it used to. `whitespace-nowrap`
            because a hostname that breaks across a hyphen reads as a different
            hostname — and on one line that is the failure this layout has to
            keep refusing. */}
        {hostId === null ? (
          <span className="row-state whitespace-nowrap">connecting…</span>
        ) : hostId !== DEFAULT_HOST_ID ? (
          <span className="ident row-meta truncate whitespace-nowrap">{hostId}</span>
        ) : null}
      </h1>
      {/* paddock's own sentence about the list, so sans — the counts inside it
          are part of the sentence, not a data readout.

          `--t-md`, the step the scale reserves for "anything you read". It was
          at --t-xs, one below what the app's own rule prescribes, which is why
          the line that says how many agents need you read as fine print.

          The new-release notice USED to live in this header as another dim
          line. It is `ReleaseBanner` now, shown once and dismissible — one
          fact, one channel. And Spaces and Settings used to sit here as two
          unlabelled glyphs in the top-right corner; they are labelled tabs at
          the bottom now. Do not put a navigation control back in this row. */}
      <p className="host-summary">
        {parts.length ? parts.join(" · ") : "no agents"}
      </p>
    </header>
  );
}
