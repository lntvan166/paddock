import { useEffect, useRef, useState } from "react";
import type { NotifyTrigger, SettingsPatch, SettingsView } from "@shared/types";
import {
  readPrefs, themeAttr, writePref,
  type Prefs, type ThemePref,
} from "@web/prefs";
import { DeviceSection } from "@web/components/settings/DeviceSection";
import { TelegramSection } from "@web/components/settings/TelegramSection";
import { NotifySection } from "@web/components/settings/NotifySection";

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

  // The token field always starts empty and is never seeded from the
  // response — the server never sends it (SettingsView has no token member),
  // and this component must not invent a way to show it either.
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [triggers, setTriggers] = useState<NotifyTrigger[]>([]);
  const [cooldownMs, setCooldownMs] = useState(60_000);
  const [publicUrl, setPublicUrl] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string | null } | null>(null);

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
        const body = (await res.json()) as SettingsView;
        if (!live) return;
        setView(body);
        setChatId(body.telegram.chatId ?? "");
        setNotifyEnabled(body.notify.enabled);
        setTriggers(body.notify.triggers);
        setCooldownMs(body.notify.cooldownMs);
        setPublicUrl(body.publicUrl ?? "");
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { live = false; };
  }, []);

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
      setView(body as SettingsView);
      // The token is write-only: once it has been sent, the field goes back
      // to empty rather than continuing to display what was just typed.
      setToken("");
    } catch (e) {
      if (mountedRef.current) setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/telegram/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
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

      <DeviceSection prefs={prefs} setPref={setPref} />

      <section className="settings-section">
        <h2>All devices</h2>
        <p className="settings-hint">
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
        />

        {saveError && <p className="settings-banner">{saveError}</p>}

        <div className="settings-actions">
          {/* Disabled until the GET has landed. Every field in this section
              starts at an empty/false/60000 placeholder and is only filled in
              by that response — so if it fails, `loadError` is shown but Save
              would PUT `enabled: false, triggers: [], chatId: null` straight
              over whatever the operator had configured, destroying the
              token's companion settings to fix nothing. A form that never
              loaded cannot be saved. */}
          <button type="button" onClick={() => void save()} disabled={saving || view === null}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </section>
    </main>
  );
}
