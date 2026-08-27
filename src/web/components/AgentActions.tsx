import { useState } from "react";
import { fetchSpaceTree } from "@web/api";
import { RowActions, type CloseTarget, type RenameTarget, type RowSenders } from "@web/components/RowActions";
import type { Agent, SpaceTree } from "@shared/types";

/**
 * The `⋯` on a dashboard row.
 *
 * A `⋯` rather than a swipe, and that is not a preference. `CLAUDE.md` bans
 * hover-only affordances because they are "invisible on touch"; a swipe is the
 * same failure one step worse, since hover at least reveals itself to a mouse
 * while a swipe has no visual hint at all. `PaneTerminal` also already records
 * a collision with "the browser's back-swipe gesture", which a left-swipe on a
 * row would run straight into. And `⋯` is what tab rows, space rows and the
 * agent view already use for this exact job.
 *
 * WHY THE TREE IS READ HERE. Rename needs only an agent id, which the
 * dashboard has. Close needs the TAB that holds the pane, plus the panes it
 * would take with it, so its consequence line can be counted off real data —
 * §10's rule, and the reason that line can be trusted. An `Agent` carries
 * `workspaceId` but no `tabId`, so that is not knowable from the store.
 *
 * So the tree is read when the menu OPENS, and only then: a request per row on
 * mount would be one per agent on a screen where most menus are never opened.
 * Until it lands — or if it fails — the menu offers rename and no close, which
 * is the honest state rather than a close whose consequence paddock cannot
 * count.
 */
export function AgentActions({ agent, onChanged, senders, load = fetchSpaceTree }: {
  agent: Agent;
  onChanged: () => void;
  senders?: RowSenders;
  /** Injected so a test drives this without a network, as everywhere else. */
  load?: () => Promise<SpaceTree>;
}) {
  const [close, setClose] = useState<CloseTarget | undefined>(undefined);

  const onOpenChange = (open: boolean) => {
    if (!open) return;
    void load()
      .then((tree) => {
        // The tab holding THIS pane. Found by pane id rather than by the
        // agent's `workspaceId`, because a space can hold several tabs and
        // closing the wrong one would take work nobody asked about.
        const tab = tree.spaces
          .flatMap((s) => s.tabs)
          .find((t) => t.panes.some((p) => p.paneId === agent.agentId));
        setClose(tab === undefined
          ? undefined
          : { kind: "tab", id: tab.tabId, panes: tab.panes });
      })
      // Swallowed to `undefined`, which is "no close offered" — NOT a close
      // with an uncounted consequence. A failed read must not become a button
      // that says less than it does.
      .catch(() => setClose(undefined));
  };

  const renames: RenameTarget[] = [
    { kind: "agent", id: agent.agentId, current: agent.name },
  ];

  return (
    <RowActions
      label={agent.name}
      renames={renames}
      close={close}
      onOpenChange={onOpenChange}
      onChanged={onChanged}
      senders={senders}
    />
  );
}
