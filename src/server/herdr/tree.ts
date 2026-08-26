import type {
  HerdrAgentRaw, HerdrPaneInfo, HerdrSessionSnapshot, HerdrTabInfo,
} from "@shared/herdr-api";
import type { Space, SpaceTree, Tab, TreePane } from "@shared/types";
import { toState } from "@server/herdr/adapter";
import type { HostPath } from "@server/herdr/actions";

export interface TreeOptions {
  /** The operator's home directory, so `cwd` can be tilde-ised before it
   *  leaves the server. Injected rather than read from `process.env` here:
   *  this module is pure and its tests must not depend on the machine. */
  home?: string;
}

/**
 * Shape one `session.snapshot` into the tree the Spaces screen renders.
 *
 * The ONLY module that knows the snapshot's field names — the same
 * containment rule 2 places on `adapter.ts`. It deliberately does not import
 * `state/store.ts` or `ws/hub.ts`: the tree is read on demand and never
 * replicated into paddock's state, so that a browse feature cannot reach the
 * delta path the notifier rides on.
 */
export function toSpaceTree(
  snap: HerdrSessionSnapshot, now: number, opts: TreeOptions = {},
): SpaceTree {
  // agent.list's `name` is the ONLY source of an operator label. pane rows
  // carry a `label`, which is a different field that agent.list does not read
  // — see the design doc §14.3. Keyed by pane_id because that is the identity
  // paddock uses for an agent throughout.
  const named = new Map<string, HerdrAgentRaw>();
  for (const a of snap.agents) named.set(a.pane_id, a);

  const panesByTab = new Map<string, TreePane[]>();
  for (const p of snap.panes) {
    const list = panesByTab.get(p.tab_id) ?? [];
    list.push(toPane(p, named.get(p.pane_id), opts.home));
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

function toPane(p: HerdrPaneInfo, agent: HerdrAgentRaw | undefined, home: string | undefined): TreePane {
  return {
    paneId: p.pane_id,
    harness: p.agent?.trim() || null,
    name: agent?.name?.trim() || null,
    title: (p.terminal_title_stripped ?? p.terminal_title ?? "").trim() || null,
    cwd: tildeise(p.cwd ?? "", home),
    // Null when there is no harness. A shell is not idle: it has no triage
    // state at all, and inventing one would file it under a section it does
    // not belong in.
    state: p.agent ? toState(p.agent_status) : null,
  };
}

/**
 * `/base/operator/work` -> `~/work`.
 *
 * Not cosmetic. A pane with no agent is labelled by its folder (§16.6), and
 * the folder of a home directory IS the username — which this repo's first
 * rule exists to keep out of screens and screenshots. Doing it server-side
 * means the username never crosses the wire at all, rather than being hidden
 * by the client that happens to render it.
 */
function tildeise(cwd: string, home: string | undefined): string {
  if (!home || home === "/" || !cwd) return cwd;
  const h = home.replace(/\/+$/, "");
  if (cwd === h) return "~";
  return cwd.startsWith(`${h}/`) ? `~${cwd.slice(h.length)}` : cwd;
}

/**
 * `~/work` -> `/base/operator/work`, or `null` when the tilde cannot be
 * resolved here. The EXACT inverse of `tildeise` above, and it lives beside it
 * for that reason.
 *
 * The tilde is paddock's own convention, invented here so a username never
 * crosses the wire. It therefore has to be undone here too, because it comes
 * BACK: the create sheet offers the cwds already in the tree as quick picks
 * (§9.3), and every one of them is tilde-ised. Measured on a live herd —
 * `workspace.create {cwd: "~/Documents/…"}` does not expand the tilde and does
 * not refuse it either: the new pane came up in the HOME directory, with
 * nothing anywhere saying the folder the operator picked had been ignored.
 * That is the silent-wrong-outcome class this codebase exists to refuse, so
 * the expansion happens before the value reaches herdr rather than being left
 * to a shell that never sees it.
 *
 * A bare `~` and `~/...` only, and only when there is a home to expand
 * against. Anything that is not ABSOLUTE after that comes back `null` rather
 * than being forwarded, because forwarding is the defect:
 *
 * - `~operator/...` is another user's home on a real shell. paddock knows ONE
 *   home directory, so resolving it against `$HOME` would silently point at a
 *   different account's path — worse than refusing.
 * - `~/...` with `HOME` unset or `/` has nothing to expand against at all.
 * - `./relative`, `relative`, `../up` — whether herdr resolves these against
 *   its OWN process cwd is unmeasured, and the measured answer for the tilde
 *   was "silently, in the wrong folder". Same class of value: a path whose
 *   meaning depends on a working directory paddock cannot see. An earlier
 *   version refused the tilde and forwarded these with a 200, which is the
 *   same defect wearing a different prefix — and it made both this function's
 *   own promise and the route's 400 text false in writing.
 *
 * The rule, stated once: **refuse an unmeasured value when a measured
 * alternative already expresses the same intent; relay when there is none.**
 * An absolute path is that alternative, and every cwd the UI can produce is
 * already one — the quick picks are the tree's own tilde-ised cwds, and free
 * text is the operator's own path — so nothing the operator can do regresses.
 * A refusal they can read beats a folder silently ignored, so the caller gets
 * `null` and turns it into a 400.
 *
 * Returning `HostPath` is the other half of that guarantee: this is the ONLY
 * function that casts into the brand `CreateOpts.cwd` requires, so a cwd
 * cannot reach herdr without passing through here. See `HostPath` in
 * `actions.ts`.
 */
export function expandHome(cwd: string, home: string | undefined): HostPath | null {
  const h = home && home !== "/" ? home.replace(/\/+$/, "") : null;
  let out = cwd;
  if (h !== null) {
    if (cwd === "~") out = h;
    else if (cwd.startsWith("~/")) out = `${h}${cwd.slice(1)}`;
  }
  // ONE gate, and it is the brand's own promise: absolute, or nothing. A value
  // still tilde-prefixed fails it, and so does `./relative`, `relative` and the
  // empty string — every shape whose meaning depends on a working directory
  // paddock cannot see.
  return out.startsWith("/") ? (out as HostPath) : null;
}
