import { useCallback, useEffect, useRef, useState } from "react";
import { sectionFor } from "@shared/types";
import { useStore } from "@web/store";
import { fetchPaneOutput, fetchSpaceTree, sendPaneKey, sendPaneText } from "@web/api";
import type { NavKey, SpaceTree, TreePane } from "@shared/types";
import { PaneTerminal, SHELL_MIN_REFRESH_MS } from "@web/components/PaneTerminal";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { paneLabel } from "@web/components/pane-label";
import { Settings } from "@web/components/Settings";
import { Space } from "@web/components/Space";
import { Spaces } from "@web/components/Spaces";
import {
  agentIdFromHash, spaceIdFromHash,
  useAgentRoute, useSettingsRoute, useSpaceRoute, useSpacesRoute,
} from "@web/route";
import { prunePanes } from "@web/pane-cache";
import { BackIcon } from "@web/components/ui/icons";
import { AppShell } from "@web/components/AppShell";
import { Dashboard } from "@web/components/Dashboard";
import { TAB_HASH, type TabKey } from "@web/components/TabBar";
import { readPrefs, themeAttr } from "@web/prefs";
import { closeFor, useNotificationSweep } from "@web/notifications";

export function App() {
  const {
    agents, treeStaleAt, connect,
  } = useStore();
  /**
   * Where the currently open pane was navigated FROM, as the origin's own
   * HASH — read off the real `hashchange`, not guessed from the pane's shape
   * (§16.4).
   *
   * A hash string rather than the `fromSpaces` boolean this replaced. The
   * boolean could say "came from Spaces" but not WHICH space, so every pane
   * opened from a space screen returned to the plural list. Adding a second
   * field for the id would have left two fields free to disagree; one cannot.
   *
   * A ref, and kept on `App`, deliberately: `App` never unmounts, while
   * `AgentTerminal` and `PaneTerminal` do on exactly the transition this has
   * to survive — a shell promoted to an agent unmounts one and mounts the
   * other under the SAME pane id.
   *
   * DECLARED BEFORE THE ROUTE HOOKS, and that is load-bearing. Effects run in
   * declaration order, so registering after `useAgentRoute` put this listener
   * second: the route's `setId` was queued first, and only React 18's batching
   * kept the re-render from landing between the two handlers. A ref write
   * schedules no render of its own, so if that queue ever flushed in between,
   * `backTargetFor` would read the previous pane's origin — or none. Ordering
   * the registration removes the dependency instead of relying on it.
   */
  const paneOriginRef = useRef<{ paneId: string; origin: string } | null>(null);
  useEffect(() => {
    const onHashChange = (e: HashChangeEvent) => {
      const paneId = agentIdFromHash(hashOf(e.newURL));
      // Only a navigation INTO a pane is worth recording.
      if (paneId === null) return;
      paneOriginRef.current = { paneId, origin: hashOf(e.oldURL) };
    };
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  }, []);

  const openId = useAgentRoute();
  const showSettings = useSettingsRoute();
  const openSpaceId = useSpaceRoute();
  const showSpaces = useSpacesRoute();

  useNotificationSweep(agents);
  useEffect(() => {
    // You are looking at it. Whatever the lock screen still says about this
    // agent, it is no longer news.
    if (openId !== null) void closeFor(openId);
  }, [openId]);

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


  /**
   * The back destination for the pane addressed by `paneId`, and the label that
   * goes with it.
   *
   * Applies to BOTH the agent branch and the shell branch below — one rule, not
   * two literals (§16.4's correction).
   *
   * Only a spaces-family origin is honoured. Anything else — the dashboard,
   * Settings, or no origin at all on a cold deep link — goes to the dashboard.
   * That is what "no origin, no Spaces" means, and it is why a notification tap
   * (which fires no `hashchange`) lands back on the list of agents.
   */
  function backTargetFor(paneId: string | null): { hash: string; label: string; ariaLabel: string } {
    const origin = paneId !== null && paneOriginRef.current?.paneId === paneId
      ? paneOriginRef.current.origin
      : null;
    if (origin === null) return { hash: "", label: "Agents", ariaLabel: "Back to agents" };

    if (spaceIdFromHash(origin) !== null) {
      /*
       * Named where the store can name it, generic where it cannot, and NEVER
       * the space id.
       *
       * `App` has no spaces tree to ask — `useTreePane` resolves one pane and
       * carries no space label, and it does not even fetch for a pane the store
       * already holds. What it does have is the agent, and an `Agent` carries
       * `workspaceLabel`. A shell is deliberately absent from `agents` (§3), so
       * for those there is no label here and the word stands in.
       *
       * The DESTINATION is exact in both cases; only the wording differs. The
       * alternative was printing `w9`, which `docs/gotchas.md` bans on screen.
       */
      // `.trim() || null`, not a bare `??`: `adapter.ts` computes
      // `workspaceLabel` with no trim, while `tree.ts` computes `Space.label`
      // as `w.label?.trim() || null` for the SAME field. A workspace labelled
      // `"  "` would otherwise title the space screen `w9` (falsy after
      // `tree.ts`'s own trim) while this control announced `Back to   ` —
      // a blank the trim here makes agree with that.
      const label = agents.find((a) => a.agentId === paneId)?.workspaceLabel?.trim() || null;
      return label !== null
        ? { hash: origin, label: `${label}`, ariaLabel: `Back to ${label}` }
        : { hash: origin, label: "Space", ariaLabel: "Back to this space" };
    }
    if (origin === "#/spaces") {
      return { hash: "#/spaces", label: "Spaces", ariaLabel: "Back to spaces" };
    }
    return { hash: "", label: "Agents", ariaLabel: "Back to agents" };
  }

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


  /**
   * The needs-you count, derived ONCE and passed to the one tab bar.
   *
   * `Spaces` and `Settings` each used to compute this for their own copy of
   * the bar. Two derivations of one number is how two screens come to
   * disagree about it — the defect `HostHeader`'s counts comment records.
   */
  const needsYou = agents.filter((a) => sectionFor(a) === "needs-you").length;

  /**
   * Move between tabs.
   *
   * Still an ordinary hash assignment, which is what the route hooks listen
   * for. It exists as a callback rather than as the anchor's own navigation so
   * that the pager can take it over: `replaceState` fires no `hashchange`, so
   * the switch to it has to arrive together with the state that replaces
   * these hooks, not before.
   */
  const goTab = (key: TabKey) => {
    location.hash = TAB_HASH[key];
  };
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
   * Two situations that look identical from here and are NOT the same:
   *
   * - **A cold deep link.** `#/pane/<id>` tapped from a notification, `agents`
   *   still empty until the websocket snapshot lands, nothing rendered yet.
   * - **A live promotion.** The operator is WATCHING a shell and types
   *   `claude` into it. `hub.sendTreeStale()` goes out immediately while the
   *   agent delta waits on `coalesceMs` plus the supervisor's `refresh()`
   *   round trip, so the tree flips first — reliably, not occasionally.
   *
   * Both must hold rather than fall through to the dashboard: the pane exists,
   * and dumping the operator out of it would be a wrong answer where waiting a
   * beat is a right one. But only the first has nothing on screen to keep.
   * `retainedShell` below is what tells them apart.
   */
  const promoting = openTree.pane !== null && openTree.pane.harness !== null;
  /**
   * The last shell this browser actually PAINTED, and its pane id.
   *
   * A latch, not a cache. `promoting` used to pre-empt the shell branch
   * unconditionally, which meant a live promotion replaced a transcript the
   * operator was reading with a bare "Opening…" for the few hundred
   * milliseconds the delta took to arrive. `PaneTerminal`'s 409 handling
   * exists for exactly this moment and does the right thing — it keeps the
   * transcript and marks the pane stalled — so the hold was overriding a
   * better answer that was already there.
   *
   * Set in an effect rather than during render, and that ordering is safe:
   * the effect can only have missed a paint that never happened, which is
   * precisely the cold-deep-link case that SHOULD get the hold.
   */
  const paintedShell = useRef<TreePane | null>(null);
  useEffect(() => {
    if (openShell !== null) { paintedShell.current = openShell; return; }
    // Navigated elsewhere. The latch is a claim about ONE pane being on
    // screen, so it must not outlive that pane — otherwise coming back to the
    // id later would skip a hold it has earned.
    if (paintedShell.current !== null && paintedShell.current.paneId !== openId) {
      paintedShell.current = null;
    }
  }, [openShell, openId]);
  /**
   * The shell to keep rendering through a promotion: same pane, same key, same
   * `PaneTerminal` instance, so nothing remounts and the transcript survives.
   * The pane route answers 409 from here on, and that path is already written
   * to show the stalled marker OVER the retained screen rather than a banner
   * carrying an internal route name.
   */
  const retainedShell = promoting && paintedShell.current?.paneId === openId
    ? paintedShell.current
    : null;
  const shellToRender = openShell ?? retainedShell;
  /**
   * The read for the open shell.
   *
   * Memoised on the id alone, so a delta that re-renders `App` does not hand
   * `PaneTerminal` a new `load` — which it reads as "ask again", the mechanism
   * `AgentTerminal` uses deliberately when an agent's state moves. Derived
   * from `shellToRender`, not `openShell`: a retained shell is still being
   * polled, and a `load` that threw would look like a dead pane.
   */
  const openShellId = shellToRender?.paneId ?? null;
  const loadPane = useCallback(() => {
    // Unreachable: this is only ever handed to `PaneTerminal`, which is only
    // rendered when the pane resolved. Thrown rather than defaulted to "",
    // because `POST /api/panes//output` would 404 and read as "the pane is
    // gone" — a wrong answer dressed as a real one.
    if (openShellId === null) throw new Error("no pane to read");
    return fetchPaneOutput(openShellId);
  }, [openShellId]);
  /**
   * The shell's own senders (§16.3), memoised on the id for the same reason
   * `loadPane` is: a delta that re-renders `App` for an unrelated agent must
   * not hand `PaneTerminal` a NEW function identity, which it would otherwise
   * have no way to tell apart from "the operator opened a different pane".
   *
   * `pane.send_text` / `pane.send_keys`, not the agent path's `agent.prompt` /
   * `agent.send_keys` — this pane has no harness, so there is no prompt to
   * answer, only a shell to type at.
   */
  const sendShellText = useCallback((text: string, submit: boolean) => {
    // Unreachable, same as `loadPane` above: only ever handed to a mounted
    // `PaneTerminal`, which only exists once the pane resolved.
    if (openShellId === null) throw new Error("no pane to send to");
    // `submit` forwarded, never assumed: the reply box decides whether its own
    // button means "type this" or "run this", and it means the second.
    return sendPaneText(openShellId, text, submit);
  }, [openShellId]);
  const sendShellKey = useCallback((key: NavKey) => {
    if (openShellId === null) throw new Error("no pane to send to");
    return sendPaneKey(openShellId, key);
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
  if (showSettings) {
    return <AppShell tab="settings" needsYou={needsYou} onSelect={goTab}><Settings /></AppShell>;
  }

  // Before `showSpaces` below: belt and braces, not load-bearing.
  // `useSpacesRoute` matches `"#/spaces"` exactly and `spaceIdFromHash`
  // requires the trailing slash, so the two routes can never both be true.
  if (openSpaceId !== null) {
    return (
      <Space
        spaceId={openSpaceId}
        onBack={() => { location.hash = "#/spaces"; }}
        // No `senders`/`createSenders` here: both default to the live
        // clients inside `RowActions`/`CreateSheet` when undefined, exactly
        // as `<Spaces>` below relies on. Passing the same live constants
        // explicitly bought nothing and left a second precedent for the next
        // screen to copy.
        navigate={(hash) => { location.hash = hash; }}
      />
    );
  }

  if (showSpaces) {
    return <AppShell tab="spaces" needsYou={needsYou} onSelect={goTab}><Spaces /></AppShell>;
  }

  if (openAgent) {
    // Back returns to wherever THIS pane was opened from (§16.4) — the
    // dashboard by default, a spaces-family hash only when the real
    // navigation that opened it came from there.
    const back = backTargetFor(openId);
    return (
      <AgentTerminal
        key={openAgent.agentId}
        agent={openAgent}
        onBack={() => { location.hash = back.hash; }}
        backLabel={back.ariaLabel}
      />
    );
  }

  if (shellToRender) {
    // Same origin-aware rule as the agent branch above (§16.4) — NOT a
    // hard-coded `#/spaces`. A shell reached from a space (either level)
    // returns there; one reached cold (a deep link, a reload, a promotion
    // that started cold) has no recorded origin and returns to the
    // dashboard, same as an agent.
    const back = backTargetFor(openId);
    return (
      <PaneTerminal
        // The pane id, exactly as the agent case above — a shell and an agent
        // are one pane at two moments, and typing `claude` into this one turns
        // it into the other under the SAME id. Keying on anything else would
        // make that transition look like a navigation.
        key={shellToRender.paneId}
        paneId={shellToRender.paneId}
        // The SAME label rule the row in Spaces uses (`pane-label.ts`), not a
        // second expression. This read `title ?? name ?? paneId`, which for a
        // pane sitting at a prompt is the prompt — so a shell row read
        // `project` in the list and its header read the operator's own
        // `user@host:~`, which is exactly the disclosure §16.6 removed from
        // the row, and it fed the region's `aria-label` too.
        title={paneLabel(shellToRender)}
        backLabel={back.ariaLabel}
        onBack={() => { location.hash = back.hash; }}
        load={loadPane}
        minIntervalMs={SHELL_MIN_REFRESH_MS}
        sendText={sendShellText}
        sendKey={sendShellKey}
      />
    );
  }

  // The tree read is still in flight, or it has answered "this pane has an
  // agent" before the store has the agent to render — AND there is nothing on
  // screen to keep. Holding here rather than falling through is not cosmetic:
  // the dashboard is a full agent list, and rendering it for the ~20 ms a
  // `session.snapshot` takes makes every tap on a shell pane blink through the
  // screen the operator just left — and in the promotion case it would evict
  // them from a pane that exists.
  //
  // `shellToRender` has already returned above when a painted shell is being
  // promoted, so reaching this line with `promoting` true means nothing was
  // ever drawn for this pane. That is the cold deep link, and it still holds
  // here, and it still never falls through to the dashboard.
  if (openId !== null && (!openTree.resolved || promoting)) {
    return (
      <main className="screen">
        <div className="screen-body">
          <p className="dash-note">Opening…</p>
        </div>
      </main>
    );
  }

  // The tree could not be read, and the id is not an agent: say so instead of
  // showing a dashboard that will never contain this pane. "No such pane" and
  // "herdr did not answer" are different claims and must not look alike.
  if (openId !== null && openTree.error !== null) {
    // The same unclassed `<button>Back</button>` §16.4 found on the Spaces
    // screen, rendered from a different branch — fixed the same way, with
    // the same origin-aware destination as the two panes above.
    const back = backTargetFor(openId);
    return (
      <main className="screen">
        <header className="spaces-head screen-chrome">
          <button
            type="button" className="term-back"
            onClick={() => { location.hash = back.hash; }}
            aria-label={back.ariaLabel}
          >
            <BackIcon className="term-back-glyph" /> {back.label}
          </button>
          <h2>{openId}</h2>
        </header>
        <div className="screen-body">
          <p className="error" role="alert">Could not open this pane: {openTree.error}</p>
        </div>
      </main>
    );
  }

  return (
    // `screen`, not a flowing column: the header carries the counts and the
    // only routes into Spaces and Settings, and scrolling into Idle used to
    // take all three off the viewport. See `.screen, .term` in styles.css.
    <AppShell tab="agents" needsYou={needsYou} onSelect={goTab}>
      <Dashboard />
    </AppShell>
  );
}

/**
 * The `#...` fragment of a full URL, or `""` if it has none.
 *
 * `HashChangeEvent#oldURL`/`newURL` are whole absolute URLs, not bare
 * hashes — this is the one piece of string surgery that turns one into the
 * other, kept in one place so `paneOriginRef`'s effect and any future
 * caller agree on it.
 */
function hashOf(url: string): string {
  const i = url.indexOf("#");
  return i === -1 ? "" : url.slice(i);
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
