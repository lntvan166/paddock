import {
  RATE_MS,
  type Prefs, type RatePref, type ThemePref,
} from "@web/prefs";

const RATE_LABELS: Record<RatePref, string> = { live: "Live", balanced: "Balanced", frugal: "Frugal" };

interface DeviceSectionProps {
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
}

export function DeviceSection({ prefs, setPref }: DeviceSectionProps) {
  return (
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

      <label className="settings-field settings-field-row">
        <span>Open the keypad when an agent needs you</span>
        {/* A DEVICE preference, not a server one, and deliberately so: it is
            about how much of this screen the pad is worth, and the same account
            on a laptop has room the phone does not. The pad itself is collapsed
            and expanded from the terminal view — this only governs whether a
            blocked agent may open it for you. It can never close it. */}
        <input
          type="checkbox"
          name="keypadAuto"
          checked={prefs.keypadAuto}
          onChange={(e) => setPref("keypadAuto", e.target.checked)}
        />
      </label>
    </section>
  );
}
