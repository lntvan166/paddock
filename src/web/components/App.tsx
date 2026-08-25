import { useCallback, useEffect, useState } from "react";
import { isStale, useStore } from "@web/store";
import { fetchPaneOutput, fetchSpaceTree } from "@web/api";
import type { SpaceTree, TreePane } from "@shared/types";
import { PaneTerminal, SHELL_MIN_REFRESH_MS } from "@web/components/PaneTerminal";
import { AgentCard } from "@web/components/AgentCard";
import { AgentChip, AgentRow } from "@web/components/AgentRow";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { BuildStamp } from "@web/components/BuildStamp";
import { ConnectionBanner } from "@web/components/ConnectionBanner";
import { HostHeader } from "@web/components/HostHeader";
import { InstallHint } from "@web/components/InstallHint";
import { groupAgents, SECTION_DOT, SECTION_ORDER, SECTION_TITLES, SectionHeader } from "@web/components/Section";
import { Settings } from "@web/components/Settings";
import { Spaces } from "@web/components/Spaces";
import { staleAttrs } from "@web/components/staleness";
import { agentHash, useAgentRoute, useSettingsRoute, useSpacesRoute } from "@web/route";
import { prunePanes } from "@web/pane-cache";
import { UpdateBar } from "@web/components/UpdateBar";
import { ReleaseBanner } from "@web/components/ReleaseBanner";
import { dismissedRelease, dismissRelease, shouldShowRelease } from "@web/release-notice";
import { readPrefs, themeAttr } from "@web/prefs";

export function App() {
  const {
    agents, hostId, connected, lastMessageAt, updateAvailable, latestKnown, managedBy,
    treeStaleAt, connect,
  } = useStore();
  const [now, setNow] = useState(() => Date.now());
  // Expanded by default. Collapsed, idle agents render as chips that carry a
  // name and nothing else — no task line, no elapsed time — so the section
  // that usually holds MOST of the agents was also the one showing least
  // about them. Collapsing stays available; it is just no longer the default.
  const [idleOpen, setIdleOpen] = useState(true);
  // Read once on mount, not on every render: localStorage is synchronous, and
  // this sits in a component that re-renders on a one-second clock.
  const [dismissedVersion, setDismissedVersion] = useState(dismissedRelease);
  const openId = useAgentRoute();
  const showSettings = useSettingsRoute();
  const showSpaces = useSpacesRoute();

  useEffect(() => {
    connect();
  }, [connect]);

  // Establishes the theme on a cold page load, before Settings has ever been
  // opened. This does NOT cover a live change: `main.tsx` mounts `App` once,
  // unkeyed, for the life of the page — `App` itself never unmounts, only its
  // CHILDREN swap between `<Settings>`, `<AgentTerminal>`, and the agent list
  // at this same early-return tree position. So `[]` deps here fire exactly
  // once and would otherwise leave a theme switch inert until a full reload.
  // `Settings.tsx`'s `setPref` applies `themeAttr` directly for that reason —
  // the two are complementary, not redundant.
  useEffect(() => {
    const attr = themeAttr(readPrefs().theme);
    if (attr === null) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = attr;
  }, []);

  // Elapsed labels tick locally; the server is not asked for time.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  /**
   * Evict cached screens and scrollback for agents that no longer exist.
   *
   * Driven from here because this is where the live agent list is. `store.ts`
   * already prunes agents on `removedIds`, but nothing told the render caches,
   * so they grew by one entry per agent EVER opened rather than per agent that
   * exists — up to ~146 KB of reconstructed scrollback each, reclaimable only
   * by reloading the page.
   *
   * Keyed on the ids rather than the array so this runs when the SET of agents
   * changes, not on every delta that merely updates one agent's state.
   */
  const agentIds = agents.map((a) => a.agentId).sort().join("\u0000");
  useEffect(() => {
    const live = new Set(agentIds ? agentIds.split("\u0000") : []);
    // The pane on screen is kept whatever the agent list says. A shell pane is
    // never IN that list — that is the whole point of §3 — so pruning by
    // agents alone would evict the screen of the very pane the operator is
    // reading, on the next delta that changes some other agent.
    if (openId !== null) live.add(openId);
    prunePanes(live);
  }, [agentIds, openId]);

  const groups = groupAgents(agents);
  const stale = isStale({ connected, lastMessageAt }, now);
  // Re-derived from the live list every render, never cached: if the selected
  // agent is pruned from a snapshot (or reconnects under a new id), the view
  // falls back to the list instead of showing dangling data. This also makes a
  // stale deep link (a notification for an agent that has since finished and
  // been pruned) land somewhere useful rather than on an empty screen.
  const openAgent = agents.find((a) => a.agentId === openId) ?? null;
  // A shell pane is deliberately absent from `agents` (§3), so the lookup above
  // would bounce it straight back to a dashboard that can never show it. The
  // tree is the authority for panes the store does not hold — asked only on
  // that miss, so an agent pane and the dashboard itself cost nothing extra.
  const openTree = useTreePane(openAgent === null ? openId : null, treeStaleAt);
  /**
   * A tree-resolved pane the terminal may open as a SHELL.
   *
   * `harness` is the only discriminator between the two cases (see
   * `TreePane` in the shared contract), and consulting it is not a formality.
   * The tree and the store answer at different times: on a cold deep link —
   * `#/pane/<id>` tapped from a notification — `agents` is empty until the
   * websocket snapshot lands, so the tree can resolve an AGENT pane first. A
   * `PaneTerminal` mounted on it would open the pane route, take its 409, and
   * put an internal route name on the operator's screen until the snapshot
   * arrived. So a pane with a harness is not a shell, however early it is
   * seen; `promoting` below holds the view until the store catches up.
   */
  const openShell = openTree.pane !== null && openTree.pane.harness === null
    ? openTree.pane
    : null;
  /**
   * The tree says this pane has an agent and the store does not have it yet.
   *
   * Two situations, one answer: the cold-deep-link race above, and a live
   * promotion (a shell someone typed `claude` into, whose `pane.agent_detected`
   * reached the tree before the delta reached the store). Both resolve
   * themselves within one delta, and both must HOLD rather than fall through
   * to the dashboard — the pane exists, and dumping the operator out of it
   * would be a wrong answer where waiting a beat is a right one.
   */
  const promoting = openTree.pane !== null && openTree.pane.harness !== null;
  /**
   * The read for the open shell.
   *
   * Memoised on the id alone, so a delta that re-renders `App` does not hand
   * `PaneTerminal` a new `load` — which it reads as "ask again", the mechanism
   * `AgentTerminal` uses deliberately when an agent's state moves.
   */
  const openShellId = openShell?.paneId ?? null;
  const loadPane = useCallback(() => {
    // Unreachable: this is only ever handed to `PaneTerminal`, which is only
    // rendered when the pane resolved. Thrown rather than defaulted to "",
    // because `POST /api/panes//output` would 404 and read as "the pane is
    // gone" — a wrong answer dressed as a real one.
    if (openShellId === null) throw new Error("no pane to read");
    return fetchPaneOutput(openShellId);
  }, [openShellId]);

  // A full screen, not an overlay. The terminal needs every row it can get on
  // a phone, and a sheet over a dimmed list spends a third of the viewport
  // re-showing a list the operator has already left.
  //
  // key={agentId} forces a fresh AgentTerminal per agent. Without it, React
  // reuses the instance across a hash change and every per-agent field —
  // output, reply, busy, feedback — carries over: a reply typed for A, or A's
  // in-flight key resolving AFTER the operator navigated to B, would land on
  // B's screen. Resetting fields in an effect cannot stop that late write;
  // only unmounting the old instance can.
  if (showSettings) return <Settings onBack={() => { location.hash = ""; }} />;

  if (showSpaces) return <Spaces onBack={() => { location.hash = ""; }} />;

  if (openAgent) {
    return (
      <AgentTerminal
        key={openAgent.agentId}
        agent={openAgent}
        onBack={() => { location.hash = ""; }}
      />
    );
  }

  if (openShell) {
    return (
      <PaneTerminal
        // The pane id, exactly as the agent case above — a shell and an agent
        // are one pane at two moments, and typing `claude` into this one turns
        // it into the other under the SAME id. Keying on anything else would
        // make that transition look like a navigation.
        key={openShell.paneId}
        paneId={openShell.paneId}
        // `title` before `name`, the reverse of a row in Spaces: a pane with
        // no agent has no name, and the terminal title is the only label it
        // has ever had. The id is the last resort and never a guess.
        title={openShell.title ?? openShell.name ?? openShell.paneId}
        // Back to Spaces, not to the dashboard: the dashboard lists agents,
        // and this pane is not one — sending the operator there would be a
        // door onto a screen that cannot show what they just left.
        backLabel="Back to spaces"
        onBack={() => { location.hash = "#/spaces"; }}
        load={loadPane}
        minIntervalMs={SHELL_MIN_REFRESH_MS}
      />
    );
  }

  // The tree read is still in flight, or it has answered "this pane has an
  // agent" before the store has the agent to render. Holding here rather than
  // falling through is not cosmetic: the dashboard is a full agent list, and
  // rendering it for the ~20 ms a `session.snapshot` takes makes every tap on
  // a shell pane blink through the screen the operator just left — and in the
  // promotion case it would evict them from a pane that exists.
  if (openId !== null && (!openTree.resolved || promoting)) {
    return (
      <main className="dash mx-auto max-w-2xl safe-bottom">
        <p className="px-3 py-6 text-[11px]" style={{ color: "var(--fg-dim)" }}>Opening…</p>
      </main>
    );
  }

  // The tree could not be read, and the id is not an agent: say so instead of
  // showing a dashboard that will never contain this pane. "No such pane" and
  // "herdr did not answer" are different claims and must not look alike.
  if (openId !== null && openTree.error !== null) {
    return (
      <main className="dash mx-auto max-w-2xl safe-bottom">
        <header className="spaces-head">
          <button type="button" onClick={() => { location.hash = "#/spaces"; }}>Back</button>
          <h2>{openId}</h2>
        </header>
        <p className="error" role="alert">Could not open this pane: {openTree.error}</p>
      </main>
    );
  }

  return (
    <main className="dash mx-auto max-w-2xl safe-bottom">
      {/* Shown ABOVE the staleness banner and outside the dimming wrapper: this
          is the one message that explains why everything else might be wrong,
          so it must never be dimmed as "possibly stale data". */}
      {updateAvailable && <UpdateBar />}
      {stale && (
        <ConnectionBanner connected={connected} lastMessageAt={lastMessageAt} now={now} />
      )}
      {/* Stale data dims here — the banner above stays at full opacity so the
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
        <HostHeader
          hostId={hostId} agents={agents}
          onOpenSettings={() => { location.hash = "#/settings"; }}
          onOpenSpaces={() => { location.hash = "#/spaces"; }}
        />

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
                      />
                    ))
                  : (
                    <div className="flex flex-wrap gap-1.5 px-3 pb-3">
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
          <p className="px-3 py-6 text-[11px]" style={{ color: "var(--fg-dim)" }}>
            No agents detected.
          </p>
        )}

      </div>
      {/* OUTSIDE the dimming wrapper, like UpdateBar: which version this
          bundle is stays true when the herdr link goes quiet, so dimming it
          would claim otherwise. */}
      <BuildStamp />
    </main>
  );
}

/**
 * The tree entry for a pane the store does not hold.
 *
 * A shell pane is deliberately absent from `agents` (§3) — that absence is
 * what makes `POST /api/panes/:id/output` a separate route at all — so
 * resolving `#/pane/<id>` against the agent list alone would bounce every
 * shell straight back to the dashboard. The session tree is the only authority
 * for those panes, and it is fetched ONLY when the id misses `agents`: pass
 * `null` for `paneId` and nothing is asked for.
 *
 * Refetched when the server says the tree moved (`tree-stale`). That is also
 * how a shell which has just become an agent is noticed — although in practice
 * the store's own delta gets there first, and the moment it does the caller's
 * agent lookup wins and this hook goes quiet again.
 *
 * A tree that cannot be read leaves the answer UNKNOWN and carries the reason.
 * "No such pane" and "herdr did not answer" are different claims, and
 * rendering the second as the first would evict the operator from a pane that
 * exists, with nothing on screen to say why.
 */
function useTreePane(
  paneId: string | null,
  treeStaleAt: number,
  load: () => Promise<SpaceTree> = fetchSpaceTree,
): { pane: TreePane | null; error: string | null; resolved: boolean } {
  const [held, setHeld] = useState<
    { id: string; pane: TreePane | null; error: string | null } | null
  >(null);

  useEffect(() => {
    if (paneId === null) { setHeld(null); return; }
    let live = true;
    void load()
      .then((tree) => {
        if (!live) return;
        const pane = tree.spaces
          .flatMap((s) => s.tabs)
          .flatMap((t) => t.panes)
          .find((p) => p.paneId === paneId) ?? null;
        setHeld({ id: paneId, pane, error: null });
      })
      .catch((err) => {
        // Not swallowed, and not turned into "no such pane": the caller
        // renders this where the pane would have been.
        if (live) {
          setHeld({
            id: paneId, pane: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => { live = false; };
  }, [paneId, treeStaleAt, load]);

  // Guarded on the id, so an answer that arrives for a pane the operator has
  // already navigated away from never renders as this one's.
  if (paneId === null || held === null || held.id !== paneId) {
    return { pane: null, error: null, resolved: paneId === null };
  }
  return { pane: held.pane, error: held.error, resolved: true };
}
