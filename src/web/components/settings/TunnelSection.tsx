import { useState } from "react";
import type { SettingsView } from "@shared/types";
import { Card } from "@web/components/ui/Card";
import { LinkIcon } from "@web/components/ui/icons";

interface TunnelSectionProps {
  tunnel: NonNullable<SettingsView["tunnel"]>;
  onInvite: () => Promise<{ code: string; expiresAt: number }>;
}

/**
 * Rendered by `Settings.tsx` only while `view.tunnel` is non-null — a paddock
 * served the ordinary way has nothing to pair and must not offer to.
 *
 * Lets an already-paired device mint a code for the next one, so adding a
 * tablet on day three does not require walking back to the terminal that
 * started `paddock tunnel`.
 */
export function TunnelSection({ tunnel, onInvite }: TunnelSectionProps) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  /**
   * Fetched on demand, from this click, and never rendered before it: the
   * code is a live credential that pairs a new device for the life of the
   * tunnel, and a settings screen left open on a desk should not be sitting
   * there displaying one. Minting it eagerly — the instant this section
   * mounts — would put a fresh, usable pairing code on screen every time the
   * operator opens Settings for something unrelated, such as changing the
   * theme.
   */
  async function invite() {
    setInviting(true);
    setError(null);
    try {
      const res = await onInvite();
      setCode(res.code);
    } catch (e) {
      // The previous code, if any, is cleared rather than left on screen: a
      // code that no longer pairs anything is worse than showing none, since
      // it still looks like a working one.
      setCode(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInviting(false);
    }
  }

  return (
    <Card
      icon={<LinkIcon />}
      title="Remote access"
      subtitle="This dashboard is published on a temporary tunnel for this run only."
    >
      <div className="card-row">
        <span>Paired devices</span>
        <strong>{tunnel.pairedDevices}</strong>
      </div>

      <div className="settings-actions">
        <button type="button" onClick={() => void invite()} disabled={inviting}>
          {inviting ? "Getting a code…" : "Add a device"}
        </button>
      </div>

      {code !== null && (
        <p className="pair-code">
          Enter <code>{code}</code> on the new device's pairing screen.
        </p>
      )}

      {error !== null && (
        <p className="settings-banner" role="alert">Could not get a code: {error}</p>
      )}
    </Card>
  );
}
