import { useEffect, useState } from "react";
import type { MachineInfo, MachineScope } from "@shared/types";
import { Card } from "@web/components/ui/Card";
import { Segmented } from "@web/components/ui/Segmented";
import { MonitorIcon } from "@web/components/ui/icons";

interface MachinesSectionProps {
  machines: MachineScope;
  setMachines: (v: MachineScope) => void;
  /** Non-null when `PADDOCK_MACHINES` sets the scope; the control is then
   *  replaced by a line saying so, since a Save could not change it. */
  envOverride: MachineScope | null;
}

const LABELS: Record<MachineScope, string> = { local: "This machine", all: "All machines" };

/**
 * `agents.machines`. A server setting, saved with the rest of the band: it
 * decides what every device sees, the MCP tools and notifications included.
 */
/** What each added machine's line is doing, from `GET /api/machines`. */
function useMachineList(): { list: MachineInfo[] | null; error: string | null } {
  const [list, setList] = useState<MachineInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/machines");
        const body = await res.json() as { machines?: MachineInfo[]; detail?: string };
        if (!live) return;
        if (!res.ok || !body.machines) { setError(body.detail ?? `machines: ${res.status}`); return; }
        setList(body.machines);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { live = false; };
  }, []);
  return { list, error };
}

const STATE_WORD: Record<string, string> = {
  connected: "Connected", connecting: "Connecting…", needs_login: "Needs a login", unreachable: "Unreachable",
};

export function MachinesSection({ machines, setMachines, envOverride }: MachinesSectionProps) {
  const { list, error } = useMachineList();
  return (
    <Card
      icon={<MonitorIcon />}
      title="Machines"
      subtitle="Agents on machines the Herdr app added over SSH show here too, unless you limit it to this machine."
    >
      {envOverride !== null ? (
        <p className="band-hint" data-field="machines-locked">
          Set to “{LABELS[envOverride]}” by PADDOCK_MACHINES; change it there and restart paddock.
        </p>
      ) : (
        <Segmented
          label="Which machines' agents to show"
          value={machines}
          options={(["local", "all"] as const).map((v) => ({ value: v, label: LABELS[v] }))}
          onChange={setMachines}
        />
      )}
      {/* Each added machine and its line. A machine that drops out otherwise
          shows only as its agents vanishing, with nothing to say why. */}
      {list !== null && list.length > 0 && (
        <ul className="machine-list" data-field="machine-list">
          {list.map((m) => (
            <li key={m.name} className="dl-row">
              <span className="dl-label"><span className="ident">{m.name}</span> <span className="machine-host">{m.host}</span></span>
              <span className={m.state === "connected" ? "dl-value ok" : "dl-value warn"}>
                {STATE_WORD[m.state] ?? m.state}
                {m.state !== "connected" && m.sinceMs ? ` since ${new Date(m.sinceMs).toLocaleTimeString()}` : ""}
                {m.why ? ` (${m.why})` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {list !== null && list.length === 0 && (
        <p className="band-hint">No machines added in the Herdr app.</p>
      )}
      {error !== null && <p className="band-hint">Machines could not be listed: {error}</p>}
    </Card>
  );
}
