/**
 * `HerdrActions` for herdr-core terminals. Every target or id argument is a
 * paddock core id (`hc.…`); `rawCoreId` strips it and refuses anything else,
 * so a terminal-herdr id can never reach the core.
 *
 * THE ANSWER PATH is measured, not inferred (docs/probes/2026-11-09-herdr-core.md,
 * steps 3 and 4):
 *  - a blocked prompt is answered with `terminal.keys` and ONE digit per call,
 *    the digit being the parsed option's own key;
 *  - `terminal.send {force:true}` APPROVED a command when asked to answer "No"
 *    (the pasted digit is not a key press, and send's Enter commits the cursor
 *    row). No request in this file sends `force`, and none may.
 *  - an option digit is pressed only while the LIVE status is a blocked
 *    `permission` prompt (`promptAllowed` gates the buttons the same way);
 *  - text into a blocked dialog is unmeasured, so `sendReply` reads the live
 *    status first and refuses while blocked, and `sendChars` (dialog typing)
 *    is refused outright.
 */
import type { CoreListResult, CoreReadResult, CoreTerminal } from "@shared/herdr-core-api";
import { coreId, rawCoreId } from "@shared/origin";
import type { NavKey } from "@shared/types";
import { BackendUnavailable, Unsupported } from "@server/action-errors";
import {
  HISTORY_LINES,
  resolveWaitTimeoutMs,
  type CreateOpts,
  type HerdrActions,
} from "@server/herdr/actions";
import { OPEN_HERDR_TO_RENAME, type AppSocket } from "./app-socket";
import type { CoreClient } from "./socket";
import { paintToLines } from "./screen";

/** The slice of `CoreClient` these actions use, so a test can fake it. */
/** `observePaint` is optional: without it, screens are read as plain text. */
export type CoreRequester = Pick<CoreClient, "request"> & Partial<Pick<CoreClient, "observePaint">>;

/**
 * paddock's key names to herdr-core's (`hc keys --help`: "enter, esc, tab, up,
 * ctrl+c, alt+x, f5, a, ..."). A `Record` over `NavKey`, so a key added to the
 * closed set does not compile until it has a core name here.
 *
 * Unlike terminal herdr, every ctrl key goes as a key: `terminal.keys` encodes
 * named keys "for the program's current keyboard modes", so there is no
 * allowlist that forces control bytes down a text path.
 *
 * `space` and `backspace` are named by analogy with the documented examples;
 * they have not been measured against a live core.
 */
export const NAV_TO_CORE: Record<NavKey, string> = {
  up: "up", down: "down", left: "left", right: "right",
  enter: "enter", esc: "esc", tab: "tab", space: "space", backspace: "backspace",
  "ctrl-a": "ctrl+a", "ctrl-b": "ctrl+b", "ctrl-c": "ctrl+c", "ctrl-d": "ctrl+d",
  "ctrl-e": "ctrl+e", "ctrl-f": "ctrl+f", "ctrl-g": "ctrl+g", "ctrl-h": "ctrl+h",
  "ctrl-i": "ctrl+i", "ctrl-j": "ctrl+j", "ctrl-k": "ctrl+k", "ctrl-l": "ctrl+l",
  "ctrl-m": "ctrl+m", "ctrl-n": "ctrl+n", "ctrl-o": "ctrl+o", "ctrl-p": "ctrl+p",
  "ctrl-q": "ctrl+q", "ctrl-r": "ctrl+r", "ctrl-s": "ctrl+s", "ctrl-t": "ctrl+t",
  "ctrl-u": "ctrl+u", "ctrl-v": "ctrl+v", "ctrl-w": "ctrl+w", "ctrl-x": "ctrl+x",
  "ctrl-y": "ctrl+y", "ctrl-z": "ctrl+z",
};

/**
 * One digit, 1-9, and nothing else. The route's `OPTION_KEY_RE` admits two
 * digits; this cannot. A dialog commits on the digit as it lands (probe step
 * 3), so "10" sent as keys would answer option 1. Checked here because this
 * is the function that presses the key.
 */
const ONE_DIGIT = /^[1-9]$/;

/** Shown when a typed reply would land in a blocked dialog. */
export const ANSWER_THE_OPTIONS = "this agent is waiting on a dialog: answer the dialog's options";

/** Typing into an app agent's dialog (question free-text, notes). */
export const CANNOT_TYPE_IN_DIALOG = "typing into an app agent's dialog isn't supported yet — answer in Herdr";

/** An option digit offered or sent to anything but a live permission prompt. */
export const NOT_A_PERMISSION_PROMPT = "this app agent is not showing a permission prompt; nothing was sent";

/**
 * One-tap answers need a live, blocked PERMISSION prompt. `status.kind` may
 * remove buttons, never add them: a question, an auth prompt, or a missing
 * kind all mean no buttons.
 */
function isPermissionPrompt(t: CoreTerminal): boolean {
  return t.state === "live" && t.status?.state === "blocked" && t.status.kind === "permission";
}

/**
 * Characters whose key name was measured to type exactly that character into
 * a shell (docs/probes/2026-11-09-herdr-core.md, step 6). A bare uppercase
 * key name types the LOWERCASE letter, so `A` goes as `shift+a`; `+`, `|`,
 * `_`, `:`, `~` and the other symbols are refused by the core as unknown keys
 * and `shift+` does not reach them. Nothing outside this table is sent.
 */
const TYPED_AS_ITSELF = new Set([..."abcdefghijklmnopqrstuvwxyz0123456789',-./;=[\\]`"]);

/** What the operator is told when a character has no measured key. */
export const CANNOT_TYPE_CHARS = "can't be typed into an app terminal from paddock yet";

/** `text` as measured key names, or an `Unsupported` naming what has none. */
export function shellKeys(text: string): string[] {
  const keys: string[] = [];
  const missing = new Set<string>();
  for (const ch of text) {
    if (ch === " ") keys.push("space");
    else if (TYPED_AS_ITSELF.has(ch)) keys.push(ch);
    else if (ch >= "A" && ch <= "Z") keys.push(`shift+${ch.toLowerCase()}`);
    else missing.add(ch);
  }
  if (missing.size > 0) {
    const list = [...missing].map((c) => JSON.stringify(c)).join(" ");
    throw new Unsupported(`${list} ${CANNOT_TYPE_CHARS}; nothing was typed`);
  }
  return keys;
}

/** Neither herdr-core nor the app has a call that renames a running terminal. */
export const CANNOT_RENAME_AGENT = "herdr can't rename a running app terminal";

/** How often `waitUntilUnblocked` re-reads the status. */
const WAIT_POLL_MS = 150;

const SPACE = "herdr.space";
const TAB = "herdr.tab";
const SEEN = "herdr.seen";

/** `"sp"` or `"tb"` plus 32 hex digits: the app's own id shape. */
function freshId(prefix: "sp" | "tb"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Same rule as the terminal-herdr reads: CRLF endings, and "" is no lines. */
function toLines(text: string): string[] {
  return text === "" ? [] : text.split("\n").map((l) => l.replace(/\r$/, ""));
}

export interface CoreActionsOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * `client` is asked for on every call, so the actions always use the
 * supervisor's CURRENT connection. It throws `BackendUnavailable` when the
 * core is not connected; that refusal reaches the route as a 503.
 */
export function createCoreActions(
  client: () => CoreRequester,
  app: AppSocket,
  opts: CoreActionsOptions = {},
): HerdrActions {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  async function call<T>(method: string, params: object): Promise<T> {
    return client().request<T>(method, params);
  }

  async function read(id: string, lines: number): Promise<string> {
    // `lines` is history ABOVE the screen (schema: "Lines of history above the
    // screen", default 0). Zero is the live screen, like terminal herdr's
    // `visible`.
    const res = await call<CoreReadResult>("terminal.read", { terminal: rawCoreId(id), lines });
    return res.text;
  }

  // One log line per distinct reason, not one per poll of an open terminal.
  const colourMisses = new Set<string>();

  /**
   * The screen with its colours: an observer's first paint, at the
   * terminal's own size, replayed (`screen.ts`). Null when the client cannot
   * observe or the paint failed; the caller then reads plain text, and the
   * reason is logged, once.
   */
  async function styled(id: string, history: number): Promise<string[] | null> {
    const c = client();
    if (!c.observePaint) return null;
    try {
      const t = await get(id);
      const paint = await c.observePaint(rawCoreId(id), t.cols, t.rows, history);
      return await paintToLines(paint, t.cols, t.rows, history);
    } catch (e) {
      if (e instanceof BackendUnavailable) throw e;
      const why = e instanceof Error ? e.message : String(e);
      if (!colourMisses.has(why)) {
        colourMisses.add(why);
        console.info(`herdr-core: showing ${id} without colour (${why})`);
      }
      return null;
    }
  }

  async function get(id: string): Promise<CoreTerminal> {
    return call<CoreTerminal>("terminal.get", { terminal: rawCoreId(id) });
  }

  async function press(id: string, key: string): Promise<void> {
    await call("terminal.keys", { terminal: rawCoreId(id), keys: [key] });
  }

  /** Refuse typing into a blocked dialog, from the LIVE status, not the store. */
  async function refuseIfBlocked(id: string): Promise<void> {
    const t = await get(id);
    if (t.status?.state === "blocked") throw new Unsupported(ANSWER_THE_OPTIONS);
  }

  async function send(id: string, text: string): Promise<void> {
    // No `force`, ever: see the file header.
    await call("terminal.send", { terminal: rawCoreId(id), text });
  }

  /** Live terminals carrying `key=value`. Filtered here too, so a core that
   *  ignored the filter could never cost the operator someone else's terminal. */
  async function labelled(key: string, value: string): Promise<CoreTerminal[]> {
    const res = await call<CoreListResult>("terminal.list", { labels: { [key]: value } });
    return res.terminals.filter((t) => t.state === "live" && t.labels[key] === value);
  }

  async function killAll(key: string, id: string, what: string): Promise<void> {
    const raw = rawCoreId(id);
    const terms = await labelled(key, raw);
    if (terms.length === 0) throw new Error(`no live terminal in that ${what}`);
    for (const t of terms) await call("terminal.kill", { terminal: t.address });
  }

  /** A named create needs the app; refuse BEFORE anything exists. */
  async function requireAppForName(label: string | undefined): Promise<void> {
    if (label !== undefined && !(await app.available())) throw new Unsupported(OPEN_HERDR_TO_RENAME);
  }

  /**
   * Name a space or tab the app has only just been told about. The app adopts
   * an unknown id when the first terminal carrying it appears; how quickly is
   * unmeasured. Its answer for an id it does not know yet is measured (probe
   * step 5c: `no space "<id>"`), so only that answer is retried, briefly; any
   * other error, or the last attempt's, reaches the operator.
   */
  async function nameIt(kind: "space" | "tab", raw: string, label: string): Promise<void> {
    const rename = kind === "space" ? app.renameSpace : app.renameTab;
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(raw, label);
        return;
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt < 10 && msg.startsWith(`no ${kind}`)) { await sleep(200); continue; }
        throw new Error(`the ${kind} was created, but not named: ${msg}`);
      }
    }
  }

  /** With a harness, the new terminal IS the agent (`argv[0]` may name a
   *  template); without one, the core's own shell. A task goes second: a
   *  template appends it to its opening instructions, a plain program takes
   *  it as its first argument. */
  function asProgram(o: CreateOpts): object {
    if (!o.harness) return {};
    const { kind, name, task } = o.harness;
    return { argv: task ? [kind, task] : [kind], name };
  }

  async function run(labels: Record<string, string>, cwd: string | undefined, extra: object = {}): Promise<CoreTerminal> {
    return call<CoreTerminal>("terminal.run", {
      ...extra,
      ...(cwd !== undefined ? { cwd } : {}),
      keep: true,
      labels: { ...labels, [SEEN]: "0" },
    });
  }

  return {
    async readOutput(target, _state, _lines, scrollback = false) {
      // The core decides itself whether a full-screen app can be scrolled
      // (it is not, while working or blocked); the state is not needed here.
      const history = scrollback ? HISTORY_LINES : 0;
      const source = scrollback ? "recent_unwrapped" : "visible";
      const coloured = await styled(target, history);
      if (coloured) return { lines: coloured, source };
      return { lines: toLines(await read(target, history)), source };
    },

    async readPane(paneId) {
      const coloured = await styled(paneId, HISTORY_LINES);
      return { lines: coloured ?? toLines(await read(paneId, HISTORY_LINES)), source: "recent_unwrapped" };
    },

    async readPromptScreen(target) {
      // Raw, like terminal herdr's: the prompt parsers strip what they need.
      return read(target, 0);
    },

    async promptAllowed(target) {
      return isPermissionPrompt(await get(target));
    },

    async sendOptionKey(target, key) {
      if (!ONE_DIGIT.test(key)) {
        throw new Unsupported(`option ${JSON.stringify(key)} has no single key on an app terminal; use the arrow keys and Enter`);
      }
      // Gated on the LIVE status, at the moment of sending: a digit is pressed
      // only into a permission prompt, the one dialog the probe measured. A
      // question or auth dialog, or a prompt answered at the desk a moment
      // ago, gets nothing. This also covers /dialog-key, which comes here.
      if (!isPermissionPrompt(await get(target))) throw new Unsupported(NOT_A_PERMISSION_PROMPT);
      await press(target, key);
    },

    async sendNavKey(target, key) {
      await press(target, NAV_TO_CORE[key]);
    },

    async sendPaneKey(paneId, key) {
      await press(paneId, NAV_TO_CORE[key]);
    },

    async sendReply(target, text) {
      await refuseIfBlocked(target);
      await send(target, text);
    },

    async sendChars() {
      // Refused OUTRIGHT, before any request. The only caller is the dialog
      // typer. Text into a blocked dialog is unmeasured, and the only text
      // call (`terminal.send`) presses Enter, so in the race where the store
      // says blocked and the terminal no longer is, dialog text would be
      // submitted to the agent as a prompt.
      throw new Unsupported(CANNOT_TYPE_IN_DIALOG);
    },

    async sendPaneText(paneId, text) {
      // TYPED, not sent: `terminal.send` pastes and then presses Enter, and
      // this call must leave the command on the line — the pane route presses
      // Enter itself only when the operator asked to run it. So one key per
      // character, through the MEASURED table only (probe step 6). Every
      // character is checked before anything is sent: half a command typed
      // and then refused would leave a different command on the line.
      const keys = shellKeys(text);
      await call("terminal.keys", { terminal: rawCoreId(paneId), keys });
    },

    async waitUntilUnblocked(target, timeoutMs) {
      // Polled with `terminal.get`, NOT `terminal.wait`: that call waits
      // until the program is "not working", so it returns at once while the
      // dialog is still up (blocked is not working) and, once an approval
      // starts the tool, holds for the whole turn. Neither is "left blocked".
      const deadline = now() + resolveWaitTimeoutMs(timeoutMs);
      for (;;) {
        const t = await get(target);
        if (t.state !== "live" || t.status?.state !== "blocked") return;
        if (now() >= deadline) throw new Error(`${rawCoreId(target)} is still blocked`);
        await sleep(WAIT_POLL_MS);
      }
    },

    async renameAgent() {
      throw new Unsupported(CANNOT_RENAME_AGENT);
    },

    async renameTab(tabId, label) {
      await app.renameTab(tabId, label);
    },

    async renameSpace(spaceId, label) {
      await app.renameSpace(spaceId, label);
    },

    async closeTab(tabId) {
      // Killing its terminals closes the tab by the app's own rule.
      await killAll(TAB, tabId, "tab");
    },

    async closeSpace(spaceId) {
      await killAll(SPACE, spaceId, "space");
    },

    async createSpace(o: CreateOpts) {
      await requireAppForName(o.label);
      const space = freshId("sp");
      const tab = freshId("tb");
      const t = await run({ [SPACE]: space, [TAB]: tab }, o.cwd, asProgram(o));
      if (o.label !== undefined) await nameIt("space", space, o.label);
      return { spaceId: coreId(space), tabId: coreId(tab), paneId: coreId(t.address) };
    },

    async createTab(spaceId, o: CreateOpts) {
      await requireAppForName(o.label);
      const space = rawCoreId(spaceId);
      // No folder given: the space's own, so the tab does not open in the
      // core's working directory.
      const cwd = o.cwd ?? (await labelled(SPACE, space))[0]?.cwd;
      const tab = freshId("tb");
      const t = await run({ [SPACE]: space, [TAB]: tab }, cwd, asProgram(o));
      if (o.label !== undefined) await nameIt("tab", tab, o.label);
      return { tabId: coreId(tab), paneId: coreId(t.address) };
    },

    async startAgent(paneId, kind, name, args) {
      // The core cannot start a program inside an existing terminal, so the
      // agent gets its own, in the pane's space and tab (the app places it
      // beside the pane).
      const pane = await get(paneId);
      const space = pane.labels[SPACE];
      const tab = pane.labels[TAB];
      if (!space || !tab) throw new Unsupported("this terminal is not in an app space");
      await run({ [SPACE]: space, [TAB]: tab }, pane.cwd, { argv: [kind, ...(args ?? [])], name });
    },

    async harnessKinds() {
      const res = await call<{ templates: { name: string; error?: string | null }[] }>("templates.list", {});
      return res.templates.filter((t) => !t.error).map((t) => t.name);
    },

    async markSeen(target, turn) {
      await call("terminal.label", { terminal: rawCoreId(target), labels: { [SEEN]: String(turn) } });
    },
  };
}

/** For the composition root: the supervisor's live client, or the refusal. */
export function requireCore(get: () => CoreRequester | null): () => CoreRequester {
  return () => {
    const c = get();
    if (!c) throw new BackendUnavailable("herdr-core is not running");
    return c;
  };
}
