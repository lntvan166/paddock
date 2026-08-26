import { plural } from "@web/format";
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
export function Spaces({ onBack, load = fetchSpaceTree, senders, createSenders, navigate }: {
  onBack: () => void;
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
  const { tree, error, refresh } = useSpaceTree(load);
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
    <main className="dash mx-auto max-w-2xl safe-bottom">
      <header className="spaces-head">
        {/* Shared treatment (§16.4): this was the one back control in the
            app not using it. Labelled for its actual destination — the
            dashboard, which is all `onBack` here has ever pointed at. */}
        <button type="button" className="term-back" onClick={onBack} aria-label="Back to agents">
          ‹ Agents
        </button>
        <h2>Spaces</h2>
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

      {error !== null && <p className="error" role="alert">{error}</p>}

      {tree !== null && (
        <ul className="spaces">
          {sortSpaces(tree.spaces).map((s) => (
            <SpaceRow key={s.spaceId} space={s} onChanged={() => void refresh()} senders={senders} />
          ))}
        </ul>
      )}

      {tree !== null && (
        <footer className="spaces-foot">
          <span>{plural(tree.spaces.length, "space")}</span>
          {/* Says WHEN it read, because this screen is on-demand and an
              implied-live one would be a guess rendered as a fact. */}
          <button type="button" onClick={() => void refresh()}>
            as of {Math.max(0, Math.round((now - tree.readAt) / 1000))}s ago ⟳
          </button>
        </footer>
      )}
    </main>
  );
}
