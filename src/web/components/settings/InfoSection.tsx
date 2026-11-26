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
  const core = health?.core ?? null;
  const app = health?.app ?? null;
  // Terminal herdr is ONE of two backends. Down while herdr-core serves the
  // agents is an app-only setup working as intended, so it reads "Not
  // running" like the core's own row; only both down is a warning.
  const coreUp = core?.connected === true;
  // The newest event from EITHER backend. This row is the liveness check
  // (a silent break shows here within seconds), and reading terminal
  // herdr's alone showed "—" on every app-only install.
  const lastEvent = Math.max(health?.lastEventAt ?? 0, core?.lastEventAt ?? 0) || null;
  const protocol = [
    health?.herdrProtocol ?? null,
    core?.generation != null ? `herdr-core gen ${core.generation}` : null,
  ].filter((p): p is string => p !== null).join(" · ") || null;

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
          value={herdrOk === null ? null : herdrOk ? "Connected" : coreUp ? "Not running" : "Disconnected"}
          valueClassName={herdrOk === null ? undefined : herdrOk ? "ok" : coreUp ? undefined : "warn"}
        />
        {/* Always rendered, like every row: absent is a state worth showing. */}
        <Row
          label="herdr-core"
          value={core === null ? null : core.connected
            ? `Connected${core.version ? ` · ${core.version}` : ""}`
            : `Not running${core.detail ? ` (${core.detail})` : ""}`}
          valueClassName={core === null ? undefined : core.connected ? "ok" : undefined}
        />
        <Row
          label="Herdr app"
          value={app === null ? null : app.running ? "Running" : "Not running"}
          valueClassName={app === null ? undefined : app.running ? "ok" : undefined}
        />
        <Row
          label="Last event"
          value={lastEvent ? new Date(lastEvent).toLocaleTimeString() : null}
        />
        <Row label="Protocol" value={protocol} />
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
