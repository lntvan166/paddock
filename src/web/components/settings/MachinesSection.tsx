import type { MachineScope } from "@shared/types";
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
export function MachinesSection({ machines, setMachines, envOverride }: MachinesSectionProps) {
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
    </Card>
  );
}
