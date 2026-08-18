import { useEffect, useState } from "react";
import { isStale, useStore } from "@web/store";
import { AgentCard } from "@web/components/AgentCard";
import { AgentChip, AgentRow } from "@web/components/AgentRow";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { ConnectionBanner } from "@web/components/ConnectionBanner";
import { HostHeader } from "@web/components/HostHeader";
import { InstallHint } from "@web/components/InstallHint";
import { groupAgents, SECTION_ORDER, SECTION_TITLES, SectionHeader } from "@web/components/Section";
import { Settings } from "@web/components/Settings";
import { staleAttrs } from "@web/components/staleness";
import { agentHash, useAgentRoute, useSettingsRoute } from "@web/route";
import { prunePanes } from "@web/pane-cache";
import { UpdateBar } from "@web/components/UpdateBar";

export function App() {
  const { agents, hostId, connected, lastMessageAt, updateAvailable, connect } = useStore();
  const [now, setNow] = useState(() => Date.now());
  // Expanded by default. Collapsed, idle agents render as chips that carry a
  // name and nothing else — no task line, no elapsed time — so the section
  // that usually holds MOST of the agents was also the one showing least
  // about them. Collapsing stays available; it is just no longer the default.
  const [idleOpen, setIdleOpen] = useState(true);
  const openId = useAgentRoute();
  const showSettings = useSettingsRoute();

  useEffect(() => {
    connect();
  }, [connect]);

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
    prunePanes(new Set(agentIds ? agentIds.split("\u0000") : []));
  }, [agentIds]);

  const groups = groupAgents(agents);
  const stale = isStale({ connected, lastMessageAt }, now);
  // Re-derived from the live list every render, never cached: if the selected
  // agent is pruned from a snapshot (or reconnects under a new id), the view
  // falls back to the list instead of showing dangling data. This also makes a
  // stale deep link (a notification for an agent that has since finished and
  // been pruned) land somewhere useful rather than on an empty screen.
  const openAgent = agents.find((a) => a.agentId === openId) ?? null;

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

  if (openAgent) {
    return (
      <AgentTerminal
        key={openAgent.agentId}
        agent={openAgent}
        onBack={() => { location.hash = ""; }}
      />
    );
  }

  return (
    <main className="mx-auto max-w-2xl safe-bottom">
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
        <InstallHint />
        <HostHeader hostId={hostId} agents={agents} />

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
                expandable={collapsible}
                expanded={open}
                onToggle={() => setIdleOpen((v) => !v)}
              />
              {key === "needs-you"
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
    </main>
  );
}
