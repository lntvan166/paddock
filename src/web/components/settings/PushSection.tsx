import { useCallback, useEffect, useState } from "react";
import { setPushEnabled, subscribePush, unsubscribePush } from "@web/api";

/**
 * What this browser can do, and what to say when it cannot.
 *
 * `unconfigured` is the server's answer, not the browser's: no VAPID keypair
 * means there is nothing to subscribe TO, which is the demo bundle's case and
 * also any paddock whose push.json could not be read.
 */
type Capability = "ready" | "needs-install" | "unsupported" | "denied" | "unconfigured";

/**
 * NO user-agent parsing, per CLAUDE.md — and none is needed, because iOS hands
 * us exactly the signal for free: `window.PushManager` is undefined in a Safari
 * tab and defined inside an installed PWA. So the "add to Home Screen first"
 * guidance falls out of a capability check rather than being special-cased for
 * one platform.
 */
function capability(vapidPublicKey: string | null): Capability {
  if (vapidPublicKey === null) return "unconfigured";
  // All three, not two. `serviceWorker` is checked because this component
  // REGISTERS one — without it the subscribe path throws on a browser that has
  // PushManager but no worker, and the effect below reads it unguarded.
  const hasPush = typeof window !== "undefined"
    && "PushManager" in window
    && "Notification" in window
    && window.Notification !== undefined
    && typeof navigator !== "undefined"
    && "serviceWorker" in navigator;
  if (!hasPush) {
    const installed = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(display-mode: standalone)").matches;
    return installed ? "unsupported" : "needs-install";
  }
  // `requestPermission()` will not ask twice once denied, so offering a button
  // that silently does nothing is worse than saying where to change it.
  if (window.Notification.permission === "denied") return "denied";
  return "ready";
}

/**
 * base64url to the bytes `pushManager.subscribe` wants.
 *
 * `Uint8Array<ArrayBuffer>` and not a bare `Uint8Array`: under this TypeScript
 * the latter means `Uint8Array<ArrayBufferLike>`, which `BufferSource` rejects
 * because it admits `SharedArrayBuffer`. Same narrowing as `push/vapid.ts`.
 */
function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface PushSectionProps {
  enabled: boolean;
  /** How many devices will buzz — NOT whether this one is subscribed. That is
   *  read from the browser below, because the server holds endpoints and cannot
   *  tell which of them is the browser currently asking. */
  vapidPublicKey: string | null;
  /** Non-null when push.json failed to load. Shown, never swallowed. */
  error: string | null;
  /** Refetch the settings view: the device count has moved. */
  onChanged: () => void;
}

export function PushSection(p: PushSectionProps) {
  const cap = capability(p.vapidPublicKey);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Whether THIS device is subscribed is a question only the browser can
  // answer. Read on mount, never assumed from the server's count.
  useEffect(() => {
    if (cap !== "ready") return;
    let live = true;
    void navigator.serviceWorker.getRegistration()
      .then((reg) => reg?.pushManager.getSubscription() ?? null)
      .then((sub) => { if (live) setSubscribed(sub !== null); })
      .catch(() => { if (live) setSubscribed(false); });
    return () => { live = false; };
  }, [cap]);

  const enable = useCallback(async () => {
    // Only ever from a tap. iOS enforces it, and a prompt on load is the one
    // guaranteed way to be denied permanently.
    setBusy(true);
    setFailure(null);
    try {
      const permission = await window.Notification.requestPermission();
      if (permission !== "granted") {
        setFailure("Notifications were not allowed. Change it in your browser settings.");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({
        // Required by every browser: a push that shows nothing is not allowed,
        // and paddock has no use for a silent one anyway.
        userVisibleOnly: true,
        applicationServerKey: keyBytes(p.vapidPublicKey ?? ""),
      });
      await subscribePush(sub.toJSON());
      // The second half, and without it the first half delivers nothing.
      // `index.ts` returns early on `push.enabled` before it reaches any
      // subscription, and nothing in the app ever set that flag — so this
      // button registered a device and then stayed silent forever.
      await setPushEnabled(true);
      setSubscribed(true);
      p.onChanged();
    } catch (e) {
      // Reported, never swallowed: a permission flow that fails in silence
      // leaves the operator tapping a button that appears to do nothing.
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [p]);

  const disable = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await unsubscribePush(sub.endpoint);
        await sub.unsubscribe();
      }
      setSubscribed(false);
      p.onChanged();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [p]);

  // NO `Card` of its own. This used to be a second card further down the page,
  // which meant push was configured in TWO places — a checkbox in the
  // Notifications card and a device button down here — and either one could be
  // set without the other. An operator could check the box and register no
  // device, or register a device with the box unchecked, and both look like
  // "push is on".
  //
  // It renders inline in the Web push row instead, so the transport and the
  // device that receives it are one decision in one place.
  return (
    <div className="push-control">
      {cap === "ready" ? (
        <button
          type="button"
          className="btn push-device-btn"
          disabled={busy}
          onClick={() => void (subscribed === true ? disable() : enable())}
        >
          {subscribed === true ? "Disable on this device" : "Enable on this device"}
        </button>
      ) : null}

      {/* The capability messages, which are the whole reason this cannot be a
          bare checkbox: on iOS a browser tab can never receive a push, and a
          denied permission cannot be re-asked from the page. */}
      {p.error !== null ? <p className="warn">{p.error}</p> : null}
      {failure !== null ? <p className="warn">{failure}</p> : null}
      {cap === "needs-install" ? (
        <p className="push-note">
          Add paddock to your Home Screen first, then enable it here.
          A browser tab cannot receive notifications.
        </p>
      ) : null}
      {cap === "unsupported" ? <p className="push-note">This browser does not support push.</p> : null}
      {cap === "denied" ? (
        <p className="push-note">
          Blocked for this site. Change it in your browser settings — this page cannot ask again.
        </p>
      ) : null}
      {cap === "unconfigured" ? <p className="push-note">Push is not configured on this server.</p> : null}
    </div>
  );
}
