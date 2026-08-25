import type { TreePane } from "@shared/types";

/**
 * What to call a pane — the ONE rule, for every surface that shows one.
 *
 * It lived as a private function inside `SpaceRow.tsx` while `App.tsx` reached
 * for `title ?? name ?? paneId` on its own, so the same pane read `project` in
 * the list and `operator@dev-box:~` in the header it opened — the exact
 * hostname disclosure §16.6 removed from the row, one screen deeper, and
 * feeding an `aria-label` as well. A labelling rule with two consumers belongs
 * in one function, which is the argument this round already accepted for
 * `Keypad`.
 */

/**
 * What to call a pane that has no agent.
 *
 * NOT its terminal title: for a pane sitting at a prompt that title IS the
 * prompt (`operator@dev-box:~`), which labels nothing and puts a hostname on
 * screen — on a screen the operator may hand to someone or screenshot. The
 * folder answers the question an unnamed pane actually raises — where is it —
 * and `cwd` arrives already tilde-ised (§16.6).
 */
export function shellLabel(p: TreePane): string {
  const trimmed = p.cwd.replace(/\/+$/, "");
  const seg = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return seg || "shell";
}

/**
 * A pane's own identity, or `null` when it has nothing to say for itself.
 *
 * `name` first: it is the only operator-set label a pane has (§14.3), and on
 * an agent pane it is what `agent.list` reports. Then the split that §16.6
 * turns on — a pane with NO harness is labelled by its folder, never by its
 * terminal title; a pane WITH one falls back to that title, which for an agent
 * is a real title rather than a shell prompt.
 *
 * Nullable on purpose, and that is the reason this is not folded into
 * `paneLabel` below. A merged space row shows this only when it says something
 * the space's own label does not, so "there is nothing to add" has to be
 * expressible — filling it with the pane id would put `w3:p1` on every row.
 */
export function paneIdentity(p: TreePane): string | null {
  return p.name ?? (p.harness === null ? shellLabel(p) : p.title);
}

/**
 * The label for a surface that MUST render something: a pane row, a terminal
 * header, an accessible name. The id is the last resort and never a guess.
 */
export function paneLabel(p: TreePane): string {
  return paneIdentity(p) ?? p.paneId;
}
