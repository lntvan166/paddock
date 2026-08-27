
/**
 * How old a tree read has to be before its age is worth screen space.
 *
 * The screen re-reads on every write and on `tree-stale`, so in normal use the
 * age sits at zero and the line said nothing all day. Ten seconds is the point
 * at which "this might have moved" starts being true rather than pedantic.
 */
const STALE_AFTER_S = 10;
import { useEffect, useState } from "react";
import { fetchSpaceTree } from "@web/api";
import { CreateSheet, type CreateSenders } from "@web/components/CreateSheet";
import { sortSpaces, treeCwds } from "@web/components/space-sort";
import { SpaceRow } from "@web/components/SpaceRow";
import { useSpaceTree } from "@web/components/use-space-tree";
import { useStore } from "@web/store";
import type { RowSenders } from "@web/components/RowActions";
import type { SpaceTree } from "@shared/types";

/**
 * `load` is injected so the tests can drive this without a network, and so a
 * failure is a value this component renders rather than a thrown promise.
 */
export function Spaces({ active = true, load = fetchSpaceTree, senders, createSenders, navigate }: {
  /** Whether this is the tab in front. Acted on in the poll-gating task. */
  active?: boolean;
  load?: () => Promise<SpaceTree>;
  /** The row `⋯`'s writes — rename and close, space-scoped.
   *
   *  This prop was DELETED when the rows lost their controls, and is back with
   *  them. That is the prop doing its job: it exists exactly as long as
   *  something on this screen writes, and its absence was the compiler's way
   *  of saying nothing did. */
  senders?: RowSenders;
  /** The create sheet's writes, injected for the same reason `load` is: a
   *  component test drives a create without a network. */
  createSenders?: CreateSenders;
  /** How the create sheet leaves for the pane it just made. Injected so a
   *  test can observe the navigation instead of mutating the hash. */
  navigate?: (hash: string) => void;
}) {
  const { spacesAvailable } = useStore();
  // The needs-you count moved to `App`, which now owns the single `TabBar`.
  // Deriving it here as well was two screens computing one number — the exact
  // shape of the bug `HostHeader`'s counts comment records.
  // `sectionFor`, the one rule — never re-derived from raw state. This is the
  // whole reason the badge earns its place: from here, a newly blocked agent
  // was previously invisible.
  const { tree, error, refresh } = useSpaceTree(load, active);
  const [now, setNow] = useState(() => Date.now());

  // The "as of" label ticks locally; the server is not asked for time.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  // The create sheet's quick picks (§9.3) — every cwd in the WHOLE tree, not
  // just this screen's, computed by `treeCwds` so this and the space screen
  // agree on the rule.
  const cwds = treeCwds(tree);
  /** Seconds since the tree was read, which is what the refresh control
   *  reports once it is old enough to be worth reporting. */
  const age = tree === null ? 0 : Math.max(0, Math.round((now - tree.readAt) / 1000));

  /**
   * Whether the create control exists at all.
   *
   * The SAME capability the Spaces entry point in `App.tsx` is gated on
   * (`spacesAvailable`, set from the server's own snapshot frame), for the same
   * reason: with no herdr session `POST /api/spaces` 404s honestly, so a `+`
   * would be a control that always errors — which `routes.ts` records as a
   * defect class on `/ack`'s Dismiss button. A capability, never a demo flag,
   * never a hostname, never `import.meta.env`, never a device check.
   */
  const canCreate = spacesAvailable;

  return (
    // `screen`, not a flowing column — Back must stay reachable at any scroll
    // position. See the `.screen, .term` block in styles.css.
    <main className="screen">
      {/* No back control, for the same reason Settings has none: Spaces is a
          TAB DESTINATION, a peer of Agents rather than a screen descended into,
          and the bar at the bottom is both the way out and the label saying
          where you are. §16.4's ruling — that a back control must use the
          shared `.term-back` treatment — still governs every screen that HAS
          one; this screen no longer does. A single space still does, because
          you reached it from here. */}
      <header className="spaces-head screen-chrome">
        <h2>Spaces</h2>
        {/* The count, beside the thing it counts — the same shape every section
            heading on the dashboard uses ("NEEDS YOU · 1"), and the machine
            voice for the same reason: it is a reading off the list, not part of
            the label. It used to sit in a footer at the bottom of the screen,
            which since the tab bar landed meant a strip of metadata wedged
            between the last row and the tabs, as far from the word "Spaces" as
            the screen allows. */}
        {tree !== null && (
          <span className="ident row-meta spaces-count">· {tree.spaces.length}</span>
        )}
        {/* Says WHEN it read, because this screen is on-demand and an
            implied-live one would be a guess rendered as a fact. In the header
            now, beside the count it qualifies: "7 spaces, as of 3s ago" is one
            statement about one read, and splitting it across the top and bottom
            of the screen made it two. */}
        {tree !== null && (
          <button
            type="button" className="spaces-refresh tap" onClick={() => void refresh()}
            aria-label={`Read ${age}s ago — read again`}
          >
            {/* The AGE is shown only once it is worth knowing.
                This screen is on demand, and the original note stands: an
                implied-live one would be a guess rendered as a fact. But a
                counter reading "as of 0s ago" the whole time you are looking at
                a freshly-read screen is noise that says nothing — it announces
                staleness that is not there, right beside the title.
                So under STALE_AFTER_S the control is the glyph alone, which is
                still a full 44px target and still says "you may read again";
                past it the age appears, because then it IS news. The
                `aria-label` carries the number either way, so nothing is lost
                to a screen reader at any age. */}
            {age >= STALE_AFTER_S && <span className="spaces-age">as of {age}s ago </span>}
            ⟳
          </button>
        )}
        {/* §16.7: the `+` that makes a SPACE lives in the header of the screen
            that lists them. Position is what says what it makes, which is why
            it carries no text label.

            This is the ONLY create control on this screen now. The one that
            makes a tab moved to `#/space/<id>`, where it is the last row of
            the list it adds to — a row rather than a glyph, because that
            screen's header has no position that says "a tab in this space". */}
        {canCreate && (
          <CreateSheet
            target={{ kind: "space" }}
            cwds={cwds}
            onChanged={() => void refresh()}
            senders={createSenders}
            navigate={navigate}
          />
        )}
      </header>

      <div className="screen-body">
      {/* This server has no herdr session to read, so there is no tree and
          never will be for this process — `--demo` above all.

          SAID, not errored, and not hidden. The Spaces control used to be
          REMOVED from the header in this case, on the reasoning that "an
          absent control is worse than a working one and far better than a
          broken one" — which was right about the broken part. But navigation
          moved to `TabBar`, and a three-tab bar cannot drop to two: three is
          the floor, and Apple is explicit that a tab must not be hidden when
          its content is unavailable, and that an empty section should explain
          why instead.

          So the objection is answered where it actually lived — the
          destination is no longer broken. `spacesAvailable` is the same
          server-stated capability `canCreate` is gated on; never a demo flag,
          never a hostname, never a device check.

          Gated on `tree === null` as well, deliberately: the capability is
          what the server SAYS, and a tree that actually loaded is a tree
          regardless. Without that half this note would replace a perfectly
          good list whenever the snapshot had not yet mentioned the
          capability — `trackSpaces` leaves `undefined` alone precisely
          because "a frame that does not say is not a frame that denies".

          AN ERROR WINS, which is why it is tested first. "this paddock has no
          herdr session" and "the read failed" are different claims and must
          not look alike — the same rule `App.tsx` states for "no such pane"
          versus "herdr did not answer". Ordered the other way round, a real
          `socket refused` was rendered as a calm note about demo mode, which
          is precisely the swallowed error this repo forbids. Caught by
          `tests/spaces-screen.test.tsx`, not by review. */}
      {error !== null ? (
        <p className="error" role="alert">{error}</p>
      ) : !spacesAvailable && tree === null ? (
        <p className="dash-note">
          This paddock has no herdr session to read, so there are no spaces to show.
        </p>
      ) : null}

      {tree !== null && (
        <ul className="spaces">
          {sortSpaces(tree.spaces).map((s) => (
            <SpaceRow key={s.spaceId} space={s} onChanged={() => void refresh()} senders={senders} />
          ))}
        </ul>
      )}

      </div>
    </main>
  );
}
