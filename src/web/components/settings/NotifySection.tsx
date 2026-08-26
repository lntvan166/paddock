import type { NotifyTrigger } from "@shared/types";
import { isQuickTunnelUrl } from "@shared/quick-tunnel";
import { BellIcon } from "@web/components/ui/icons";
import { Card } from "@web/components/ui/Card";
import { Checkbox } from "@web/components/shadcn/checkbox";

export interface NotifySectionProps {
  /** The two transports. Both off is "send nothing" — there is deliberately no
   *  master switch above them, because a third flag would only be a way for
   *  the three to disagree. */
  telegramOn: boolean; setTelegramOn: (v: boolean) => void;
  pushOn: boolean; setPushOn: (v: boolean) => void;
  /** How many devices are registered for push. A checkbox with no device to
   *  deliver to is worth saying out loud rather than leaving to fail quietly. */
  pushDevices: number;
  /** The device-registration control, rendered inside the Web push row.
   *  A SLOT rather than an import, so this card keeps knowing nothing about
   *  service workers, permission prompts or `PushManager`. */
  pushControl?: React.ReactNode;
  /** Withhold push from a device currently showing the agent's pane, until it
   *  stops showing it. Push only — see the doc comment on
   *  `SettingsView["notify"].skipWhileViewing`. */
  skipWhileViewing: boolean; setSkipWhileViewing: (v: boolean) => void;
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
  telegramOn, setTelegramOn, pushOn, setPushOn, pushDevices, pushControl,
  skipWhileViewing, setSkipWhileViewing,
  triggers, toggleTrigger, cooldownMs, setCooldownMs,
  publicUrl, setPublicUrl, settleMs, setSettleMs, mutedUntil, serverNow, onMute, muting,
}: NotifySectionProps) {
  const quickTunnel = isQuickTunnelUrl(publicUrl);
  return (
    <Card
      icon={<BellIcon />}
      title="Notifications"
      subtitle="When an agent needs you or finishes. Both transports share the rules below."
      footer={quickTunnel ? (
        <>
          That is a quick-tunnel URL, and it changes every time <code>paddock tunnel</code> runs
          — so saving it here will point notification links at a hostname that has stopped
          resolving. Leave this empty while using <code>paddock tunnel</code>: it fills the link
          in automatically for the life of each run.
        </>
      ) : undefined}
    >
      {/* The transports, above the rules that govern BOTH of them. This card
          used to carry one toggle called "Notifications" and a subtitle saying
          "Telegram messages", while the mute, the triggers and the cooldown
          underneath already applied to push as well — so the shared half was
          described as belonging to one transport.

          Two checkboxes rather than two cards: they are the same decision made
          twice, and separating them put the rules next to one of them and not
          the other. */}
      <div className="notify-transports" role="group" aria-label="Where notifications go">
        <label className="notify-transport">
          <Checkbox checked={telegramOn} onCheckedChange={(v) => setTelegramOn(v === true)} />
          <span>
            Telegram
            <small>A message to your chat. Needs the token and chat id above.</small>
          </span>
        </label>
        <label className="notify-transport">
          <Checkbox checked={pushOn} onCheckedChange={(v) => setPushOn(v === true)} />
          <span>
            Web push
            {/* Said plainly, because a checked box with nowhere to deliver is
                the failure this whole area has already produced twice. */}
            <small>
              {pushDevices === 0
                ? "No device registered yet — turn it on from the device you want buzzed."
                : `${pushDevices} device${pushDevices === 1 ? "" : "s"} registered.`}
            </small>
            {/* The device control lives HERE, not in a card of its own further
                down the page. Two places to configure one transport is a
                control an operator can half-set: box checked and no device, or
                a device registered with the box off. */}
            {pushControl}
          </span>
        </label>
      </div>

      {/* NOT inside `.notify-transports` above — this governs one of those two
          transports rather than being a third one, and the "exactly two"
          checkboxes there is itself an assertion (see notify-card.test.tsx)
          that a third would mean a transport with nothing to deliver to.
          Same `notify-transport` markup for a matching look, different
          group. */}
      <label className="notify-transport">
        <Checkbox
          checked={skipWhileViewing}
          aria-label="Skip push for the agent I'm watching"
          onCheckedChange={(v) => setSkipWhileViewing(v === true)}
        />
        <span>
          Skip push for the agent I&apos;m watching
          <small>
            While a device has this agent&apos;s pane open, push to that
            device waits until you leave it. Other devices and Telegram are
            unaffected.
          </small>
        </span>
      </label>

      {/* Only 1h / 4h / 8h, plus Unmute while muted — deliberately no
          "mute indefinitely" button. the transport checkboxes above are already that
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
          {/* shadcn's Checkbox, not a native one. The native input paints
              itself with the browser's own accent — a different blue from
              --accent — so the trigger boxes and the Notifications switch two
              rows above disagreed about what "on" looks like inside one card.
              This draws from --primary, which the bridge points at --accent, so
              every "on" in the app is now one colour. */}
          <Checkbox
            className="trigger-box"
            name="trigger-blocked"
            checked={triggers.includes("blocked")}
            onCheckedChange={() => toggleTrigger("blocked")}
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
          {/* shadcn's Checkbox, not a native one. The native input paints
              itself with the browser's own accent — a different blue from
              --accent — so the trigger boxes and the Notifications switch two
              rows above disagreed about what "on" looks like inside one card.
              This draws from --primary, which the bridge points at --accent, so
              every "on" in the app is now one colour. */}
          <Checkbox
            className="trigger-box"
            name="trigger-done"
            checked={triggers.includes("done")}
            onCheckedChange={() => toggleTrigger("done")}
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

      <p className="card-hint">
        Only notify once the agent has held this state for the whole wait. A
        subagent finishing flips an agent to done for a moment; waiting means
        you hear about the real finish, not that blip.
      </p>

      <label className="card-row">
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
      </label>
      <p className="card-hint">
        Where you reach paddock from your phone. Used to build the link in each message.
      </p>
      {/* The staleness warning for this field, shown whether or not a
          tunnel is running right now, lives in the card's `footer` (above)
          rather than floated here — it explains why the field should be
          left alone, which is a fact about the setting rather than a
          validation error on this one input. */}

      <label className="card-row">
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
      </label>
      <p className="card-hint">
        Shortest gap between two messages about the same agent.
      </p>
    </Card>
  );
}
