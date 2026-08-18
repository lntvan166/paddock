import { useEffect, useRef, useState } from "react";
import type { NotifyTrigger, SettingsPatch, SettingsView } from "@shared/types";
import { RATE_MS, readPrefs, writePref, type Prefs, type RatePref, type ThemePref } from "@web/prefs";

const RATE_LABELS: Record<RatePref, string> = { live: "Live", balanced: "Balanced", frugal: "Frugal" };

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
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");
  const [cooldownMs, setCooldownMs] = useState(60_000);

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
        setQuietStart(body.notify.quietHours?.start ?? "");
        setQuietEnd(body.notify.quietHours?.end ?? "");
        setCooldownMs(body.notify.cooldownMs);
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { live = false; };
  }, []);

  function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
    writePref(k, v);
    setPrefs((p) => ({ ...p, [k]: v }));
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
        quietHours: quietStart && quietEnd ? { start: quietStart, end: quietEnd } : null,
        cooldownMs,
      },
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

      <section className="settings-section">
        <h2>This device</h2>
        <p className="settings-hint">
          Stored in this browser only. Each device you open paddock on keeps its own copy.
        </p>

        <label className="settings-field">
          <span>Theme</span>
          <select
            value={prefs.theme}
            onChange={(e) => setPref("theme", e.target.value as ThemePref)}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>

        <label className="settings-field">
          <span>Refresh rate</span>
          <select
            value={prefs.rate}
            onChange={(e) => setPref("rate", e.target.value as RatePref)}
          >
            {(Object.keys(RATE_MS) as RatePref[]).map((r) => (
              <option key={r} value={r}>{RATE_LABELS[r]}</option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span>Font size</span>
          <input
            type="number"
            name="fontPx"
            min={10}
            max={22}
            value={prefs.fontPx}
            onChange={(e) => setPref("fontPx", Number(e.target.value))}
          />
        </label>

        <label className="settings-field settings-field-row">
          <span>Wrap long lines</span>
          <input
            type="checkbox"
            name="wrap"
            checked={prefs.wrap}
            onChange={(e) => setPref("wrap", e.target.checked)}
          />
        </label>
      </section>

      <section className="settings-section">
        <h2>All devices</h2>
        <p className="settings-hint">
          These are server settings and affect every device, not just this one.
        </p>

        <label className="settings-field">
          <span>Telegram token</span>
          <input
            type="password"
            name="token"
            value={token}
            autoComplete="off"
            placeholder={tokenPlaceholder}
            onChange={(e) => setToken(e.target.value)}
          />
          {/* The placeholder attribute alone is not enough: it never shows
              while the field has focus, and a placeholder is not something
              an operator can screenshot-search or a test can rely on being
              painted. This status line is the same string, rendered as
              actual text. */}
          <span className="settings-token-status">{tokenPlaceholder}</span>
        </label>

        <label className="settings-field">
          <span>Chat id</span>
          <input
            type="text"
            name="chatId"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
          />
        </label>

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

        <div className="settings-field-row">
          <label className="settings-field">
            <span>Quiet hours start</span>
            <input
              type="time"
              name="quietStart"
              value={quietStart}
              onChange={(e) => setQuietStart(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>Quiet hours end</span>
            <input
              type="time"
              name="quietEnd"
              value={quietEnd}
              onChange={(e) => setQuietEnd(e.target.value)}
            />
          </label>
        </div>

        {saveError && <p className="settings-banner">{saveError}</p>}

        <div className="settings-actions">
          <button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={() => void sendTest()} disabled={testing}>
            {testing ? "Sending…" : "Send test message"}
          </button>
        </div>

        {testResult && (
          <p className={testResult.ok ? "settings-ok" : "settings-banner"}>
            {testResult.ok ? "Test message sent." : testResult.detail}
          </p>
        )}
      </section>
    </main>
  );
}
