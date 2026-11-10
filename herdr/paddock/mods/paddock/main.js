// paddock beside your agents: turn the phone dashboard on and off, publish it on your tailnet or
// a quick tunnel, pair a phone, mute notifications, and see that it is healthy, without leaving
// Herdr. Everything goes through the `paddock` CLI (`paddock status --json`, `paddock local`, ...)
// and the running dashboard's own HTTP API on 127.0.0.1; the mod keeps no state of its own.
//
// Roles (props.role): the panel (default); "toggle", the tab-bar button that shows or hides the
// layout's "paddock-panel" node (or, in a layout without one, opens the panel as a dialog).
// `paddock mod install --layout <name>` adds both to a layout of yours.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  exec, run, theme, settings, layout, appHome, home, readTextFile, notify, shared, setShared,
  closeOverlay, props as blockProps, window as hostWindow,
} from "herdr";

const PANEL = "paddock-panel";
/** The first paddock whose `mod install` takes --button-only. */
const BUTTON_ONLY_SINCE = "0.16.2";
const STATE_KEY = "paddock.state"; // "running" | "stopped" | "unknown": the toggle's dot
const POLL_SHOWN = 5000, POLL_HIDDEN = 30000;
const TUNNEL_TIMES = [["30m", "30 min"], ["2h", "2 hours"], ["7d", "7 days"]];
const INSTALL_SCRIPT = "curl -fsSL https://trypaddock.vercel.app/install.sh | sh";
const INSTALL_BREW = "brew install lntvan166/paddock/paddock";
const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
/** cloudflared's default metrics ports: `/ready` answers {readyConnections} while a tunnel is up. */
const CLOUDFLARED_METRICS = [20241, 20242, 20243, 20244, 20245];
const CLOUDFLARED_DOWNLOAD = "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

// ---- Small helpers ----

const stop = (_e, cx) => cx.stop_propagation();
// cx.notify() throws while a view renders, so work started from render waits for the next tick.
const later = (cx, fn) => cx.spawn(async (cx) => { await cx.sleep(0); return fn(cx); });

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}

/** `a` is at least `b`, comparing x.y.z; a dev build (0.0.0-dev) counts as new enough. */
function atLeast(a, b) {
  if (typeof a !== "string") return false;
  if (a.startsWith("0.0.0")) return true;
  const x = a.split(/[.-]/).map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== y[i]) return (x[i] || 0) > y[i];
  return true;
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** 14:05. By hand: the host's toLocaleTimeString ignores its options and prints seconds. */
function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Milliseconds until the next 08:00 here. */
function untilMorning(now = Date.now()) {
  const d = new Date(now);
  d.setHours(8, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime() - now;
}

/** The last useful lines of a failed command, for the banner. */
function failure(r) {
  const text = `${r.stderr ?? ""}\n${r.stdout ?? ""}`.trim().split("\n").filter((l) => l.trim()).slice(-4).join("\n");
  return text || `exited with code ${r.code}`;
}

/**
 * Run a shell line in a new pane below, where the person sees it work. The pane waits for Enter
 * before it closes (a program exiting closes its pane), so the output can be read.
 */
function inPane(line) {
  run("pane.split", {
    direction: "down",
    argv: ["sh", "-c", `${line}; printf '\\n[%s] press Enter to close\\n' "$?"; read _`],
  });
}

function opener() {
  const p = hostWindow()?.platform;
  return p === "macos" ? ["open"] : p === "windows" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
}

// ---- Look ----
//
// Herdr's theme tokens, in the "true-black flat" app style: elevation by lightness alone (cards on
// `raised`, what sits inside them sunk back to `background`; `surface` is the ground itself in some
// themes, so it is not a step), no borders and no shadows on panels, the primary action made
// primary by inversion (`solid` on `solid_foreground`), and ONE data hue: the theme's own green
// (`ansi2`) on the routes that are live and on nothing else. Not paddock's coral, which read as a
// warning, and not the theme's `done`, which is blue in some themes: live means "go".

const icon = (name, size, color) => svg(`mods/paddock/${name}.svg`).size(size).flex_none().text_color(color);
const dot = (color, size = 8) => div().w(size).h(size).flex_none().rounded_full().bg(color);

function S() {
  const b = Number(settings().ui_font_size) || 13;
  return { hero: b + 7, title: b + 1, body: b, meta: b - 1.5, code: b + 9 };
}
const mono = () => settings().font_family || "JetBrains Mono";

/** The primary action: an ink pill, 36px. One per screen. */
function primary(id, label, t, onClick) {
  return h_flex().id(id).h(36).px(18).flex_none().items_center().justify_center().rounded_full()
    .bg(t.solid).text_color(t.solid_foreground).text_size(S().body).font_semibold()
    .cursor_pointer().hover((s) => s.opacity(0.88)).on_mouse_down("left", stop).on_click(onClick)
    .child(label);
}

/** Everything else: text with a hover ground. Red only for what takes something down. */
function quiet(id, label, t, onClick, danger = false) {
  return h_flex().id(id).h(30).px(10).flex_none().items_center().rounded_full()
    .text_size(S().body).text_color(danger ? t.blocked : t.foreground)
    .cursor_pointer().hover((s) => s.bg(t.background)).on_mouse_down("left", stop).on_click(onClick)
    .child(label);
}

const working = (t, label) => h_flex().h(30).gap(8).items_center().text_size(S().body).text_color(t.muted)
  .child(icon("spinner", 14, t.muted).spin(900)).child(`${label}…`);

/** A 28x16 switch: ink when on. Its row's title says what it switches. */
function toggle(id, on, t, onClick, disabled = false) {
  return h_flex().id(id).w(28).h(16).p(2).flex_none().rounded_full()
    .bg(on ? t.foreground : t.input).when(on, (el) => el.justify_end())
    .when(!disabled, (el) => el.cursor_pointer().on_mouse_down("left", stop).on_click(onClick))
    .when(disabled, (el) => el.opacity(0.4))
    .child(div().w(12).h(12).rounded_full().bg(on ? t.background : t.muted));
}

/** One setting: title and its state word, a line of what it does, the control on the right. */
function setting(t, { id, title, state, desc, control, body }) {
  return v_flex().id(id).gap(4)
    .child(h_flex().gap(10).items_center()
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(div().text_size(S().title).font_weight(500).child(title))
        .when(Boolean(state), (el) => el.child(div().text_size(S().meta).text_color(t.muted).child(state))))
      .children(control ? [control] : []))
    .when(Boolean(desc), (el) => el.child(div().text_size(S().body).text_color(t.muted).child(desc)))
    .children(body ? [body] : []);
}

/**
 * A group of settings on the raised step, under a quiet sentence-case title. Rows are split by a
 * 1px groove in the ground's colour: a line sunk into the panel, not a border drawn on it.
 */
function group(t, title, items) {
  const rows = [];
  for (const item of items.filter(Boolean)) {
    if (rows.length) rows.push(div().h(1).flex_none().bg(t.background));
    rows.push(v_flex().px(14).py(12).child(item));
  }
  return v_flex().gap(8)
    .child(div().px(4).text_size(S().meta).text_color(t.muted).child(title))
    .child(v_flex().rounded(14).bg(t.raised).overflow_hidden().children(rows));
}

const actions = (...els) => h_flex().gap(6).items_center().flex_wrap().children(els.filter(Boolean));

/** Choices on one line, the chosen one on the raised step. */
function choices(id, options, value, t, onPick) {
  return h_flex().gap(4).children(options.map(([k, label]) => {
    const on = k === value;
    return h_flex().id(`${id}-${k}`).h(28).px(12).items_center().rounded_full()
      .when(on, (el) => el.bg(t.background)).text_size(S().body).text_color(on ? t.foreground : t.muted)
      .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click((_e, cx) => onPick(k, cx)).child(label);
  }));
}

/** A QR code from rows of "1" (dark) and "0", drawn as runs so it is a few dozen elements, not 900. */
function qr(rows, cell = 4) {
  const quietZone = 4 * cell, n = rows.length;
  return v_flex().flex_none().p(quietZone).bg("#ffffff").rounded(10).w(n * cell + quietZone * 2)
    .children(rows.map((r, y) => {
      const runs = [];
      for (let x = 0; x < r.length;) {
        let end = x;
        while (end < r.length && r[end] === r[x]) end++;
        runs.push(div().w((end - x) * cell).h(cell).flex_none().bg(r[x] === "1" ? "#000000" : "#ffffff"));
        x = end;
      }
      return h_flex().id(`qr-${y}`).children(runs);
    }));
}

/**
 * The route a phone takes to the agents: Herdr, then paddock, then the phone. A segment is lit in
 * the theme's green when it carries traffic, so "can my phone reach them?" is read before any word.
 */
function route(t, nodes, links) {
  const node = ([label, caption, live]) => v_flex().flex_none().items_center().gap(4).w(76)
    .child(dot(live ? t.ansi2 : t.dim, 10))
    .child(div().text_size(S().body).font_weight(500).text_color(live ? t.foreground : t.muted).child(label))
    .child(div().text_size(S().meta).text_color(t.muted).truncate().child(caption));
  const link = (live) => div().flex_1().h(2).mt(4).rounded_full().bg(live ? t.ansi2 : t.input);
  return h_flex().items_start().px(2)
    .child(node(nodes[0])).child(link(links[0])).child(node(nodes[1])).child(link(links[1])).child(node(nodes[2]));
}

// ---- The tab-bar button ----

function tabButton(t) {
  const node = find(layout(), PANEL), on = node && !node.hidden;
  const state = shared(STATE_KEY);
  const color = state === "running" ? t.ansi2 : state === "unknown" ? t.blocked : t.dim;
  return h_flex().size_full().pr(10).items_center().justify_end().bg(t.chrome)
    .child(h_flex().id("toggle-paddock").h(26).px(8).gap(6).flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => (node ? run("layout.toggle", { id: PANEL }) : run("mod.open", { name: "paddock" })))
      .child(image("mods/paddock/mark.svg").w(16).h(16).flex_none().rounded(3))
      .child("paddock")
      .child(dot(color, 6)));
}

// ---- The panel ----

export default class Paddock extends View {
  init(_props, cx) {
    // From the host's props(), not init's argument (which does not carry the layout's props).
    this.role = blockProps()?.role ?? "panel";
    if (this.role === "toggle") return;
    this.bin = "paddock";
    this.status = null;       // `paddock status --json`
    this.statusError = null;  // why it could not be read
    this.statusKind = null;   // "missing" (no paddock) | "old" (no status --json) | null
    this.health = null;       // GET /api/health
    this.settings = null;     // GET /api/settings
    this.apiError = null;
    this.named = null;        // { url, ready }: a domain of the person's own, and cloudflared's live tunnels
    this.busy = null;         // the label of the action running now
    this.error = null;        // the last action's failure, until dismissed
    this.confirmStop = false;
    this.askMute = false;     // the Push switch was turned off: ask for how long
    this.tunnelFor = "2h";
    this.loadedAt = 0;
    this.refreshing = false;
    cx.spawn(async (cx) => {
      const cfg = await readTextFile(`${appHome()}/mods/paddock/config.json`).catch(() => null);
      try { const bin = cfg ? JSON.parse(cfg).bin : null; if (typeof bin === "string" && bin) this.bin = bin; }
      catch { this.statusError = "mods/paddock/config.json is not valid JSON; using `paddock` from PATH"; }
      await this.refresh(cx);
    });
    cx.timer.every(POLL_SHOWN, (cx) => {
      const every = this.shown() ? POLL_SHOWN : POLL_HIDDEN;
      if (Date.now() - this.loadedAt >= every - 100) this.refresh(cx);
    });
  }

  shown() {
    if (blockProps()?.overlay) return true;
    const node = find(layout(), PANEL);
    return !node || !node.hidden;
  }

  port() {
    const p = this.status?.paddock;
    return p && (p.state === "running" || p.state === "untracked") ? p.port : null;
  }

  async refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      let r = null;
      try { r = await exec(this.bin, ["status", "--json"], { timeout: 15000 }); }
      catch (e) {
        // The install script puts paddock in ~/.local/bin, which a desktop session's PATH may lack.
        const local = `${home()}/.local/bin/paddock`;
        if (this.bin === "paddock") {
          try { r = await exec(local, ["status", "--json"], { timeout: 15000 }); this.bin = local; }
          catch { /* not there either: reported below */ }
        }
        if (!r) { this.statusKind = "missing"; this.statusError = `paddock is not installed here (${e.message ?? e})`; this.status = null; }
      }
      if (r) {
        // The exit code says running or not; the JSON is on stdout either way.
        try { this.status = JSON.parse(r.stdout.trim().split("\n").pop() ?? ""); this.statusError = null; this.statusKind = null; }
        catch {
          this.statusKind = "old"; this.status = null;
          const v = /paddock (\S+)/.exec(r.stdout)?.[1];
          this.statusError = `This paddock${v ? ` (${v})` : ""} is too old for the panel, which needs 0.16 or later.`;
        }
      }
      const port = this.port();
      this.health = null; this.settings = null; this.apiError = null;
      if (port !== null) {
        try {
          const [h, s] = await Promise.all([
            fetch(`http://127.0.0.1:${port}/api/health`).then((x) => x.json()),
            fetch(`http://127.0.0.1:${port}/api/settings`).then((x) => x.json()),
          ]);
          this.health = h; this.settings = s;
        } catch (e) { this.apiError = `the dashboard did not answer on port ${port}: ${e.message ?? e}`; }
      }
      // A domain of the person's own (a Cloudflare named tunnel behind Access). Asking the URL says
      // nothing: Access answers at the edge whether or not the tunnel is up. What does say it is
      // the cloudflared running here: its metrics `/ready` counts its live connections.
      this.named = null;
      const publicUrl = this.settings?.publicUrl;
      if (typeof publicUrl === "string" && publicUrl) {
        let ready = 0;
        for (const p of CLOUDFLARED_METRICS) {
          try {
            const r = await (await fetch(`http://127.0.0.1:${p}/ready`)).json();
            if (r && r.status === 200) ready++;
          } catch { /* nothing on that port: the usual case */ }
        }
        // The quick tunnel paddock opens runs a cloudflared of its own; it is not the named one.
        if (this.status?.tunnel?.state === "running" && ready > 0) ready--;
        this.named = { url: publicUrl, ready };
      }
      const state = this.statusError ? "unknown" : this.port() !== null ? "running" : "stopped";
      if (shared(STATE_KEY) !== state) setShared(STATE_KEY, state);
      this.loadedAt = Date.now();
    } finally {
      this.refreshing = false;
      cx.notify();
    }
  }

  /**
   * Run `paddock <args>`, show it busy, report a failure, then read everything again.
   * `restarts`: the command restarts the service (`local`, `tailscale [off]`), so the dashboard
   * is down for a few seconds; the panel waits for it to come back rather than reading
   * "Stopped" in that gap.
   */
  act(cx, label, args, timeout = 60000, restarts = false) {
    if (this.busy) return;
    this.busy = label; this.error = null; this.confirmStop = false;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(this.bin, args, { timeout });
        if (r.code !== 0) this.error = `${label} failed:\n${failure(r)}`;
        else notify({ title: "paddock", body: `${label}: done`, level: "success", timeout: 2500 });
      } catch (e) {
        this.error = `${label} failed: ${e.message ?? e}`;
      }
      if (restarts && !this.error) {
        this.busy = "Restarting paddock";
        cx.notify();
        for (let i = 0; i < 20; i++) {
          await this.refresh(cx);
          if (this.health) break; // the dashboard answers again
          await cx.sleep(750);
        }
        if (!this.health) this.error = `${label}: paddock did not come back within 15 seconds; Logs shows why`;
      }
      this.busy = null;
      await this.refresh(cx);
    });
  }

  /** A write to the dashboard's own API (mute, triggers, bridge). */
  api(cx, label, method, path, body) {
    const port = this.port();
    if (port === null || this.busy) return;
    this.busy = label; this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try { detail = (await res.json()).detail ?? detail; } catch { /* the status is the detail */ }
          this.error = `${label} failed: ${detail}`;
        }
      } catch (e) {
        this.error = `${label} failed: ${e.message ?? e}`;
      }
      this.busy = null;
      await this.refresh(cx);
    });
  }

  open(url) {
    const [cmd, ...pre] = opener();
    exec(cmd, [...pre, url]).catch((e) => notify({ title: "paddock", body: `could not open ${url}: ${e.message ?? e}`, level: "error" }));
  }

  render(cx) {
    const t = theme();
    if (this.role === "toggle") return tabButton(t);
    const overlay = blockProps()?.overlay;
    const node = find(layout(), PANEL);
    const close = overlay ? () => closeOverlay(overlay) : node ? () => run("layout.hide", { id: PANEL }) : null;

    return v_flex().id("paddock").size_full().min_h(0).overflow_hidden()
      .bg(t.background).text_color(t.foreground).text_size(S().body)
      .when(!overlay, (el) => el.rounded(12))
      .child(h_flex().h(44).flex_none().pl(16).pr(8).gap(10).items_center()
        .child(image("mods/paddock/mark.svg").w(20).h(20).flex_none().rounded(5))
        .child(div().flex_1().text_size(S().title).font_semibold().child("paddock"))
        .when(Boolean(close), (el) => el.child(h_flex().id("close").size(28).justify_center().items_center().rounded_full()
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(close)
          .child(icon("close", 14, t.muted)))))
      .child(v_flex().id("body").flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(16).gap(20)
        .children(this.body(t)))
      .children(this.error ? [this.banner(t)] : []);
  }

  banner(t) {
    return h_flex().flex_none().mx(12).mb(12).p(12).gap(10).items_start().rounded(12).bg(t.raised)
      .child(dot(t.blocked, 8).mt(5))
      .child(div().flex_1().text_size(S().body).text_color(t.foreground).child(this.error))
      .child(h_flex().id("dismiss").size(24).justify_center().items_center().rounded_full().cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.error = null; cx.notify(); })
        .child(icon("close", 12, t.muted)));
  }

  /** The card at the top: what the panel exists to say, and the one thing to do next. */
  card(t, { headline, finding, routeEl, main, rest }) {
    return v_flex().p(16).gap(14).rounded(16).bg(t.raised)
      .child(v_flex().gap(4)
        .child(div().text_size(S().hero).font_semibold().child(headline))
        .child(div().text_size(S().body).text_color(t.muted).child(finding)))
      .children(routeEl ? [v_flex().py(12).rounded(12).bg(t.background).child(routeEl)] : [])
      .child(this.busy ? working(t, this.busy) : actions(main, ...(rest ?? [])));
  }

  body(t) {
    const mac = hostWindow()?.platform === "macos";
    const again = quiet("check-again", "Check again", t, (_e, cx) => this.refresh(cx));
    if (this.statusError && !this.status) {
      if (this.statusKind === "missing") {
        return [this.card(t, {
          headline: "paddock isn't installed",
          finding: `It is the phone dashboard this panel runs. ${mac ? INSTALL_BREW : INSTALL_SCRIPT} installs it to ~/.local/bin, no sudo; it runs in a pane below so you see what it does.`,
          main: primary("install", "Install paddock", t, () => inPane(mac ? INSTALL_BREW : INSTALL_SCRIPT)),
          rest: [mac ? quiet("install-script", "Use the script", t, () => inPane(INSTALL_SCRIPT)) : null, again],
        })];
      }
      if (this.statusKind === "old") {
        return [this.card(t, {
          headline: "paddock needs an update",
          finding: this.statusError,
          main: primary("update-old", "Update paddock", t, () => inPane(`'${this.bin}' update`)),
          rest: [again],
        })];
      }
      return [this.card(t, { headline: "paddock didn't answer", finding: this.statusError, main: again })];
    }
    if (!this.status) return [this.card(t, { headline: "Looking for paddock", finding: "Reading its status…", main: null })];
    return [this.top(t), this.buttonOffer(t), this.reach(t), this.notifications(t), this.about(t)].filter(Boolean);
  }

  /**
   * Opened from the palette or the gallery, with no button in the layout: offer to add one. Without
   * it the only way back to this panel is the command palette, which nobody remembers. paddock
   * edits the layout (`mod install --button-only`), copying Herdr's own layouts first, since Herdr
   * rewrites those on every start.
   */
  buttonOffer(t) {
    if (find(layout(), PANEL)) return null;
    // An older paddock ignores --button-only, and would copy ITS mod files over these.
    const can = atLeast(this.status?.paddock?.version, BUTTON_ONLY_SINCE);
    return group(t, "This window", [
      setting(t, { id: "button", title: "Tab bar button", state: "not added",
        desc: can
          ? "A paddock button beside your tabs shows and hides this panel."
          : `A paddock button beside your tabs shows and hides this panel. Adding it needs paddock ${BUTTON_ONLY_SINCE} or later.`,
        body: this.busy ? null : actions(can
          ? primary("add-button", "Add the button", t,
            (_e, cx) => this.act(cx, "Adding the button", ["mod", "install", "--button-only"], 30000))
          : primary("update-for-button", "Update paddock", t,
            (_e, cx) => this.act(cx, "Updating paddock", ["update"], 300000))) }),
    ]);
  }

  top(t) {
    const st = this.status, p = st.paddock, svc = st.service, h = this.health;
    const ts = st.tailscale, tn = st.tunnel;
    const running = p.state === "running";
    const tsUp = ts?.state === "up", tnUp = tn?.state === "running";
    const ownUp = Boolean(this.named && this.named.ready > 0);
    const herdrUp = Boolean(h && (h.herdrConnected || h.core?.connected));
    const phones = this.settings?.push?.devices ?? 0;
    const openLocal = running ? quiet("open-local", "Open dashboard", t, () => this.open(`http://127.0.0.1:${p.port}`)) : null;

    const routeEl = route(t, [
      ["Herdr", h ? `${h.agents} agent${h.agents === 1 ? "" : "s"}` : "—", herdrUp],
      ["paddock", running ? `:${p.port}` : "off", running],
      ["Phone", ownUp ? "own domain" : tnUp ? "public link" : tsUp ? "tailnet" : "no route", running && (ownUp || tnUp || tsUp)],
    ], [running && herdrUp, running && (ownUp || tnUp || tsUp)]);

    if (p.state === "untracked") {
      return this.card(t, {
        headline: "Running, but not tracked",
        finding: `Something answers on port ${p.port} (paddock ${p.version}) that no record describes. Stop it by hand, then start it here.`,
        routeEl, main: null,
      });
    }
    if (p.state === "unknown") return this.card(t, { headline: "paddock's state is unreadable", finding: p.error, main: null });
    if (!running) {
      return this.card(t, {
        headline: "paddock is off",
        finding: svc?.state === "failing"
          ? `Its ${svc.kind} service is registered but not serving: usually because herdr is not running.`
          : "Start it to watch and answer your agents from your phone. It comes back after a reboot.",
        routeEl,
        main: primary("start", "Start paddock", t, (_e, cx) => this.act(cx, "Starting paddock", ["local"], 60000, true)),
      });
    }
    if (ownUp) {
      const host = this.named.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
      return this.card(t, {
        headline: "On your phone, at your domain",
        finding: `${host}, behind Cloudflare Access · ${phones} phone${phones === 1 ? "" : "s"} get pushes`,
        routeEl,
        main: primary("open-own", "Open dashboard", t, () => this.open(`http://127.0.0.1:${p.port}`)),
      });
    }
    if (tnUp || tsUp) {
      const where = tnUp
        ? (tn.until ? `Public link closes at ${clock(tn.until)}` : "Public link open until you close it")
        : `On ${ts.url.replace("https://", "")}`;
      return this.card(t, {
        headline: tnUp ? "On your phone, anywhere" : "On your phone, on your tailnet",
        finding: `${where} · ${phones} phone${phones === 1 ? "" : "s"} get pushes`,
        routeEl,
        main: primary("open-main", "Open dashboard", t, () => this.open(`http://127.0.0.1:${p.port}`)),
      });
    }
    const hasCf = st.tools?.cloudflared !== null, hasTs = st.tools?.tailscale !== null;
    const next = hasCf
      ? primary("open-tunnel-main", "Open a 2-hour link", t, (_e, cx) => this.act(cx, "Opening a public link", ["start", "--for", "2h"], 120000))
      : hasTs
        ? primary("ts-main", "Put it on my tailnet", t, (_e, cx) => this.act(cx, "Turning on Tailscale, restarts paddock", ["tailscale"], 120000, true))
        : primary("open-main", "Open dashboard", t, () => this.open(`http://127.0.0.1:${p.port}`));
    return this.card(t, {
      headline: "Only on this computer",
      finding: "Your phone can't reach it yet: open a public link, or put it on your tailnet.",
      routeEl, main: next,
      rest: [hasCf || hasTs ? openLocal : null],
    });
  }

  reach(t) {
    const st = this.status;
    if (st.paddock.state !== "running") return null;
    const ts = st.tailscale, tn = st.tunnel, busy = Boolean(this.busy);
    const mac = hostWindow()?.platform === "macos";
    const hasTs = st.tools?.tailscale !== null, hasCf = st.tools?.cloudflared !== null;

    // Tailscale
    let tsItem;
    if (ts === null && !hasTs) {
      tsItem = setting(t, { id: "ts", title: "Tailscale", state: "not installed",
        desc: "Needs Tailscale on this machine, signed in.",
        body: actions(quiet("ts-get", "Get Tailscale", t, () => this.open(TAILSCALE_DOWNLOAD)), quiet("ts-recheck", "Check again", t, (_e, cx) => this.refresh(cx))) });
    } else if (ts === null) {
      tsItem = setting(t, { id: "ts", title: "Tailscale", state: "off",
        desc: "A stable address, for your login only.",
        control: toggle("ts-toggle", false, t, (_e, cx) => this.act(cx, "Turning on Tailscale, restarts paddock", ["tailscale"], 120000, true), busy) });
    } else if (ts.state === "up") {
      tsItem = setting(t, { id: "ts", title: "Tailscale", state: `on · ${ts.login}`,
        control: toggle("ts-toggle", true, t, (_e, cx) => this.act(cx, "Turning off Tailscale, restarts paddock", ["tailscale", "off"], 60000, true), busy),
        body: h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(S().body).child(ts.url.replace("https://", "")))
          .child(quiet("ts-open", "Open", t, () => this.open(ts.url))) });
    } else {
      tsItem = setting(t, { id: "ts", title: "Tailscale", state: ts.state === "down" ? "not serving" : "unknown",
        desc: ts.detail,
        control: toggle("ts-toggle", true, t, (_e, cx) => this.act(cx, "Turning off Tailscale, restarts paddock", ["tailscale", "off"], 60000, true), busy),
        body: actions(busy ? null : quiet("ts-fix", "Repair", t, (_e, cx) => this.act(cx, "Repairing Tailscale", ["tailscale"], 120000, true))) });
    }

    // Public link (quick tunnel)
    let tnItem;
    if (tn === null && !hasCf) {
      tnItem = setting(t, { id: "tn", title: "Public link", state: "needs cloudflared",
        desc: "Needs cloudflared on this machine.",
        body: actions(mac
          ? quiet("cf-install", "Install with Homebrew", t, () => inPane("brew install cloudflared"))
          : quiet("cf-get", "Get cloudflared", t, () => this.open(CLOUDFLARED_DOWNLOAD)),
          quiet("cf-recheck", "Check again", t, (_e, cx) => this.refresh(cx))) });
    } else if (tn === null) {
      tnItem = setting(t, { id: "tn", title: "Public link", state: "off",
        desc: "Anyone with the pairing code. Closes by itself.",
        control: toggle("tn-toggle", false, t, (_e, cx) => this.act(cx, "Opening a public link", ["start", "--for", this.tunnelFor], 120000), busy),
        body: choices("for", TUNNEL_TIMES, this.tunnelFor, t, (k, cx) => { this.tunnelFor = k; cx.notify(); }) });
    } else if (tn.state === "unknown") {
      tnItem = setting(t, { id: "tn", title: "Public link", state: "unknown", desc: `Its state could not be read: ${tn.error}` });
    } else {
      const pair = tn.pair;
      tnItem = setting(t, { id: "tn", title: "Public link",
        state: tn.until ? `on · closes ${clock(tn.until)}` : "on",
        control: toggle("tn-toggle", true, t, (_e, cx) => this.act(cx, "Closing the public link", ["tunnel", "stop"]), busy),
        body: v_flex().gap(10).pt(4)
          .children(pair ? [h_flex().gap(14).items_center()
            .child(qr(pair.qr))
            .child(v_flex().gap(2).min_w(0)
              .child(div().text_size(S().meta).text_color(t.muted).child("Pairing code"))
              .child(div().font_family(mono()).text_size(S().code).font_semibold().child(pair.code))
              .child(div().text_size(S().meta).text_color(t.muted).child(pair.expiresAt > Date.now() ? `changes at ${clock(pair.expiresAt)}` : "renews on the next read")))]
            : [div().text_size(S().body).text_color(t.muted).child("The link did not answer for its pairing code; `paddock pair` in a terminal shows why.")])
          .child(h_flex().gap(6).items_center()
            .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(S().body).child(tn.url.replace("https://", "")))
            .child(quiet("tn-open", "Open", t, () => this.open(tn.url)))) });
    }
    let ownItem = null;
    if (this.named) {
      const host = this.named.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
      ownItem = setting(t, { id: "own", title: "Your domain",
        state: this.named.ready > 0 ? "connected · Cloudflare Access" : "not connected",
        desc: this.named.ready > 0 ? null : "No cloudflared tunnel is connected here: start yours.",
        body: h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(S().body).child(host))
          .child(quiet("own-open", "Open", t, () => this.open(this.named.url))) });
    }
    return group(t, "Reach it from your phone", [ownItem, tnItem, tsItem]);
  }

  notifications(t) {
    const s = this.settings;
    if (!s?.notify) return null;
    const n = s.notify, busy = Boolean(this.busy);
    const muted = n.mutedUntil !== null && n.mutedUntil > Date.now();
    const triggers = new Set(n.triggers);
    const devices = s.push?.devices ?? 0;
    const flip = (k) => (_e, cx) => {
      const next = new Set(triggers);
      if (next.has(k)) next.delete(k); else next.add(k);
      this.api(cx, "Changing notifications", "PUT", "/api/settings", { notify: { triggers: [...next] } });
    };
    const push = setting(t, { id: "push", title: "Push",
      state: muted ? `muted until ${clock(n.mutedUntil)}` : `${devices} device${devices === 1 ? "" : "s"}`,
      control: toggle("push-toggle", !muted, t, (_e, cx) => {
        if (muted) this.api(cx, "Unmuting", "POST", "/api/settings/mute", { forMs: 0 });
        else { this.askMute = !this.askMute; cx.notify(); }
      }, busy),
      body: this.askMute && !muted ? actions(
        div().text_size(S().body).text_color(t.muted).pr(4).child("Mute for"),
        quiet("mute-1h", "1 hour", t, (_e, cx) => { this.askMute = false; this.api(cx, "Muting", "POST", "/api/settings/mute", { forMs: 3600000 }); }),
        quiet("mute-morning", "until 8:00", t, (_e, cx) => { this.askMute = false; this.api(cx, "Muting", "POST", "/api/settings/mute", { forMs: untilMorning() }); }),
      ) : null });
    return group(t, "Notifications", [
      push,
      setting(t, { id: "on-blocked", title: "When an agent needs you", control: toggle("on-blocked-toggle", triggers.has("blocked"), t, flip("blocked"), busy) }),
      setting(t, { id: "on-done", title: "When an agent finishes", control: toggle("on-done-toggle", triggers.has("done"), t, flip("done"), busy) }),
    ]);
  }

  about(t) {
    const h = this.health, st = this.status, p = st.paddock, svc = st.service;
    const stopBtn = this.confirmStop
      ? quiet("stop-confirm", "Stop it, and the links", t, (_e, cx) => this.act(cx, "Stop", ["stop"]), true)
      : quiet("stop", "Stop", t, (_e, cx) => { this.confirmStop = true; cx.notify(); }, true);
    const logs = svc?.logHint ? quiet("logs", "Logs", t, () => {
      const argv = svc.logHint.startsWith("journalctl") ? [...svc.logHint.split(" "), "-f"] : ["tail", "-f", svc.logHint];
      run("pane.split", { direction: "down", argv });
    }) : null;

    if (!h) return this.apiError ? group(t, "paddock", [setting(t, { id: "api", title: "Dashboard", state: "not answering", desc: this.apiError })]) : null;
    const bridge = this.settings?.bridge?.enabled === true;
    const latest = h.latestKnown, current = h.version;
    const update = latest && current && latest !== current && !current.startsWith("0.0.0");
    const backend = (on, label) => h_flex().gap(6).items_center().child(dot(on ? t.ansi2 : t.dim, 6))
      .child(div().text_size(S().body).text_color(on ? t.foreground : t.muted).child(label));
    return group(t, "paddock", [
      setting(t, { id: "bridge", title: "MCP bridge",
        desc: "Other Claude Code sessions can hand work to these agents.",
        control: toggle("bridge-toggle", bridge, t, (_e, cx) => this.api(cx, "Changing the MCP bridge", "PUT", "/api/settings", { bridge: { enabled: !bridge } }), Boolean(this.busy)) }),
      setting(t, { id: "backends", title: "Reads agents from",
        body: h_flex().gap(16).pt(2).child(backend(h.herdrConnected, "terminal herdr")).child(backend(h.core?.connected === true, "Herdr app")) }),
      h.lastNotifyError ? setting(t, { id: "notify-error", title: "Last notification failed", desc: h.lastNotifyError }) : null,
      setting(t, { id: "version", title: `paddock ${p.version}`,
        state: `up ${ago(Date.now() - p.startedAt)} · ${svc ? `${svc.kind}, starts at ${svc.startsAt ?? "login"}` : "in a terminal"}`,
        body: this.busy ? null : actions(
          update ? primary("update", `Update to ${latest}`, t, (_e, cx) => this.act(cx, "Updating paddock", ["update"], 300000)) : null,
          !svc ? quiet("as-service", "Run as a service", t, (_e, cx) => this.act(cx, "Making it a service", ["local"], 60000, true)) : null,
          logs, stopBtn) }),
    ]);
  }
}
