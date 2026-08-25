import type {
  HerdrAgentRaw, HerdrPaneInfo, HerdrSessionSnapshot, HerdrTabInfo,
} from "@shared/herdr-api";
import type { Space, SpaceTree, Tab, TreePane } from "@shared/types";
import { toState } from "@server/herdr/adapter";

/**
 * Shape one `session.snapshot` into the tree the Spaces screen renders.
 *
 * The ONLY module that knows the snapshot's field names — the same
 * containment rule 2 places on `adapter.ts`. It deliberately does not import
 * `state/store.ts` or `ws/hub.ts`: the tree is read on demand and never
 * replicated into paddock's state, so that a browse feature cannot reach the
 * delta path the notifier rides on.
 */
export function toSpaceTree(snap: HerdrSessionSnapshot, now: number): SpaceTree {
  // agent.list's `name` is the ONLY source of an operator label. pane rows
  // carry a `label`, which is a different field that agent.list does not read
  // — see the design doc §14.3. Keyed by pane_id because that is the identity
  // paddock uses for an agent throughout.
  const named = new Map<string, HerdrAgentRaw>();
  for (const a of snap.agents) named.set(a.pane_id, a);

  const panesByTab = new Map<string, TreePane[]>();
  for (const p of snap.panes) {
    const list = panesByTab.get(p.tab_id) ?? [];
    list.push(toPane(p, named.get(p.pane_id)));
    panesByTab.set(p.tab_id, list);
  }

  const tabsBySpace = new Map<string, Tab[]>();
  for (const t of snap.tabs) {
    const list = tabsBySpace.get(t.workspace_id) ?? [];
    list.push({ tabId: t.tab_id, label: tabLabel(t), panes: panesByTab.get(t.tab_id) ?? [] });
    tabsBySpace.set(t.workspace_id, list);
  }

  // Driven from `snap.workspaces`, so a pane referencing a workspace the
  // snapshot does not list is dropped rather than inventing a space with no
  // label, no counts and no honest identity.
  const spaces: Space[] = snap.workspaces.map((w) => ({
    spaceId: w.workspace_id,
    label: w.label?.trim() || null,
    tabCount: w.tab_count,
    paneCount: w.pane_count,
    tabs: tabsBySpace.get(w.workspace_id) ?? [],
  }));

  return { spaces, readAt: now };
}

/**
 * herdr reports an unnamed tab's label as its NUMBER, as a string ("1").
 * Normalised to null here, and nowhere else, so no consumer has to know that
 * a tab called "1" is probably a tab called nothing.
 */
function tabLabel(t: HerdrTabInfo): string | null {
  const label = t.label?.trim();
  if (!label) return null;
  return label === String(t.number) ? null : label;
}

function toPane(p: HerdrPaneInfo, agent: HerdrAgentRaw | undefined): TreePane {
  return {
    paneId: p.pane_id,
    harness: p.agent?.trim() || null,
    name: agent?.name?.trim() || null,
    title: (p.terminal_title_stripped ?? p.terminal_title ?? "").trim() || null,
    cwd: p.cwd ?? "",
    // Null when there is no harness. A shell is not idle: it has no triage
    // state at all, and inventing one would file it under a section it does
    // not belong in.
    state: p.agent ? toState(p.agent_status) : null,
  };
}
