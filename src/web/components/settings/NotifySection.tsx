import type { NotifyTrigger } from "@shared/types";
import { isQuickTunnelUrl } from "@shared/quick-tunnel";

interface NotifySectionProps {
  notifyEnabled: boolean; setNotifyEnabled: (v: boolean) => void;
  triggers: NotifyTrigger[]; toggleTrigger: (t: NotifyTrigger) => void;
  cooldownMs: number; setCooldownMs: (v: number) => void;
  publicUrl: string; setPublicUrl: (v: string) => void;
  settleMs: Record<NotifyTrigger, number>; setSettleMs: (t: NotifyTrigger, ms: number) => void;
  mutedUntil: number | null; serverNow: number;
  onMute: (forMs: number) => void; muting: boolean;
}

const HOUR_MS = 3_600_000;

/** Server-clock instant rendered as a local wall-clock time. `serverNow` is
 *  the server's reading at load; the offset from the device's clock is applied
 *  once so a skewed phone still shows a sane countdown.
 *
 *  Deliberately NOT a live ticker. A per-second re-render of the settings
 *  screen to age a label by one minute is not worth a timer, and the label is
 *  recomputed on every render anyway — including after the mute POST returns
 *  a fresh `serverNow`. */
function muteLabel(mutedUntil: number, serverNow: number): string {
  const skew = Date.now() - serverNow;
  const at = new Date(mutedUntil + skew);
  const remaining = Math.max(0, mutedUntil - serverNow);
  const h = Math.floor(remaining / HOUR_MS);
  // FLOORED, not rounded. Rounding the remainder renders 3h 59m 40s as
  // "3h 60m" — a label that reads like a bug on any page load that lands in
  // the last 30 seconds of an hour. Flooring can only ever understate the
  // remaining time by under a minute, which for "muted until" is the harmless
  // direction.
  const m = Math.floor((remaining % HOUR_MS) / 60_000);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `Muted until ${clock} (in ${h}h ${m}m)`;
}

export function NotifySection({
  notifyEnabled, setNotifyEnabled, triggers, toggleTrigger, cooldownMs, setCooldownMs,
  publicUrl, setPublicUrl, settleMs, setSettleMs, mutedUntil, serverNow, onMute, muting,
}: NotifySectionProps) {
  return (
    <>
      <label className="settings-field settings-field-row">
        <span>Notifications</span>
        <input
          type="checkbox"
          name="notifyEnabled"
          checked={notifyEnabled}
          onChange={(e) => setNotifyEnabled(e.target.checked)}
        />
      </label>

      {/* Only 1h / 4h / 8h, plus Unmute while muted — deliberately no
          "mute indefinitely" button. `notifyEnabled` above is already that
          control, and two controls for one state is how an operator ends up
          muted with no idea why. */}
      <div className="settings-mute">
        {mutedUntil !== null && mutedUntil > serverNow ? (
          <>
            <span>{muteLabel(mutedUntil, serverNow)}</span>
            <button type="button" name="unmute" disabled={muting} onClick={() => onMute(0)}>
              Unmute
            </button>
          </>
        ) : (
          <>
            <span>Mute for</span>
            {([1, 4, 8] as const).map((h) => (
              <button
                key={h}
                type="button"
                name={`mute-${h}h`}
                disabled={muting}
                onClick={() => onMute(h * HOUR_MS)}
              >
                {h}h
              </button>
            ))}
          </>
        )}
      </div>

      <fieldset className="settings-triggers">
        <legend>Notify on</legend>
        <label>
          <input
            type="checkbox"
            name="trigger-blocked"
            checked={triggers.includes("blocked")}
            onChange={() => toggleTrigger("blocked")}
          />
          Blocked
        </label>
        <label className="settings-settle">
          wait
          <input
            type="number"
            name="settle-blocked"
            min={0}
            max={600}
            value={Math.round(settleMs.blocked / 1000)}
            onChange={(e) => setSettleMs("blocked", Number(e.target.value) * 1000)}
          />
          s before sending
        </label>
        <label>
          <input
            type="checkbox"
            name="trigger-done"
            checked={triggers.includes("done")}
            onChange={() => toggleTrigger("done")}
          />
          Done
        </label>
        <label className="settings-settle">
          wait
          <input
            type="number"
            name="settle-done"
            min={0}
            max={600}
            value={Math.round(settleMs.done / 1000)}
            onChange={(e) => setSettleMs("done", Number(e.target.value) * 1000)}
          />
          s before sending
        </label>
      </fieldset>

      <p className="settings-hint">
        Only notify once the agent has held this state for the whole wait. A
        subagent finishing flips an agent to done for a moment; waiting means
        you hear about the real finish, not that blip.
      </p>

      <label className="settings-field">
        <span>Public URL</span>
        {/* Without this, every notification ships with no link — which the
            design calls the whole reason the setting exists. paddock binds
            loopback and genuinely cannot discover the hostname it is
            reached by, so nothing but the operator can supply it. Unset is
            legal; the message is then text only. */}
        <input
          type="url"
          name="publicUrl"
          inputMode="url"
          autoComplete="off"
          placeholder="https://paddock.example.com"
          value={publicUrl}
          onChange={(e) => setPublicUrl(e.target.value)}
        />
        <span className="settings-hint-inline">
          Where you reach paddock from your phone. Used to build the link in each message.
        </span>
        {/* Shown whether or not a tunnel is running right now: the staleness
            is a property of the SAVED value, not of the current session. A
            quick tunnel's hostname is thrown away and re-minted on every run
            of `paddock tunnel`, so a value saved here goes dead the moment
            that run ends — and every Telegram link built from it points
            nowhere from then on. The fix is to leave the field empty: Task 8
            already has the server fill this in from the live tunnel, in
            memory, for the life of each run, so a saved value here only ever
            fights that instead of helping it. */}
        {isQuickTunnelUrl(publicUrl) && (
          <p className="settings-banner">
            That is a quick-tunnel URL, and it changes every time <code>paddock tunnel</code> runs
            — so saving it here will point notification links at a hostname that has stopped
            resolving. Leave this empty while using <code>paddock tunnel</code>: it fills the link
            in automatically for the life of each run.
          </p>
        )}
      </label>

      <label className="settings-field">
        <span>Cooldown (ms)</span>
        {/* `min` matches the server's own floor (`MIN_COOLDOWN_MS`, exported
            by the settings store and enforced by both the PUT route and
            `migrate()`): 0 disarms the per-agent rate limit and reintroduces the
            send-per-delta hot loop against a failing Telegram. The server
            rejects it either way — this just says so before the round
            trip. */}
        <input
          type="number"
          name="cooldownMs"
          min={1000}
          step={1000}
          value={cooldownMs}
          onChange={(e) => setCooldownMs(Number(e.target.value))}
        />
        <span className="settings-hint-inline">
          Shortest gap between two messages about the same agent.
        </span>
      </label>
    </>
  );
}
