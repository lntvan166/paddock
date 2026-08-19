import type { NotifyTrigger } from "@shared/types";

interface NotifySectionProps {
  notifyEnabled: boolean; setNotifyEnabled: (v: boolean) => void;
  triggers: NotifyTrigger[]; toggleTrigger: (t: NotifyTrigger) => void;
  cooldownMs: number; setCooldownMs: (v: number) => void;
  publicUrl: string; setPublicUrl: (v: string) => void;
}

export function NotifySection({
  notifyEnabled, setNotifyEnabled, triggers, toggleTrigger, cooldownMs, setCooldownMs,
  publicUrl, setPublicUrl,
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
        <label>
          <input
            type="checkbox"
            name="trigger-done"
            checked={triggers.includes("done")}
            onChange={() => toggleTrigger("done")}
          />
          Done
        </label>
      </fieldset>

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
      </label>

      <label className="settings-field">
        <span>Cooldown (ms)</span>
        {/* `min` matches the server's own floor (routes.ts MIN_COOLDOWN_MS):
            0 disarms the per-agent rate limit and reintroduces the
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
