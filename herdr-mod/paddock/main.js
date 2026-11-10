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
const STATE_KEY = "paddock.state"; // "running" | "stopped" | "unknown": the toggle's dot
const POLL_SHOWN = 5000, POLL_HIDDEN = 30000;
const TUNNEL_TIMES = [["30m", "30 min"], ["2h", "2 hours"], ["7d", "7 days"]];
const INSTALL_SCRIPT = "curl -fsSL https://trypaddock.vercel.app/install.sh | sh";
const INSTALL_BREW = "brew install lntvan166/paddock/paddock";
const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
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

function S() {
  const b = Number(settings().ui_font_size) || 13;
  return { title: b + 1, body: b, small: b - 1.5, big: b + 6 };
}
const mono = () => settings().font_family || "JetBrains Mono";

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
  const p = hostWindow().platform;
  return p === "macos" ? ["open"] : p === "windows" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
}

// ---- Look (Herdr theme tokens only) ----

/** Green for "up": the theme's own green (ansi 2), not `done`, which some themes make blue. */
const good = (t) => t.ansi2 ?? t.done;
const icon = (name, size, color) => svg(`mods/paddock/${name}.svg`).size(size).flex_none().text_color(color);
const dot = (color, size = 8) => div().w(size).h(size).flex_none().rounded_full().bg(color);

function button(id, label, t, onClick, opts = {}) {
  const solid = opts.primary;
  return h_flex().id(id).h(28).px(12).gap(6).flex_none().items_center().rounded(6)
    .when(solid, (el) => el.bg(t.solid).text_color(t.solid_foreground).font_semibold().hover((s) => s.opacity(0.88)))
    .when(!solid, (el) => el.border_1().border_color(opts.danger ? t.blocked : t.border)
      .text_color(opts.danger ? t.blocked : t.foreground).hover((s) => s.bg(t.hover)))
    .text_size(S().small).cursor_pointer().on_mouse_down("left", stop).on_click(onClick)
    .child(label);
}

const busyButton = (id, label, t) => h_flex().id(id).h(28).px(12).gap(6).flex_none().items_center().rounded(6)
  .border_1().border_color(t.border).text_size(S().small).text_color(t.muted)
  .child(icon("spinner", 13, t.muted).spin(900)).child(label);

function chip(id, label, on, t, onClick) {
  return h_flex().id(id).h(24).px(10).gap(6).flex_none().items_center().rounded(12)
    .bg(on ? t.selected : t.background).border_1().border_color(on ? t.accent : t.border)
    .text_size(S().small).text_color(on ? t.foreground : t.muted).cursor_pointer()
    .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(onClick)
    .child(dot(on ? t.accent : t.dim, 6)).child(label);
}

/** The On / Off label a section header carries, so its state reads at a glance. */
function pill(t, label, on, warn = false) {
  const color = warn ? t.blocked : on ? good(t) : t.dim;
  return h_flex().h(20).px(8).gap(5).flex_none().items_center().rounded(10)
    .border_1().border_color(color).text_size(S().small).font_semibold().text_color(on || warn ? t.foreground : t.muted)
    .child(dot(color, 6)).child(label);
}

function section(t, title, right, body) {
  return v_flex().flex_none().px(14).py(12).gap(10).border_b(1).border_color(t.border)
    .child(h_flex().items_center().gap(8)
      .child(div().flex_1().text_size(S().small).font_semibold().text_color(t.muted).child(title.toUpperCase()))
      .children(right ? [right] : []))
    .child(body);
}

const line = (t, text, color) => div().text_size(S().body).text_color(color ?? t.foreground).child(text);
const note = (t, text) => div().text_size(S().small).text_color(t.muted).child(text);
const row = (...children) => h_flex().gap(8).items_center().flex_wrap().children(children.filter(Boolean));

/** A QR code from rows of "1" (dark) and "0", drawn as runs so it is a few dozen elements, not 900. */
function qr(t, rows, cell = 4) {
  const quiet = 4 * cell, n = rows.length;
  return v_flex().flex_none().p(quiet).bg("#ffffff").rounded(6).w(n * cell + quiet * 2)
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

// ---- The tab-bar button ----

function toggle(t) {
  const node = find(layout(), PANEL), on = node && !node.hidden;
  const state = shared(STATE_KEY);
  const color = state === "running" ? good(t) : state === "unknown" ? t.blocked : t.dim;
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
    this.busy = null;         // the label of the action running now
    this.error = null;        // the last action's failure, until dismissed
    this.confirmStop = false;
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
    if (this.role === "toggle") return toggle(t);
    const overlay = blockProps()?.overlay;
    const node = find(layout(), PANEL);
    const close = overlay
      ? () => closeOverlay(overlay)
      : node ? () => run("layout.hide", { id: PANEL }) : null;

    const version = this.status?.paddock?.version;
    return v_flex().id("paddock").size_full().min_h(0).overflow_hidden()
      .bg(t.background).text_color(t.foreground).text_size(S().body)
      .when(!overlay, (el) => el.rounded(10).border_1().border_color(t.border))
      .child(h_flex().h(42).flex_none().pl(14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(image("mods/paddock/mark.svg").w(18).h(18).flex_none().rounded(4))
        .child(div().flex_1().text_size(S().title).font_semibold().child("paddock"))
        .when(Boolean(version), (el) => el.child(div().text_size(S().small).text_color(t.muted).child(`v${version}`)))
        .when(Boolean(close), (el) => el.child(h_flex().id("close").size(24).justify_center().items_center().rounded(6)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(close)
          .child(icon("close", 14, t.muted)))))
      .child(v_flex().id("body").flex_1().min_h(0).overflow_y_scrollbar()
        .children(this.sections(t, cx)))
      .children(this.error ? [this.banner(t)] : []);
  }

  banner(t) {
    return h_flex().flex_none().px(14).py(10).gap(8).items_start().bg(t.raised).border_t(1).border_color(t.blocked)
      .child(div().flex_1().text_size(S().small).text_color(t.blocked).child(this.error))
      .child(h_flex().id("dismiss").size(20).justify_center().items_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.error = null; cx.notify(); })
        .child(icon("close", 12, t.muted)));
  }

  sections(t, cx) {
    if (this.statusError && !this.status) {
      const mac = hostWindow().platform === "macos";
      const again = button("check-again", "Check again", t, (_e, cx) => this.refresh(cx));
      if (this.statusKind === "missing") {
        return [section(t, "paddock", pill(t, "Not installed", false, true), v_flex().gap(10)
          .child(line(t, "paddock is the phone dashboard this panel drives. Install it once:"))
          .child(div().font_family(mono()).text_size(S().small).text_color(t.muted).child(mac ? INSTALL_BREW : INSTALL_SCRIPT))
          .child(note(t, "It installs to ~/.local/bin, no sudo, checksum verified. The command runs in a pane below, so you see what it does."))
          .child(row(
            button("install", "Install paddock", t, () => inPane(mac ? INSTALL_BREW : INSTALL_SCRIPT), { primary: true }),
            mac ? button("install-script", "Use the script instead", t, () => inPane(INSTALL_SCRIPT)) : null,
            again,
          )))];
      }
      if (this.statusKind === "old") {
        return [section(t, "paddock", pill(t, "Too old", false, true), v_flex().gap(10)
          .child(line(t, this.statusError, t.blocked))
          .child(row(button("update-old", "Update paddock", t, () => inPane(`'${this.bin}' update`), { primary: true }), again)))];
      }
      return [section(t, "paddock", null, v_flex().gap(8).child(line(t, this.statusError, t.blocked)).child(row(again)))];
    }
    if (!this.status) return [section(t, "paddock", null, note(t, "Reading paddock status…"))];
    return [this.dashboard(t, cx), this.tailscale(t, cx), this.tunnel(t, cx), this.notifications(t, cx), this.healthSection(t, cx)]
      .filter(Boolean);
  }

  dashboard(t, cx) {
    const p = this.status.paddock, svc = this.status.service, busy = this.busy;
    let state, color, detail;
    if (p.state === "running") {
      state = "Running"; color = good(t);
      detail = `port ${p.port} · up ${ago(Date.now() - p.startedAt)}` + (svc ? ` · ${svc.kind}, starts at ${svc.startsAt ?? "login"}` : " · in a terminal, not a service");
    } else if (p.state === "untracked") {
      state = "Running, not tracked"; color = t.blocked;
      detail = `something answers on port ${p.port} (paddock ${p.version}) that no record describes; stop it by hand`;
    } else if (p.state === "unknown") {
      state = "Unknown"; color = t.blocked; detail = p.error;
    } else {
      state = "Stopped"; color = t.dim;
      detail = svc?.state === "failing" ? `the ${svc.kind} service is registered but not serving (usually: herdr is not running)` : "the dashboard is not running";
    }
    const running = p.state === "running";
    const actions = busy
      ? [busyButton("busy", `${busy}…`, t)]
      : running
        ? [
          button("open-local", "Open", t, () => this.open(`http://127.0.0.1:${p.port}`)),
          !svc ? button("as-service", "Run as a service", t, (_e, cx) => this.act(cx, "Start as a service", ["local"], 60000, true)) : null,
          this.confirmStop
            ? button("stop-confirm", "Stop: tunnel, Tailscale and service too", t, (_e, cx) => this.act(cx, "Stop", ["stop"]), { danger: true })
            : button("stop", "Stop", t, (_e, cx) => { this.confirmStop = true; cx.notify(); }, { danger: true }),
        ]
        : p.state === "untracked" ? [] : [button("start", "Start", t, (_e, cx) => this.act(cx, "Start", ["local"], 60000, true), { primary: true })];
    const logs = svc?.logHint
      ? button("logs", "Logs", t, () => {
        const argv = svc.logHint.startsWith("journalctl") ? [...svc.logHint.split(" "), "-f"] : ["tail", "-f", svc.logHint];
        run("pane.split", { direction: "down", argv });
      })
      : null;
    return section(t, "Dashboard", pill(t, running ? "On" : p.state === "stopped" ? "Off" : "?", running, !running && p.state !== "stopped"), v_flex().gap(10)
      .child(h_flex().gap(8).items_center().child(dot(color)).child(div().font_semibold().child(state)))
      .child(note(t, detail))
      .child(row(...actions, logs)));
  }

  tailscale(t, cx) {
    const ts = this.status.tailscale, busy = Boolean(this.busy);
    let body;
    const hasTailscale = this.status.tools?.tailscale !== null; // unknown (older JSON) counts as present
    if (ts === null && !hasTailscale) {
      body = v_flex().gap(8)
        .child(line(t, "Needs Tailscale on this machine, signed in."))
        .child(note(t, "Publishes the dashboard on your tailnet at a stable https address, only to your Tailscale login."))
        .child(row(button("ts-get", "Get Tailscale", t, () => this.open(TAILSCALE_DOWNLOAD)),
          button("ts-recheck", "Check again", t, (_e, cx) => this.refresh(cx))));
    } else if (ts === null) {
      body = v_flex().gap(8)
        .child(note(t, "Publishes the dashboard on your tailnet at a stable https address, only to your Tailscale login. Turning it on restarts paddock for a few seconds."))
        .child(row(busy ? null : button("ts-on", "Turn on", t, (_e, cx) => this.act(cx, "Tailscale on", ["tailscale"], 120000, true))));
    } else if (ts.state === "up") {
      body = v_flex().gap(8)
        .child(h_flex().gap(8).items_center().child(dot(good(t))).child(div().font_family(mono()).truncate().child(ts.url)))
        .child(note(t, `allows ${ts.login} · turning it off restarts paddock for a few seconds`))
        .child(row(
          button("ts-open", "Open", t, () => this.open(ts.url)),
          busy ? null : button("ts-off", "Turn off", t, (_e, cx) => this.act(cx, "Tailscale off", ["tailscale", "off"], 60000, true)),
        ));
    } else {
      body = v_flex().gap(8)
        .child(h_flex().gap(8).items_center().child(dot(t.blocked)).child(div().child(ts.state === "down" ? "Not serving" : "Unknown")))
        .child(note(t, ts.detail))
        .child(row(
          busy ? null : button("ts-fix", "Repair", t, (_e, cx) => this.act(cx, "Tailscale repair", ["tailscale"], 120000, true), { primary: true }),
          busy ? null : button("ts-off2", "Turn off", t, (_e, cx) => this.act(cx, "Tailscale off", ["tailscale", "off"], 60000, true)),
        ));
    }
    const tsPill = ts === null ? pill(t, hasTailscale ? "Off" : "Needs Tailscale", false) : ts.state === "up" ? pill(t, "On", true) : pill(t, "Broken", false, true);
    return section(t, "Tailscale", tsPill, body);
  }

  tunnel(t, cx) {
    const tn = this.status.tunnel, busy = Boolean(this.busy);
    let body;
    const hasCloudflared = this.status.tools?.cloudflared !== null;
    if (tn === null && !hasCloudflared) {
      const mac = hostWindow().platform === "macos";
      body = v_flex().gap(8)
        .child(line(t, "Off: needs cloudflared on this machine."))
        .child(note(t, "A quick tunnel is a public https link for a phone off your network, through Cloudflare, gated by a pairing code."))
        .child(row(
          mac
            ? button("cf-install", "Install with Homebrew", t, () => inPane("brew install cloudflared"), { primary: true })
            : button("cf-get", "Get cloudflared", t, () => this.open(CLOUDFLARED_DOWNLOAD), { primary: true }),
          button("cf-recheck", "Check again", t, (_e, cx) => this.refresh(cx)),
        ));
    } else if (tn === null) {
      body = v_flex().gap(10)
        .child(line(t, "Off: no public link."))
        .child(note(t, "Opens a public https link for a phone off your network, gated by a pairing code. It closes by itself after the time you pick."))
        .child(row(...TUNNEL_TIMES.map(([k, label]) => chip(`for-${k}`, label, this.tunnelFor === k, t, (_e, cx) => { this.tunnelFor = k; cx.notify(); }))))
        .child(row(busy ? null : button("tunnel-open", "Open a tunnel", t,
          (_e, cx) => this.act(cx, "Open a tunnel", ["start", "--for", this.tunnelFor], 120000), { primary: true })));
    } else if (tn.state === "unknown") {
      body = v_flex().gap(8).child(line(t, `Could not read the tunnel's state: ${tn.error}`, t.blocked));
    } else {
      const pair = tn.pair;
      body = v_flex().gap(10)
        .child(h_flex().gap(8).items_center().child(dot(good(t))).child(div().font_family(mono()).truncate().child(tn.url)))
        .child(note(t, `up ${ago(Date.now() - tn.startedAt)}` + (tn.publishing !== null ? ` · publishing port ${tn.publishing}` : "")))
        .children(pair
          ? [h_flex().gap(14).items_center()
            .child(qr(t, pair.qr))
            .child(v_flex().gap(4)
              .child(note(t, "Scan, or enter the code"))
              .child(div().font_family(mono()).text_size(S().big).font_semibold().child(pair.code))
              .child(note(t, pair.expiresAt > Date.now() ? `code changes at ${clock(pair.expiresAt)}` : "code expired; it renews on the next read")))]
          : [note(t, "The tunnel did not answer for its pairing code; `paddock pair` in a terminal shows why.")])
        .child(row(
          button("tunnel-browser", "Open", t, () => this.open(tn.url)),
          busy ? null : button("tunnel-close", "Close tunnel", t, (_e, cx) => this.act(cx, "Close the tunnel", ["tunnel", "stop"]), { danger: true }),
        ));
    }
    const tnPill = tn === null ? pill(t, hasCloudflared ? "Off" : "Needs cloudflared", false) : tn.state === "running" ? pill(t, "On", true) : pill(t, "?", false, true);
    return section(t, "Phone link", tnPill, body);
  }

  notifications(t, cx) {
    const s = this.settings;
    if (!s?.notify) return this.port() === null ? null : section(t, "Notifications", null, note(t, this.apiError ?? "Reading settings…"));
    const n = s.notify, busy = Boolean(this.busy);
    const muted = n.mutedUntil !== null && n.mutedUntil > Date.now();
    const triggers = new Set(n.triggers);
    const flip = (k) => (_e, cx) => {
      const next = new Set(triggers);
      if (next.has(k)) next.delete(k); else next.add(k);
      this.api(cx, "Change notifications", "PUT", "/api/settings", { notify: { triggers: [...next] } });
    };
    const devices = s.push?.devices ?? 0;
    const nPill = muted ? pill(t, "Muted", false, true) : n.triggers.length === 0 ? pill(t, "Off", false) : pill(t, "On", true);
    return section(t, "Notifications", nPill, v_flex().gap(10)
      .child(muted
        ? h_flex().gap(8).items_center().child(dot(t.blocked)).child(div().child(`Muted until ${clock(n.mutedUntil)}`))
        : note(t, `${devices} phone${devices === 1 ? "" : "s"} get push notifications${s.telegram?.configured && n.telegram ? ", and Telegram" : ""}.`))
      .child(row(
        busy ? null : muted
          ? button("unmute", "Unmute", t, (_e, cx) => this.api(cx, "Unmute", "POST", "/api/settings/mute", { forMs: 0 }))
          : button("mute-1h", "Mute 1 hour", t, (_e, cx) => this.api(cx, "Mute", "POST", "/api/settings/mute", { forMs: 3600000 })),
        busy || muted ? null : button("mute-morning", "Mute until 8:00", t, (_e, cx) => this.api(cx, "Mute", "POST", "/api/settings/mute", { forMs: untilMorning() })),
      ))
      .child(row(
        note(t, "Notify when"),
        chip("on-blocked", "it needs you", triggers.has("blocked"), t, flip("blocked")),
        chip("on-done", "it finishes", triggers.has("done"), t, flip("done")),
      )));
  }

  healthSection(t, cx) {
    const h = this.health;
    if (!h) return null;
    const ok = (yes, label) => h_flex().gap(6).items_center().child(dot(yes ? good(t) : t.dim, 6)).child(div().text_size(S().small).child(label));
    const latest = h.latestKnown, current = h.version;
    const update = latest && current && latest !== current && !current.startsWith("0.0.0");
    const bridge = this.settings?.bridge?.enabled === true;
    return section(t, "Health", null, v_flex().gap(10)
      .child(row(
        ok(true, `${h.agents} agent${h.agents === 1 ? "" : "s"}`),
        ok(h.herdrConnected, "terminal herdr"),
        ok(h.core?.connected === true, "Herdr app"),
      ))
      .children(h.lastNotifyError ? [line(t, `Last notification failed: ${h.lastNotifyError}`, t.blocked)] : [])
      .children(h.schemaWarning ? [note(t, h.schemaWarning)] : [])
      .child(row(
        chip("bridge", "MCP bridge", bridge, t,
          (_e, cx) => this.api(cx, "MCP bridge", "PUT", "/api/settings", { bridge: { enabled: !bridge } })),
        update && !this.busy ? button("update", `Update to ${latest}`, t, (_e, cx) => this.act(cx, "Update", ["update"], 300000), { primary: true }) : null,
      )));
  }
}
