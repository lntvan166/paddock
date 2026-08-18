import type { Agent } from "@shared/types";
import { Mark } from "@web/components/Mark";

/**
 * The host label is only worth screen space when it distinguishes something.
 *
 * `PADDOCK_HOST_ID` defaults to `local` (see `.env.example`), so on a
 * single-host install the header was spending its most prominent line saying
 * "local" — true, and of no use to anyone. An operator who has set a real
 * name, which is what multi-host will need, still sees it.
 */
const DEFAULT_HOST_ID = "local";

export function HostHeader({
  hostId, agents, onOpenSettings,
}: {
  hostId: string | null;
  agents: Agent[];
  /**
   * REQUIRED, not optional. This is the only route into `#/settings`, and
   * this branch already lost that entry point once. Optional made the
   * callback's absence a type-checked non-event: a render that forgot to pass
   * it compiled, and the gear silently did nothing. Tests that do not care
   * about navigation pass `() => {}` — one explicit character of noise, in
   * exchange for the compiler catching a dropped entry point.
   *
   * Follows the same "component takes a callback, the hash write lives in
   * App.tsx" convention as AgentCard/AgentRow's `onSelect`.
   */
  onOpenSettings: () => void;
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
      <h1 className="flex items-center gap-1.5 text-[13px] font-semibold">
        <Mark size={16} />
        paddock
      </h1>
      <div className="flex items-center gap-2">
        {/* The host label, demoted from the title but not dropped — see
            DEFAULT_HOST_ID above. `connecting…` still has to appear somewhere:
            the title is now a constant, so it can no longer carry the "we have
            not heard from the server yet" signal it used to. */}
        {hostId === null ? (
          <span className="text-[10px]" style={{ color: "var(--fg-dim)" }}>connecting…</span>
        ) : hostId !== DEFAULT_HOST_ID ? (
          <span className="text-[10px]" style={{ color: "var(--fg-dim)" }}>{hostId}</span>
        ) : null}
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
