import { useEffect, useState } from "react";
import { isStale, useStore } from "@web/store";
import { agentHash } from "@web/route";
import { AgentCard } from "@web/components/AgentCard";
import { AgentChip, AgentRow } from "@web/components/AgentRow";
import { AgentActions } from "@web/components/AgentActions";
import { ConnectionBanner } from "@web/components/ConnectionBanner";
import { HostHeader } from "@web/components/HostHeader";
import { InstallHint } from "@web/components/InstallHint";
import { QuickAdd } from "@web/components/QuickAdd";
import { ReleaseBanner } from "@web/components/ReleaseBanner";
import { groupAgents, SECTION_DOT, SECTION_ORDER, SECTION_TITLES, SectionHeader } from "@web/components/Section";
import { staleAttrs } from "@web/components/staleness";
import { UpdateBar } from "@web/components/UpdateBar";
import { dismissedRelease, dismissRelease, shouldShowRelease } from "@web/release-notice";

/**
 * The agent list — paddock's home screen.
 *
 * Extracted from `App.tsx`'s route dispatch unchanged. It lived inline while
 * exactly one screen rendered at a time; the pager mounts all three at once,
 * so each has to be a component. Nothing about what it renders changed in the
 * move, and `tests/dashboard-extract.test.tsx` exists to keep that true.
 *
 * The state that came with it is the state nothing else was using: the
 * one-second clock and the `stale` reading it feeds, the Idle section's
 * open/closed flag, and the dismissed-release version. `App` keeps what is
 * genuinely app-wide — routing, the connection, the theme, the pane cache.
 *
 * `active` is accepted and ignored for now. It is declared here so the pager
 * can pass it without this file changing again; `use-space-tree` is the first
 * consumer that acts on the equivalent flag.
 */
export function Dashboard({ active = true }: { active?: boolean }) {
  void active;

  const {
    agents, hostId, connected, lastMessageAt, updateAvailable, latestKnown, managedBy,
    spacesAvailable,
  } = useStore();

  const [now, setNow] = useState(() => Date.now());
  // Elapsed labels tick locally; the server is not asked for time.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  // Expanded by default. Collapsed, idle agents render as chips that carry a
  // name and nothing else — no task line, no elapsed time — so the section
  // that usually holds MOST of the agents was also the one showing least
  // about them. Collapsing stays available; it is just no longer the default.
  const [idleOpen, setIdleOpen] = useState(true);

  // Read once on mount, not on every render: localStorage is synchronous, and
  // this sits in a component that re-renders on a ten-second clock.
  const [dismissedVersion, setDismissedVersion] = useState(dismissedRelease);

  const groups = groupAgents(agents);
  const stale = isStale({ connected, lastMessageAt }, now);

  return (
      <main className="screen">
        {/* CHROME. Pinned, in the order a reader needs it: the two messages that
            explain why everything below might be wrong, then the header.

            `ReleaseBanner` and `InstallHint` deliberately did NOT come with
            them, and this moves them: they used to render above the header and
            now render below it, inside the scroller. Pinning every banner would
            hand a phone-sized viewport to a stack of up to three of them, which
            is the opposite of what pinning is for. These two are also the two
            that can wait — a new release and an install hint are not why the
            list in front of you might be wrong. `UpdateBar` and
            `ConnectionBanner` are, so they stay. */}
        <div className="screen-chrome">
          {/* Outside the dimming wrapper below: this is the one message that
              explains why everything else might be wrong, so it must never be
              dimmed as "possibly stale data". */}
          {updateAvailable && <UpdateBar />}
          {stale && (
            <ConnectionBanner connected={connected} lastMessageAt={lastMessageAt} now={now} />
          )}
          {/* The header dims with the data it counts. A SECOND wrapper rather
              than one around both: the two halves are no longer siblings inside
              one element now that the header is chrome. They never nest, so the
              0.55 opacity cannot compound. */}
          <div {...staleAttrs(stale)}>
            <HostHeader hostId={hostId} agents={agents} />
          </div>
        </div>

        <div className="screen-body">
        {/* Stale data dims here — the banners above stay at full opacity so the
            message announcing staleness is never itself hard to read. */}
        <div {...staleAttrs(stale)}>
          {/* Inside the dimming wrapper, unlike UpdateBar: that one explains why
              everything else might be wrong, so it must never read as "possibly
              stale". This one is about the binary on the host, which stale data
              says nothing about. */}
          {shouldShowRelease(latestKnown, dismissedVersion) && (
            <ReleaseBanner
              version={latestKnown!}
              managedBy={managedBy}
              onDismiss={() => {
                dismissRelease(latestKnown!);
                setDismissedVersion(latestKnown);
              }}
            />
          )}
          <InstallHint />

          {SECTION_ORDER.map((key) => {
            const list = groups[key];
            if (list.length === 0) return null;
            const collapsible = key === "idle";
            const open = !collapsible || idleOpen;
            return (
              <section key={key}>
                <SectionHeader
                  title={SECTION_TITLES[key]}
                  count={list.length}
                  dotState={SECTION_DOT[key]}
                  expandable={collapsible}
                  expanded={open}
                  onToggle={() => setIdleOpen((v) => !v)}
                />
                {key === "needs-you" || key === "ready-unseen"
                  ? list.map((a) => (
                      <AgentCard
                        key={a.agentId} agent={a} now={now}
                        onSelect={() => { location.hash = agentHash(a.agentId); }}
                      />
                    ))
                  : open
                    ? list.map((a) => (
                        <AgentRow
                          key={a.agentId} agent={a} now={now}
                          onSelect={() => { location.hash = agentHash(a.agentId); }}
                          // Rename and close, for the agent this row shows.
                          // `onChanged` is a no-op for the same reason the agent
                          // view's is: this screen renders the agent STORE, and
                          // both writes reach it on their own — a rename because
                          // the route asks the supervisor to re-read, a close
                          // because herdr announces `pane_closed`.
                          actions={<AgentActions agent={a} onChanged={() => {}} />}
                        />
                      ))
                    : (
                      <div className="chip-row">
                        {list.map((a) => (
                          <AgentChip
                            key={a.agentId} agent={a}
                            onSelect={() => { location.hash = agentHash(a.agentId); }}
                          />
                        ))}
                      </div>
                    )}
              </section>
            );
          })}

          {agents.length === 0 && !stale && (
            <p className="dash-note">No agents detected.</p>
          )}

        </div>
        {/* `BuildStamp` used to sit here, pinned to the bottom of the viewport.
            It has moved to Settings' Info band, where `InfoSection` already
            reports the SERVER version and the connection facts — see its own
            note about the client/server distinction, which is why the two are
            different rows rather than one.

            Two reasons it left. The tab bar now occupies the bottom of the
            screen, so a version line above it competed with navigation for the
            most reachable strip of a phone; and the dashboard answers "does
            anything need me", to which the bundle's version is never part of
            the answer. It is a diagnostic, and Settings is where the
            diagnostics are. */}
        </div>
        {/* Chrome at the bottom, outside the scroller, so the three destinations
            stay in thumb reach at any scroll position. Counted with `sectionFor`
            here — the one rule — so the badge cannot contradict the header
            sentence above it or the section headings below. */}
        {/* Gated on the SAME capability the Spaces `+` is: with no herdr session
            the create routes 404, so this would be a control that always errors —
            the defect `routes.ts` records against `/ack`'s Dismiss button. A
            capability the server states, never a demo flag and never a device
            check.

            `cwds` is empty here deliberately. The quick picks come from the
            session tree, and the dashboard does not read one — it renders the
            agent store. The sheet's folder field still accepts anything typed,
            and still defaults to herdr's own choice when left blank, which is
            what an empty list leaves in charge. */}
        {spacesAvailable && (
          <QuickAdd
            // A deliberate no-op, like `AgentTerminal`'s rename. Every other
            // caller re-reads the TREE because that is what its screen renders;
            // this screen renders the agent store, and a new pane reaches it on
            // its own — herdr emits `pane_agent_detected`, the supervisor turns
            // that into a delta, and the row appears. There is nothing here to
            // refetch, and calling for a tree nobody displays would be work for
            // its own sake.
            onChanged={() => {}}
          />
        )}
      </main>
  );
}
