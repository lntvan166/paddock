import type { CoreListResult, CoreTerminal } from "@shared/herdr-core-api";
import { coreId } from "@shared/origin";
import type { Space, SpaceTree, Tab, TreePane } from "@shared/types";
import { tildeise } from "@server/herdr/tree";
import { spaceLabel, toHarness, toState } from "./adapter";
import type { CoreClient } from "./socket";

/**
 * The Herdr app's spaces, tabs and panes, in the shape the Spaces screen
 * renders — the herdr-core half of `herdr/tree.ts`.
 *
 * Membership comes from the TERMINALS: every terminal the app shows carries
 * `herdr.space=<id>` and `herdr.tab=<id>`, and those ids ARE the layout
 * document's ids (probe step 5b). Names and order come from the `herdr-app`
 * layout document when it has the measured shape. When it does not — the app
 * never ran, a version changed the shape, the read failed — paddock names
 * spaces and tabs the way the app does for an unnamed one, and still shows
 * every labelled terminal. An unreadable layout costs names, never spaces.
 *
 * Read only. The layout document is the app's; paddock never writes it.
 */

const SPACE = "herdr.space";
const TAB = "herdr.tab";

/** The measured layout, narrowed. Anything else is "unreadable". */
interface LayoutTab { id: string; name: string; root?: unknown }
interface LayoutSpace { id: string; name: string; folder?: string; tabs: LayoutTab[] }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The layout's spaces, or null when ANY part of the shape differs from what
 * the probe recorded. All or nothing: half-trusting a document whose shape
 * moved would put a name on the wrong space.
 */
function readLayout(layout: unknown): LayoutSpace[] | null {
  if (!isObj(layout) || !Array.isArray(layout.spaces)) return null;
  const out: LayoutSpace[] = [];
  for (const s of layout.spaces) {
    if (!isObj(s) || typeof s.id !== "string" || typeof s.name !== "string" || !Array.isArray(s.tabs)) return null;
    if (s.folder !== undefined && typeof s.folder !== "string") return null;
    const tabs: LayoutTab[] = [];
    for (const t of s.tabs) {
      if (!isObj(t) || typeof t.id !== "string" || typeof t.name !== "string") return null;
      tabs.push({ id: t.id, name: t.name, root: t.root });
    }
    out.push({ id: s.id, name: s.name, folder: s.folder as string | undefined, tabs });
  }
  return out;
}

/**
 * Terminal addresses in a tab's split tree, in reading order. Walked
 * generically — any node with `children` — because only `row` was measured
 * and a vertical split is assumed to nest the same way.
 */
function leafOrder(node: unknown, out: string[] = []): string[] {
  if (!isObj(node)) return out;
  if (Array.isArray(node.children)) for (const c of node.children) leafOrder(c, out);
  const content = node.content;
  if (isObj(content) && typeof content.terminal === "string") out.push(content.terminal);
  return out;
}

/** Last path segment of an already tilde-ised folder; `~` for home or none. */
function folderName(folder: string): string {
  const name = folder.replace(/\/+$/, "").split("/").pop() ?? "";
  return name === "" ? "~" : name;
}

/**
 * The app's rule for an unnamed space: its own derived name where the app has
 * written one (the `where` label it puts on terminals: "api / 1"), else the
 * folder, else `~`. A space's name, never an agent's — agents are never
 * labelled from a folder.
 */
function derivedSpaceName(terms: CoreTerminal[], folder: string | undefined, home: string | undefined): string {
  for (const t of terms) {
    const where = spaceLabel(t.labels);
    if (where) return where;
  }
  const dir = folder ?? terms[0]?.cwd ?? "";
  return dir === "" ? "~" : folderName(tildeise(dir, home));
}

function toPane(t: CoreTerminal, home: string | undefined): TreePane {
  const status = t.status;
  return {
    paneId: coreId(t.address),
    // A terminal that has reported a status is an agent; one that never did
    // is a shell, with no harness and no state (never "idle").
    harness: status ? (toHarness(status.app) || t.template || t.argv[0] || "agent") : null,
    name: status ? (t.name?.trim() || null) : null,
    title: t.title?.trim() || null,
    cwd: tildeise(t.cwd, home),
    state: status ? toState(status.state) : null,
  };
}

/** Group in first-seen order: a Map keeps insertion order. */
function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k) ?? [];
    list.push(it);
    m.set(k, list);
  }
  return m;
}

/** `wanted` first, in its order, then every remaining key in its own order. */
function ordered<T>(groups: Map<string, T>, wanted: string[]): string[] {
  const head = wanted.filter((k) => groups.has(k));
  return [...head, ...[...groups.keys()].filter((k) => !head.includes(k))];
}

export function toCoreSpaceTree(terminals: CoreTerminal[], layout: unknown, home: string | undefined): Space[] {
  const labelled = terminals
    .filter((t) => t.state === "live" && !!t.labels[SPACE] && !!t.labels[TAB])
    .sort((a, b) => a.created_ms - b.created_ms);
  const doc = readLayout(layout);
  const docSpaces = new Map((doc ?? []).map((s) => [s.id, s]));

  const bySpace = groupBy(labelled, (t) => t.labels[SPACE]!);
  return ordered(bySpace, (doc ?? []).map((s) => s.id)).map((spaceRaw) => {
    const terms = bySpace.get(spaceRaw)!;
    const ds = docSpaces.get(spaceRaw);
    const docTabs = new Map((ds?.tabs ?? []).map((t) => [t.id, t]));
    const byTab = groupBy(terms, (t) => t.labels[TAB]!);

    const tabs: Tab[] = ordered(byTab, (ds?.tabs ?? []).map((t) => t.id)).map((tabRaw) => {
      const dt = docTabs.get(tabRaw);
      const byAddr = groupBy(byTab.get(tabRaw)!, (t) => t.address);
      return {
        tabId: coreId(tabRaw),
        // Null when unnamed: the app calls it by its place, and the screen
        // already falls back to the tab's first pane, as for terminal herdr.
        label: dt?.name.trim() || null,
        panes: ordered(byAddr, leafOrder(dt?.root)).map((a) => toPane(byAddr.get(a)![0]!, home)),
      };
    });

    return {
      spaceId: coreId(spaceRaw),
      label: ds?.name.trim() || derivedSpaceName(terms, ds?.folder, home),
      origin: "core" as const,
      tabCount: tabs.length,
      paneCount: terms.length,
      tabs,
    };
  });
}

/** Terminal herdr's spaces first, then the app's. */
export function mergeTrees(herdr: SpaceTree | null, core: Space[] | null, now: number): SpaceTree {
  if (!core || core.length === 0) return herdr ?? { spaces: [], readAt: now };
  return { spaces: [...(herdr?.spaces ?? []), ...core], readAt: herdr?.readAt ?? now };
}

/** Each distinct reason said once at INFO, not on every Spaces refresh. */
const said = new Set<string>();
function sayOnce(msg: string): void {
  if (said.has(msg)) return;
  said.add(msg);
  console.info(msg);
}

/**
 * Read the app's spaces off a live core. A failed `terminal.list` is said and
 * shows no app spaces (terminal herdr's tree must not fail with it); a failed
 * layout read is said and falls back to derived names.
 */
export async function readCoreSpaces(client: Pick<CoreClient, "request">, home: string | undefined): Promise<Space[] | null> {
  const [list, doc] = await Promise.allSettled([
    client.request<CoreListResult>("terminal.list", {}),
    client.request<{ version: number; value: unknown }>("doc.get", { name: "herdr-app" }),
  ]);
  if (list.status === "rejected") {
    sayOnce(`herdr-core: could not list terminals for the Spaces screen (${(list.reason as Error).message}); app spaces hidden`);
    return null;
  }
  let layout: unknown;
  if (doc.status === "rejected") {
    sayOnce(`herdr-core: no herdr-app layout (${(doc.reason as Error).message}); naming app spaces by folder`);
  } else {
    layout = doc.value?.value;
    if (readLayout(layout) === null) sayOnce("herdr-core: the herdr-app layout has an unknown shape; naming app spaces by folder");
  }
  return toCoreSpaceTree(list.value.terminals, layout, home);
}
