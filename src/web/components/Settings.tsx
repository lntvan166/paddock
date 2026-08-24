import { useEffect, useRef, useState } from "react";
import type { HealthBody, NotifyTrigger, SettingsPatch, SettingsView } from "@shared/types";
import {
  readPrefs, themeAttr, writePref,
  type Prefs, type ThemePref,
} from "@web/prefs";
import { DeviceSection } from "@web/components/settings/DeviceSection";
import { TunnelSection } from "@web/components/settings/TunnelSection";
import { TelegramSection } from "@web/components/settings/TelegramSection";
import { NotifySection } from "@web/components/settings/NotifySection";
import { InfoSection } from "@web/components/settings/InfoSection";
import { SaveBar } from "@web/components/settings/SaveBar";
import { Toast } from "@web/components/settings/Toast";

interface SettingsProps {
  onBack: () => void;
}

/**
 * Two sections, because the settings behind them live in two different
 * places. "This device" writes straight to localStorage via `@web/prefs` and
 * takes effect immediately, no network round trip. "All devices" is a form
 * over one `SettingsView` fetched from the server; nothing in it applies
 * until Save succeeds, because sending happens server-side and a save that
 * silently failed would leave the operator believing a switch is set when it
 * is not.
 */
export function Settings({ onBack }: SettingsProps) {
  const [prefs, setPrefs] = useState<Prefs>(() => readPrefs());

  const [view, setView] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Read-only, for the Info band's Updates and Connection cards. `null` while
  // loading — `InfoSection` renders every row regardless, with an em dash for
  // whatever has not arrived yet.
  const [health, setHealth] = useState<HealthBody | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  // The token field always starts empty and is never seeded from the
  // response — the server never sends it (SettingsView has no token member),
  // and this component must not invent a way to show it either.
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [triggers, setTriggers] = useState<NotifyTrigger[]>([]);
  const [cooldownMs, setCooldownMs] = useState(60_000);
  const [publicUrl, setPublicUrl] = useState("");
  const [settleMs, setSettleMsState] = useState<Record<NotifyTrigger, number>>({ blocked: 5_000, done: 10_000 });
  const [mutedUntil, setMutedUntil] = useState<number | null>(null);
  const [serverNow, setServerNow] = useState(0);
  const [muting, setMuting] = useState(false);

  const setSettleMs = (t: NotifyTrigger, ms: number) =>
    setSettleMsState((cur) => ({ ...cur, [t]: ms }));

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string | null } | null>(null);

  /** The server state the form was last known to match. Dirtiness is measured
   *  against this, so it is re-captured on every successful save. */
  const [baseline, setBaseline] = useState<SettingsView | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Token is write-only: the field always starts empty and the server never
  // sends one back, so there is no baseline to compare — anything typed is a
  // change. `baseline === null` is also the form-never-loaded guard that used
  // to be `disabled={saving || view === null}` on the Save button: while it
  // holds, `dirty` is false, so the save bar (and its button) never renders,
  // and a failed GET cannot PUT over whatever the operator already had
  // configured on the server.
  const dirty =
    baseline !== null && (
      token !== "" ||
      chatId !== (baseline.telegram.chatId ?? "") ||
      notifyEnabled !== baseline.notify.enabled ||
      triggers.join(",") !== [...baseline.notify.triggers].join(",") ||
      cooldownMs !== baseline.notify.cooldownMs ||
      // Trimmed on BOTH sides, mirroring the transformation `save()` applies to
      // this field. If the two disagree about normalisation they disagree by
      // construction: a value that `save()` would send as trimmed, compared
      // untrimmed against the trimmed baseline the server echoed back, leaves
      // "Settings saved" and "Unsaved changes" on screen at the same time. And
      // trimming only the left side swaps that for a form that arrives dirty
      // whenever the STORED value has stray whitespace (a hand-edited
      // settings.json, a `curl` PUT), which nothing in the UI can clear.
      publicUrl.trim() !== (baseline.publicUrl ?? "").trim() ||
      settleMs.blocked !== baseline.notify.settleMs.blocked ||
      settleMs.done !== baseline.notify.settleMs.done
    );

  /**
   * Shared by `save()` and `sendTest()`, which — unlike the GET effect above,
   * whose own `live` flag is scoped to one effect run — are user-triggered
   * handlers that can outlive the component for as long as their request is
   * in flight. App.tsx's own comment on `key={agentId}` documents this exact
   * failure once already: a reply typed for one screen resolving AFTER the
   * operator navigated away must not write into whatever replaced it. Here
   * that means setSaving/setSaveError/setView after "‹ Agents" has already
   * unmounted this component.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/settings");
        // Checked BEFORE the cast. Without this a non-2xx body — a 404 from a
        // demo backend, a 500 from a broken server — was cast to SettingsView
        // anyway, and the first render to read `baseline.telegram.chatId` threw,
        // blanking the whole screen. The catch below already knows how to show
        // this; it was never reached.
        if (!res.ok) throw new Error(`settings load failed: ${res.status}`);
        const body = (await res.json()) as SettingsView;
        if (!live) return;
        setView(body);
        setBaseline(body);
        setChatId(body.telegram.chatId ?? "");
        setNotifyEnabled(body.notify.enabled);
        setTriggers(body.notify.triggers);
        setCooldownMs(body.notify.cooldownMs);
        setPublicUrl(body.publicUrl ?? "");
        setSettleMsState(body.notify.settleMs);
        setMutedUntil(body.notify.mutedUntil);
        setServerNow(body.serverNow);
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { live = false; };
  }, []);

  // Same fetch idiom as `/api/settings` above, including the `res.ok` check:
  // a failure here must be visible rather than leaving the Connection card
  // showing em dashes forever with nothing to explain why.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) throw new Error(`health load failed: ${res.status}`);
        const body = (await res.json()) as HealthBody;
        if (!live) return;
        setHealth(body);
      } catch (e) {
        if (live) setHealthError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { live = false; };
  }, []);

  // Cleared on unmount, and keyed on `savedAt` so two saves in a row each get
  // a full three seconds rather than the second inheriting the first's timer.
  useEffect(() => {
    if (savedAt === null) return;
    const t = setTimeout(() => setSavedAt(null), 3_000);
    return () => clearTimeout(t);
  }, [savedAt]);

  function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
    writePref(k, v);
    setPrefs((p) => ({ ...p, [k]: v }));
    // `App.tsx`'s own theme effect only runs once, at the page's initial
    // mount — `App` is never unmounted (see its comment on `main.tsx`'s
    // single, unkeyed `createRoot(...).render(<App />)`), so nothing upstream
    // re-applies a change made here. Every other pref in this section is
    // read straight from `readPrefs()` by whatever consumes it, but the DOM
    // attribute the CSS switches on has no consumer that re-reads it later —
    // it must be pushed, immediately, right here.
    if (k === "theme") {
      const attr = themeAttr(v as ThemePref);
      if (attr === null) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = attr;
    }
  }

  function toggleTrigger(t: NotifyTrigger) {
    setTriggers((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    const patch: SettingsPatch = {
      telegram: { chatId: chatId || null, ...(token ? { token } : {}) },
      notify: {
        enabled: notifyEnabled,
        triggers,
        cooldownMs,
        settleMs,
      },
      publicUrl: publicUrl.trim() || null,
    };
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!mountedRef.current) return;
      if (!res.ok) {
        // Surfaced verbatim rather than a generic "save failed": the 400
        // reason is the whole point of the server validating the patch.
        setSaveError(typeof body?.detail === "string" ? body.detail : `save failed: ${res.status}`);
        return;
      }
      const saved = body as SettingsView;
      setView(saved);
      setBaseline(saved);
      setSavedAt(Date.now());
      // The token is write-only: once it has been sent, the field goes back
      // to empty rather than continuing to display what was just typed.
      setToken("");
    } catch (e) {
      if (mountedRef.current) setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  /**
   * Its own request, not part of the form. The server stamps the instant from
   * this duration — a phone's clock is not the server's — and mute takes
   * effect immediately, because the operator taps it on their way to bed.
   */
  async function mute(forMs: number) {
    setMuting(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/settings/mute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ forMs }),
      });
      const body = await res.json();
      if (!mountedRef.current) return;
      if (!res.ok) {
        setSaveError(typeof body?.detail === "string" ? body.detail : `mute failed: ${res.status}`);
        return;
      }
      const v = body as SettingsView;
      setView(v);
      setMutedUntil(v.notify.mutedUntil);
      setServerNow(v.serverNow);
      // Deliberately NOT setBaseline: mute is not one of the form's fields,
      // so it must neither create nor clear unsaved changes.
    } catch (e) {
      if (mountedRef.current) setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setMuting(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/telegram/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The values ON SCREEN, so a pasted token can be verified before it is
        // committed. Blank fields are omitted, and the server falls back to
        // the stored value per field.
        body: JSON.stringify({
          ...(token ? { token } : {}),
          ...(chatId ? { chatId } : {}),
        }),
      });
      const body = (await res.json()) as { ok: boolean; detail: string | null };
      if (mountedRef.current) setTestResult(body);
    } catch (e) {
      if (mountedRef.current) {
        setTestResult({ ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (mountedRef.current) setTesting(false);
    }
  }

  const tokenPlaceholder = view?.telegram.configured
    ? `configured · ••••${view.telegram.hint ?? ""}`
    : "not set";

  return (
    <main className="settings mx-auto max-w-2xl safe-bottom">
      <header className="settings-header">
        <button type="button" className="term-back" onClick={onBack} aria-label="Back to agents">
          ‹ Agents
        </button>
        <h1 className="settings-title">Settings</h1>
      </header>

      {view?.error && <p className="settings-banner">{view.error}</p>}
      {loadError && <p className="settings-banner">{loadError}</p>}
      {healthError && <p className="settings-banner">{healthError}</p>}
      <Toast message={savedAt === null ? null : "Settings saved"} />

      {/* A `<section>` per band, labelled by a real heading (not just a
          styled `<p>`): before this branch the outline was `h1 Settings` →
          `h2 This device` / `h2 All devices` / `h2 Info`, with no heading
          inside a card. `Card`'s own title is now an `<h3>` precisely so it
          nests under its band instead of competing with it — see the
          comment there. Losing that nesting would leave a screen-reader
          user navigating by heading unable to tell "This device" (writes to
          localStorage immediately) from "All devices" (a form that does
          nothing until Save succeeds), which is the exact confusion the
          two-band split exists to prevent. */}
      <section className="band" aria-labelledby="band-device">
        <h2 className="band-label" id="band-device">This device</h2>
        <p className="band-hint">
          Stored in this browser only. Each device you open paddock on keeps its own copy.
        </p>
        <DeviceSection prefs={prefs} setPref={setPref} />
      </section>

      <section className="band" aria-labelledby="band-server">
        <h2 className="band-label" id="band-server">All devices</h2>
        <p className="band-hint">
          These are server settings and affect every device, not just this one.
        </p>

        <TelegramSection
          token={token}
          setToken={setToken}
          chatId={chatId}
          setChatId={setChatId}
          tokenPlaceholder={tokenPlaceholder}
          testing={testing}
          testResult={testResult}
          onTest={() => void sendTest()}
        />

        <NotifySection
          notifyEnabled={notifyEnabled}
          setNotifyEnabled={setNotifyEnabled}
          triggers={triggers}
          toggleTrigger={toggleTrigger}
          cooldownMs={cooldownMs}
          setCooldownMs={setCooldownMs}
          publicUrl={publicUrl}
          setPublicUrl={setPublicUrl}
          settleMs={settleMs}
          setSettleMs={setSettleMs}
          mutedUntil={mutedUntil}
          serverNow={serverNow}
          onMute={(forMs) => void mute(forMs)}
          muting={muting}
        />

        {/* Present only while a tunnel is running: `view.tunnel` is null for
            a paddock served the ordinary way, which has nothing to pair.
            Lives inside "All devices" — the spec's own placement — rather
            than between the two bands: it is a server setting like
            Telegram and Notifications above it, so it gets that band's
            padding, its `.card + .card` spacing, and its heading. */}
        {view?.tunnel != null && (
          <TunnelSection
            tunnel={view.tunnel}
            onInvite={async () => {
              const res = await fetch("/api/pair/invite", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
              });
              if (!res.ok) throw new Error(`invite failed: ${res.status}`);
              return (await res.json()) as { code: string; expiresAt: number };
            }}
          />
        )}

        {saveError && <p className="settings-banner">{saveError}</p>}
      </section>

      <section className="band" aria-labelledby="band-info">
        <h2 className="band-label" id="band-info">Info</h2>
        <p className="band-hint">Read-only. What build is running, and what this device can see.</p>
        <InfoSection health={health} />
      </section>

      {/* `dirty` is false while `baseline === null`, which is what used to be
          `disabled={saving || view === null}` on a Save button: every field
          in this section starts at an empty/false/60000 placeholder and is
          only filled in by the GET response, so if that GET fails, a form
          that treated itself as editable would PUT `enabled: false,
          triggers: [], chatId: null` straight over whatever the operator had
          configured. A form that never loaded cannot be saved — and now
          there is no Save button rendered at all until something is dirty. */}
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} />
    </main>
  );
}
