import type { Agent } from "@shared/types";

export function HostHeader({ hostId, agents }: { hostId: string | null; agents: Agent[] }) {
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
      <span className="text-[10px]" style={{ color: "var(--fg-dim)" }}>
        {parts.length ? parts.join(" · ") : "no agents"}
      </span>
    </header>
  );
}
