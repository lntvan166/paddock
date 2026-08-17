import { useEffect, useState } from "react";
import { isStale, useStore } from "@web/store";
import { AgentCard } from "@web/components/AgentCard";
import { AgentChip, AgentRow } from "@web/components/AgentRow";
import { AgentDetail } from "@web/components/AgentDetail";
import { ConnectionBanner } from "@web/components/ConnectionBanner";
import { HostHeader } from "@web/components/HostHeader";
import { InstallHint } from "@web/components/InstallHint";
import { groupAgents, SECTION_ORDER, SECTION_TITLES, SectionHeader } from "@web/components/Section";
import { staleAttrs } from "@web/components/staleness";

export function App() {
  const { agents, hostId, connected, lastMessageAt, connect } = useStore();
  const [now, setNow] = useState(() => Date.now());
  const [idleOpen, setIdleOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    connect();
  }, [connect]);

  // Elapsed labels tick locally; the server is not asked for time.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  const groups = groupAgents(agents);
  const stale = isStale({ agents, hostId, connected, lastMessageAt }, now);
  // Re-derived from the live list every render, never cached: if the selected
  // agent is pruned from a snapshot (or reconnects under a new id), the sheet
  // closes itself instead of showing dangling data.
  const openAgent = agents.find((a) => a.agentId === openId) ?? null;

  return (
    <main className="mx-auto max-w-2xl safe-bottom">
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
                      onSelect={() => setOpenId(a.agentId)}
                    />
                  ))
                : open
                  ? list.map((a) => (
                      <AgentRow
                        key={a.agentId} agent={a} now={now}
                        onSelect={() => setOpenId(a.agentId)}
                      />
                    ))
                  : (
                    <div className="flex flex-wrap gap-1.5 px-3 pb-3">
                      {list.map((a) => (
                        <AgentChip key={a.agentId} agent={a} />
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

      {/* Outside the data-stale wrapper for the same reason as ConnectionBanner:
          it is a foreground control surface, not background data, so it must
          never dim along with the list underneath it. */}
      {openAgent && (
        // key={agentId} forces a fresh AgentDetail instance per selected agent.
        // Without it, switching the selection reuses the same component
        // instance, and every field in there — result, reply, busy included —
        // is per-agent state: a reply typed for A, or A's in-flight action
        // resolving with a 409 AFTER the operator has already switched to B,
        // would land on B's sheet under B's header. Resetting those fields in
        // an effect does not stop that late resolution from writing after the
        // switch; only unmounting the old instance (so its setState calls
        // become no-ops) does. Do not replace this with field resets.
        //
        // The key covers IDENTITY only, and must not be widened to include
        // `agent.state`: the defining outcome of a successful answer is the
        // agent leaving `blocked`, so keying on state would unmount the sheet
        // on the very delta the answer caused and destroy the confirmation
        // with it. Attribution across TIME — one agent's prompt A vs. its
        // later prompt B — is handled inside AgentDetail instead, by tagging
        // the reply and the result with the prompt they belong to.
        <AgentDetail key={openAgent.agentId} agent={openAgent} onClose={() => setOpenId(null)} />
      )}
    </main>
  );
}
