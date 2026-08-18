import type { Agent } from "@shared/types";

export function HostHeader({
  hostId, agents, onOpenSettings,
}: {
  hostId: string | null;
  agents: Agent[];
  /** Absent only in tests that don't care about navigation; App.tsx always
   *  supplies it, following the same "component takes a callback, the
   *  hash write lives in App.tsx" convention as AgentCard/AgentRow's
   *  `onSelect`. */
  onOpenSettings?: () => void;
}) {
  const n = (s: Agent["state"]) => agents.filter((a) => a.state === s).length;
  const parts = [
    n("blocked") + n("done") > 0 ? `${n("blocked") + n("done")} needs you` : null,
    n("working") > 0 ? `${n("working")} working` : null,
    n("idle") > 0 ? `${n("idle")} idle` : null,
  ].filter(Boolean);
  return (
    <header
      className="flex items-center justify-between px-3 py-3"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <h1 className="text-[13px] font-semibold">{hostId ?? "connecting…"}</h1>
      <div className="flex items-center gap-2">
        <span className="text-[10px]" style={{ color: "var(--fg-dim)" }}>
          {parts.length ? parts.join(" · ") : "no agents"}
        </span>
        {/* A real button, not a hover-revealed affordance — the only route
            into #/settings, so it must be reachable by touch on the first
            tap, not discoverable only with a mouse. */}
        <button
          type="button"
          className="host-settings-btn tap"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
