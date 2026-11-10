/**
 * Adding the paddock mod to a Herdr app layout (`layouts/<name>.json`): a
 * toggle button beside the tab bar and a hidden right-hand panel, the way the
 * skillshare layout carries its own. A pure function over the layout tree, so
 * the cases are tested without an app.
 *
 * Herdr's layout model (the app's AGENTS.md): a tree of `row`, `column`,
 * `stack` and `block` nodes; a block's `content` is a mod, a terminal or
 * `{tab: "active"}` (the shown tab's panes). Node ids are what
 * `layout.toggle {id}` acts on, so the panel's id is fixed: the mod's toggle
 * looks for exactly `paddock-panel`.
 */

export const PANEL_ID = "paddock-panel";
export const TOGGLE_ID = "paddock-toggle";

/** Herdr's own layouts are replaced on every start: edits there do not stick. */
export const SHIPPED_LAYOUTS = new Set(["main", "terminals", "win98"]);

export interface LayoutNode {
  id?: string;
  type?: string;
  content?: { mod?: string; tab?: string; props?: Record<string, unknown> } & Record<string, unknown>;
  children?: LayoutNode[];
  size?: unknown;
  hidden?: boolean;
  [k: string]: unknown;
}

export type AddResult =
  | { ok: true; tree: LayoutNode; changed: boolean }
  | { ok: false; reason: string };

/** Each node with its parent, depth first. */
function* walk(node: LayoutNode, parent: LayoutNode | null = null): Generator<[LayoutNode, LayoutNode | null]> {
  yield [node, parent];
  for (const c of node.children ?? []) yield* walk(c, node);
}

const TAB_BAR_MODS = new Set(["tabs", "better-tabs", "terminals-bar"]);

/**
 * Put `node` beside `target`, inside a row: after it in its row, or, when its
 * parent stacks children vertically, by turning `target`'s slot into a row of
 * the two (the row takes `target`'s size; `target` fills what is left).
 */
function besideInRow(parent: LayoutNode, target: LayoutNode, node: LayoutNode, rowId: string): void {
  const kids = parent.children!;
  const at = kids.indexOf(target);
  if (parent.type === "row") {
    kids.splice(at + 1, 0, node);
    return;
  }
  const { size } = target;
  const filled: LayoutNode = { ...target, size: { weight: 1 } };
  kids[at] = { id: rowId, type: "row", ...(size !== undefined ? { size } : {}), children: [filled, node] };
}

export function addPaddock(input: LayoutNode): AddResult {
  const tree = structuredClone(input);
  const ids = new Set([...walk(tree)].map(([n]) => n.id).filter(Boolean));
  if (ids.has(PANEL_ID) && ids.has(TOGGLE_ID)) return { ok: true, tree, changed: false };
  if (ids.has(PANEL_ID) || ids.has(TOGGLE_ID)) {
    return { ok: false, reason: `the layout has only one of ${PANEL_ID} and ${TOGGLE_ID}; remove it and try again` };
  }

  const nodes = [...walk(tree)];
  const tabs = nodes.find(([n]) => n.type === "block" && TAB_BAR_MODS.has(String(n.content?.mod)));
  const work = nodes.find(([n]) => n.type === "block" && n.content?.tab === "active");
  if (!work || !work[1]) return { ok: false, reason: "no {\"tab\": \"active\"} block to put the panel beside" };
  if (!tabs || !tabs[1]) return { ok: false, reason: "no tab bar block (tabs, better-tabs) to put the button beside" };

  const free = (base: string) => { let id = base, i = 2; while (ids.has(id)) id = `${base}-${i++}`; ids.add(id); return id; };

  besideInRow(tabs[1], tabs[0], {
    id: TOGGLE_ID, type: "block", size: { px: 116 },
    content: { mod: "paddock", props: { role: "toggle" } },
  }, free("paddock-tabs-row"));

  besideInRow(work[1], work[0], {
    id: PANEL_ID, type: "column", size: { px: 400 }, hidden: true,
    children: [{ id: free("paddock"), type: "block", content: { mod: "paddock" } }],
  }, free("paddock-work-row"));

  return { ok: true, tree, changed: true };
}
