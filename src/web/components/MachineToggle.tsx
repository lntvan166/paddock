import { useEffect, useState } from "react";
import type { Agent, MachineScope, SettingsView } from "@shared/types";
import { Segmented } from "@web/components/ui/Segmented";

/**
 * The quick switch for `agents.machines`, on the Agents screen.
 *
 * Shown only when it can matter: some agent lives on another machine (so `all`
 * is in force and there is something to hide), or `local` is in force (so
 * there may be something hidden). Absent while `PADDOCK_MACHINES` decides,
 * since a write could not change it. It writes at once rather than waiting
 * for a Save: it is one choice, and the list below is its confirmation.
 */
export function MachineToggle({ agents }: { agents: Agent[] }) {
  const [scope, setScope] = useState<MachineScope | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) throw new Error(`settings load failed: ${res.status}`);
        const body = (await res.json()) as SettingsView;
        if (!live) return;
        // An older server has no `agents`: it lists every machine.
        setScope(body.agents?.machines ?? "all");
        setLocked(body.agents?.envOverride != null);
      } catch (e) {
        // Not fatal to the list: the switch simply does not appear. Said, so
        // a missing switch has a reason on record.
        console.info(`paddock: machine switch hidden (${e instanceof Error ? e.message : String(e)})`);
      }
    })();
    return () => { live = false; };
  }, []);

  const remote = agents.some((a) => a.machine);
  if (scope === null || locked || (scope === "all" && !remote)) return null;

  async function choose(next: MachineScope) {
    const prev = scope;
    setScope(next);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agents: { machines: next } }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(typeof body?.detail === "string" ? body.detail : `save failed: ${res.status}`);
      setScope((body as SettingsView).agents.machines);
    } catch (e) {
      setScope(prev);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="machine-toggle" data-field="machine-toggle">
      <Segmented
        label="Which machines' agents to show"
        value={scope}
        options={[{ value: "local", label: "This machine" }, { value: "all", label: "All machines" }]}
        onChange={(v) => void choose(v)}
      />
      {error && <p className="settings-banner">{error}</p>}
    </div>
  );
}
