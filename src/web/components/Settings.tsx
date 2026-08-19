import { useEffect, useRef, useState } from "react";
import type { NotifyTrigger, SettingsPatch, SettingsView } from "@shared/types";
import {
  RATE_MS, readPrefs, themeAttr, writePref,
  type Prefs, type RatePref, type ThemePref,
} from "@web/prefs";

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

      <section className="settings-section">
        <h2>This device</h2>
        <p className="settings-hint">
          Stored in this browser only. Each device you open paddock on keeps its own copy.
        </p>

        <label className="settings-field">
          <span>Theme</span>
          <select
            name="theme"
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
          {/* Empty means "automatic", and that is the DEFAULT, not a reset
              button: styles.css sizes the pane with
              `clamp(0.62rem, 2.3vw, 0.78rem)` behind
              `var(--term-font-px, …)`, so leaving this blank is what keeps
              the responsive sizing in charge. An empty string must therefore
              write `null` (which removes the key) rather than `Number("")`,
              i.e. 0. */}
          <input
            type="number"
            name="fontPx"
            min={10}
            max={22}
            placeholder="Automatic"
            value={prefs.fontPx ?? ""}
            onChange={(e) =>
              setPref("fontPx", e.target.value === "" ? null : Number(e.target.value))
            }
          />
          <span className="settings-hint-inline">
            Leave blank to size the terminal to the screen.
          </span>
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
