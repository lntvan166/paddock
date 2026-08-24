import type { HealthBody } from "@shared/types";
import { upgradeCommand } from "@shared/types";
import { BUILD } from "@web/build";
import { Card } from "@web/components/ui/Card";
import { PlugIcon, RefreshIcon } from "@web/components/ui/icons";

/**
 * One diagnostics row. ALWAYS rendered, `health` present or not: a row that
 * appeared only once its data arrived would grow the card and shove
 * everything below it down the page — under a thumb already reaching for
 * something. A pending value renders as an em dash rather than an empty
 * cell, so the row itself is never in doubt.
 *
 * `valueClassName` carries a verdict's colour (`ok` / `warn`) — always IN
 * ADDITION to the text ("Connected", "Yes"), never instead of it.
 */
function Row({
  label, value, valueClassName,
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="dl-row">
      <span className="dl-label">{label}</span>
      <span className={valueClassName ? `dl-value ${valueClassName}` : "dl-value"}>
        {value ?? "—"}
      </span>
    </div>
  );
}

/**
 * A read-only "Info" band: what build is running, and what this device's own
 * connection looks like. Two cards — no server work needed, because
 * `/api/health` already carries every field either one reads.
 */
export function InfoSection({ health }: { health: HealthBody | null }) {
  const secure = window.isSecureContext;
  const herdrOk = health ? health.herdrConnected : null;

  return (
    <>
      <Card
        icon={<RefreshIcon />}
        title="Updates"
        // Where collie puts it, and it keeps the card body free for the action.
        subtitle={<>Running <span className="ident">v{health?.version ?? BUILD.version}</span></>}
      >
        <div className="card-row">
          <span>{health?.latestKnown ? `v${health.latestKnown} is available` : "Up to date"}</span>
          {health?.latestKnown ? (
            <code className="dl-value">{upgradeCommand(health.managedBy)}</code>
          ) : null}
        </div>
      </Card>

      <Card icon={<PlugIcon />} title="Connection" subtitle="Diagnostics for this device.">
        <Row label="Endpoint" value={location.host} />
        <Row
          label="Secure context"
          value={secure ? "Yes" : "No"}
          valueClassName={secure ? "ok" : "warn"}
        />
        <Row
          label="herdr"
          value={herdrOk === null ? null : herdrOk ? "Connected" : "Disconnected"}
          valueClassName={herdrOk === null ? undefined : herdrOk ? "ok" : "warn"}
        />
        <Row
          label="Last event"
          value={health?.lastEventAt ? new Date(health.lastEventAt).toLocaleTimeString() : null}
        />
        <Row label="Protocol" value={health?.herdrProtocol ?? null} />
        {/* Server-only, deliberately: `health.version` comes from
            `/api/health` (the server); `BUILD.commit` is the vite `define`
            baked into the RUNNING BUNDLE (the client). Concatenating them
            reads as one fact but is two, and they agree only when the tab
            is current — the one case this whole diagnostics card doesn't
            need. A cached tab still running an old bundle after the host
            is upgraded would correctly show `BuildStamp`'s own
            `v0.8.5 · abc1234 · …`, while this row claimed the SERVER was on
            a commit it has never run. The client bundle's own identity is
            `BuildStamp`'s job; this row reports the server and nothing
            else. */}
        <Row label="Server version" value={health?.version ?? null} />
      </Card>
    </>
  );
}
