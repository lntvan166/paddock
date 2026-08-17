import { useEffect, useState } from "react";
import { isStale, useStore } from "@web/store";
import { AgentCard } from "@web/components/AgentCard";
import { AgentChip, AgentRow } from "@web/components/AgentRow";
import { ConnectionBanner } from "@web/components/ConnectionBanner";
import { HostHeader } from "@web/components/HostHeader";
import { InstallHint } from "@web/components/InstallHint";
import { groupAgents, SECTION_ORDER, SECTION_TITLES, SectionHeader } from "@web/components/Section";
import { staleAttrs } from "@web/components/staleness";

export function App() {
  const { agents, hostId, connected, lastMessageAt, connect } = useStore();
  const [now, setNow] = useState(() => Date.now());
  const [idleOpen, setIdleOpen] = useState(false);

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
                ? list.map((a) => <AgentCard key={a.agentId} agent={a} now={now} />)
                : open
                  ? list.map((a) => <AgentRow key={a.agentId} agent={a} now={now} />)
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
    </main>
  );
}
