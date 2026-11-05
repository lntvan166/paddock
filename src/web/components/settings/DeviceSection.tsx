import { RATE_MS, THEMES, type Prefs, type RatePref, type ThemePref } from "@web/prefs";
import { Card } from "@web/components/ui/Card";
import { Segmented } from "@web/components/ui/Segmented";
import { Toggle } from "@web/components/ui/Toggle";
import { ActivityIcon, MonitorIcon, TerminalIcon } from "@web/components/ui/icons";

const RATE_LABELS: Record<RatePref, string> = { live: "Live", balanced: "Balanced", frugal: "Frugal" };

interface DeviceSectionProps {
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
}

export function DeviceSection({ prefs, setPref }: DeviceSectionProps) {
  return (
    <>
      <Card
        icon={<MonitorIcon />}
        title="Theme"
        subtitle="Follow this device, or pin one."
        /* The select sits on the card's own heading row: a card that holds ONE
           control does not need a body under a divider to hold it (the
           data-terminal settings row — label left, control right). A
           `<select>`, not `Segmented`: it holds seven options, and on iOS it
           renders as the native wheel.

           No swatch previews, deliberately: `setPref` applies `themeAttr`
           synchronously, so changing the selection repaints the whole app at
           once — and it is why this needs no Save, like every other "This
           device" setting. */
        control={
          <select
            aria-label="Theme"
            data-field="theme"
            data-tour="theme-picker"
            value={prefs.theme}
            onChange={(e) => setPref("theme", e.target.value as ThemePref)}
          >
            {THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        }
      />

      <Card
        icon={<ActivityIcon />}
        title="Live updates"
        subtitle="How often paddock asks for a new screen."
      >
        <Segmented
          label="Refresh rate"
          value={prefs.rate}
          options={(Object.keys(RATE_MS) as RatePref[]).map((r) => ({ value: r, label: RATE_LABELS[r] }))}
          onChange={(v) => setPref("rate", v)}
        />
      </Card>

      <Card
        icon={<TerminalIcon />}
        title="Terminal"
        subtitle="How an agent's screen is drawn on this device."
      >
        <label className="card-row">
          <span>Font size</span>
          {/* Empty means "automatic", and that is the DEFAULT, not a reset
              button: styles.css sizes the pane with
              `clamp(0.75rem, 3.1vw, 0.85rem)` behind `var(--term-font-px, …)`,
              so leaving this blank is what keeps the responsive sizing in
              charge. An empty string must therefore write `null` (which
              removes the key) rather than `Number("")`, i.e. 0. */}
          <input
            type="number" name="fontPx" min={10} max={22} placeholder="Automatic"
            value={prefs.fontPx ?? ""}
            onChange={(e) => setPref("fontPx", e.target.value === "" ? null : Number(e.target.value))}
          />
        </label>

        <div className="card-row">
          <span>Wrap long lines</span>
          <Toggle
            label="Wrap long lines" checked={prefs.wrap}
            onChange={(v) => setPref("wrap", v)}
          />
        </div>

        <div className="card-row">
          {/* A DEVICE preference, not a server one, and deliberately so: it is
              about how much of this screen the pad is worth, and the same
              account on a laptop has room the phone does not. The pad itself is
              collapsed and expanded from the terminal view — this only governs
              whether a blocked agent may open it for you. It can never close
              it. */}
          <span>Open the keypad when an agent needs you</span>
          <Toggle
            label="Open the keypad when an agent needs you" checked={prefs.keypadAuto}
            onChange={(v) => setPref("keypadAuto", v)}
          />
        </div>
      </Card>
    </>
  );
}
