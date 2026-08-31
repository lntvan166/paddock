import { Hono, type Context } from "hono";
import { statSync, type Stats } from "node:fs";
import { compress } from "hono/compress";
import { resolveReadLines, type HerdrActions, type HostPath } from "@server/herdr/actions";
import { expandHome } from "@server/herdr/tree";
import { addNote, moveDialogTab, selectByCursor, toggleDialogOption, typeIntoFreeText } from "@server/herdr/dialog-type";
import { parsePrompt } from "@server/herdr/prompt-parse";
import { sendTelegram } from "@server/notify/telegram";
import {
  isConfigured,
  isTokenShape,
  MAX_SETTLE_MS,
  MIN_COOLDOWN_MS,
  TOKEN_SHAPE_DETAIL,
  type SettingsStore,
} from "@server/settings/store";
import type { PushStore } from "@server/push/store";
import { b64urlDecode } from "@server/push/vapid";
import type { AgentStore } from "@server/state/store";
import type { Hub } from "@server/ws/hub";
import { formatCode, pairOutcome } from "@server/tunnel/pairing";
import { setCookie } from "@server/tunnel/gate";
import { EMBEDDED } from "@server/embedded";
import { allowWrite, hostOf, refusalReason } from "@server/origin";
import { warn } from "@server/term";
import type { JournalReader } from "@server/journal/read";
import { MAX_IMAGE_BYTES, type SavedImage } from "@server/uploads/store";
import { kindFor, MAX_FILE_BYTES } from "@server/files/kinds";
import { resolveOpenable } from "@server/files/path";
import { errorCode } from "@server/startup-errors";
import type { FileStore } from "@server/files/store";
import {
  isNavKey,
  type AgentCommand,
  type HealthBody,
  type NotifyTrigger,
  type SettingsPatch,
  type Space,
  type SpaceTree,
  type Tab,
  type TreePane,
} from "@shared/types";
import { diffScreens, digestOf } from "@shared/screen";
import type { HerdrAgentSession } from "@shared/herdr-api";

// Re-exported for call sites that imported this from here before the
// contract moved to `@shared/types` — see `src/shared/types.ts` for the
// interface itself, comments intact.
export type { HealthBody } from "@shared/types";

// Vite's content hash is base64url (letters, digits, "_", "-"), joined to the
// basename with a dash, e.g. "index-BRl8nQbG.js" or "index-Cj_7W-bH.css" — not
// the dot-separated lowercase-hex shape this used to require, which matched no
// real build output and so never actually set the immutable header.
//
// The `/assets/` anchor is the other correction. Unanchored, the hash pattern
// only asked for a dash followed by eight characters, and "-" is inside its own
// character class, so it happily spanned several segments of an ordinary name:
// "/apple-touch-icon.png" matched on "-touch-icon" and "/icon-maskable-512.png"
// on "-maskable-512". Both were served `immutable` for a year despite being
// exactly the unhashed, never-renamed files the header must never touch — and
// apple-touch-icon.png is the one iOS reads for the Home Screen, so the bug
// pinned the icon most resistant to updating in the first place. Vite writes
// every hashed output under dist/assets/, so requiring that prefix states the
// real rule: hashed bundles are immutable, root-level files are revalidated.
export const IMMUTABLE_ASSET_RE = /^\/assets\/.*-[A-Za-z0-9_-]{8,}\.(js|css|woff2|svg|png)$/;

/**
 * The option's digit, exactly as `prompt-parse` emits it (`1`…`N`, contiguous
 * from 1, so two digits is already more options than any real prompt offers).
 *
 * Spec §6 calls this "the option's digit" and states there is no
 * general-purpose send endpoint — so anything else (`"C-c"`, `"Escape"`, an
 * escape sequence) is refused here rather than forwarded verbatim to
 * `agent.send_keys`. A control sequence is a strictly larger capability than
 * the free text `{text}` already permits.
 */
const OPTION_KEY_RE = /^[1-9][0-9]?$/;

/**
 * Characters one `/type` call may send.
 *
 * A free-text ANSWER, not a message: the reply box already exists for prose and
 * goes through `agent.prompt`. Sized so a sentence fits and a pasted file does
 * not, because every character here becomes one entry in a `send_keys` array.
 */
const MAX_TYPE_CHARS = 200;

/**
 * Wait for a TUI to repaint after a write.
 *
 * The same pause the `/key` route takes before reading, for the same measured
 * reason: reading immediately races the repaint and returns the previous frame.
 * Named and shared so the dialog actions cannot quietly go without it — a
 * missing settle there does not error, it just verifies the cursor against a
 * stale screen and refuses.
 */
const settle = () => new Promise<void>((r) => setTimeout(r, KEY_SETTLE_MS));

/**
 * Pause between writing a nav key and re-reading the pane, so the read sees
 * the frame the key produced rather than the one before it. Measured against
 * herdr 0.8.0: a `visible` read costs ~2 ms, so this dominates the round trip
 * and is the number to tune if navigation ever feels laggy or ever misses a
 * repaint.
 */
const KEY_SETTLE_MS = 120;

/**
 * Ceiling on typed text. Generous for a phone reply, small enough that a
 * runaway paste cannot be forwarded into an agent's prompt wholesale.
 */
const MAX_TEXT_LEN = 10_000;

/**
 * Ceiling on a rename label — an agent's name, a tab's label, a space's
 * label. Bounded by paddock, not the caller, for the same reason
 * `MAX_READ_LINES` is in `actions.ts`: a client-supplied value reaching a
 * herdr parameter has to be governed by paddock's own policy. Refused, not
 * truncated, same as `MAX_TEXT_LEN` above — a silently shortened name is a
 * wrong name. 64 is generous for a name or a short label and short enough to
 * stay legible in the Spaces list and the terminal view's header alike.
 */
const MAX_LABEL_LEN = 64;

/**
 * Ceiling on how many `args` an `agent.start` may carry.
 *
 * `args` was the one client value on this branch that reached a herdr
 * parameter with no paddock bound at all — and unlike `text` or a label, it is
 * forwarded into a SPAWNED PROCESS'S argv. `{"args": ["x".repeat(1e8)]}` was
 * buffered here and pushed straight at herdr. The total length is bounded by
 * `MAX_TEXT_LEN` (the same ceiling typed text carries) and the count is
 * bounded separately, because a hundred thousand empty strings costs nothing
 * in length and is still a hundred thousand argv entries.
 *
 * Refused, never truncated — the same rule as `MAX_LABEL_LEN`, for a stronger
 * reason: a silently shortened argument is a different command.
 */
const MAX_ARGS = 64;

/**
 * Digest of a screen, used to answer "has this changed?" without resending it.
 *
 * Not a cryptographic claim — it only has to change when the screen changes.
 * The line separator is included so that moving a newline between two lines
 * still alters the digest.
 */
/**
 * Recently-served screens per agent, so a patch can be computed against
 * whatever the client is actually holding.
 *
 * Several per agent, not one or two. Every watcher polls on its own cadence,
 * so with N clients the server is simultaneously the "previous screen" for N
 * different digests — and a cache of two evicts them faster than they can be
 * used. Measured with just TWO clients on one agent and a depth of 2: 69 of 99
 * responses fell back to full screens, against 116 of 116 served as patches
 * with a single client. The optimisation quietly stopped working the moment a
 * second tab was open.
 *
 * Eight screens is ~40 KB per agent and covers several watchers several steps
 * apart. Anything older still falls back to a full screen, which is always
 * correct and only ever costs bandwidth.
 *
 * Bounded by the agent list, and evicted with it — see `pruneScreens`.
 */
const recentScreens = new Map<string, { digest: string; lines: string[] }[]>();
const SCREENS_PER_AGENT = 8;

function rememberScreen(agentId: string, digest: string, lines: string[]): void {
  const held = recentScreens.get(agentId) ?? [];
  if (held[0]?.digest === digest) return;
  recentScreens.set(agentId, [{ digest, lines }, ...held].slice(0, SCREENS_PER_AGENT));
}

function heldScreen(agentId: string, digest: string): string[] | undefined {
  return recentScreens.get(agentId)?.find((s) => s.digest === digest)?.lines;
}

/** Drop screens for agents that no longer exist, mirroring the store. */
function pruneScreens(liveIds: Set<string>): void {
  for (const id of [...recentScreens.keys()]) if (!liveIds.has(id)) recentScreens.delete(id);
}

/**
 * How many distinct `origin -> host` pairs a refusal will be reported for.
 *
 * Bounded because the caller is hostile by definition: a page that varies its
 * origin could otherwise flood the operator's terminal, and the Set would grow
 * without limit. Bounded rather than silent because the most likely cause of a
 * refusal is NOT an attack — it is a proxy that rewrites `Host` so it no longer
 * matches the browser's `Origin`, and a dashboard that stopped accepting
 * replies with nothing on stderr would be unexplainable. `docs/gotchas.md`
 * records exactly that class of failure.
 */
const REFUSAL_LOG_LIMIT = 20;
const refusalsSeen = new Set<string>();

function reportRefusal(origin: string | null, host: string, hosts: readonly string[]): void {
  const key = `${origin ?? "(none)"} -> ${host}`;
  if (refusalsSeen.has(key) || refusalsSeen.size >= REFUSAL_LOG_LIMIT) return;
  refusalsSeen.add(key);

  warn(`paddock: refused a write — origin ${origin ?? "(none)"}, host \`${host}\``);
  // The remedy, not just the fact. These two causes need opposite fixes, and
  // sending an operator to their proxy config when their proxy is correct is
  // worse than saying nothing.
  if (refusalReason(origin, host, hosts) === "host-not-allowed") {
    warn("  this host is not the public URL saved in settings — correct it, or clear it");
  } else {
    warn("  if this is your own dashboard, the proxy in front is rewriting `Host`");
  }
}

/**
 * A journal that could not be read is quiet in the UI and loud here.
 *
 * The operator sees the old behaviour — falling back to reconstruction is a
 * working dashboard, and a banner for a pane that never had a journal would be
 * noise. The host does not get to be quiet: `CLAUDE.md` forbids swallowing
 * errors, and "history silently stopped going deeper" is otherwise invisible.
 * Once per agent, because it is reported on every page request.
 *
 * BOUNDED, in two directions, because a de-duplicating set that only ever
 * grows is two bugs rather than one:
 *
 *  - It never forgot, so an agent whose journal came BACK — the ordinary case
 *    after a compaction, or after the session ref arrives late — could never
 *    be reported again if it later broke a second time. `clearJournalMiss`
 *    below is called on every successful page, so the next genuine failure is
 *    heard.
 *  - It never shrank, so on a long-lived server it held one string per agent
 *    id ever seen, forever. Agent ids do not repeat across restarts of the
 *    harness, so this is unbounded in the literal sense. A `Set` iterates in
 *    insertion order, so evicting the front entry is a plain FIFO and the
 *    ceiling is the only tuning knob.
 *
 * The cap is generous relative to any real agent list: it exists so the set
 * cannot grow without limit, not to be reached in normal use.
 */
const MAX_JOURNAL_MISSES = 256;
const journalMissesSeen = new Set<string>();

function reportJournalMiss(agentId: string, detail: string): void {
  if (journalMissesSeen.has(agentId)) return;
  if (journalMissesSeen.size >= MAX_JOURNAL_MISSES) {
    const oldest = journalMissesSeen.values().next().value;
    if (oldest !== undefined) journalMissesSeen.delete(oldest);
  }
  journalMissesSeen.add(agentId);
  warn(`paddock: no journal history for \`${agentId}\` — ${detail}`);
}

/** A journal that reads again is one whose next failure must be heard again. */
function clearJournalMiss(agentId: string): void {
  journalMissesSeen.delete(agentId);
}

/**
 * A request body as an object, whatever the client actually sent.
 *
 * `c.req.json()` rejects on malformed JSON and resolves with `null`, a number
 * or an array for well-formed-but-not-an-object bodies — none of which can be
 * indexed safely. Every field read off the result is `unknown` and validated
 * before use; nothing here is cast into a shape the body may not have.
 */
/**
 * The path behind an id, or null.
 *
 * A missing route parameter and an unknown id are the same answer here — both
 * mean "there is no file to serve" — but they are not the same TYPE, and the
 * router hands back `string | undefined`. Folded once rather than guarded at
 * each of the three call sites.
 */
function fileFor(files: FileStore, id: string | undefined): string | null {
  return id === undefined ? null : files.resolve(id);
}

/** The last path segment — a file's own name, for a title and a download. */
function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

/** Every `/api/panes/:id/*` route validates the same way against the tree —
 *  the store cannot do it, since a shell pane is deliberately absent from it
 *  (§3). Factored so the three call sites can't drift on how a pane is found. */
function findPane(tree: SpaceTree, id: string): TreePane | undefined {
  return tree.spaces.flatMap((s) => s.tabs).flatMap((t) => t.panes).find((p) => p.paneId === id);
}

/** Same reasoning as `findPane`: a tab is not in `AgentStore` either (§3), so
 *  the tree is the only authority that can confirm one exists. */
function findTab(tree: SpaceTree, id: string): Tab | undefined {
  return tree.spaces.flatMap((s) => s.tabs).find((t) => t.tabId === id);
}

/** Same reasoning again, one level up: a space is not in the store. */
function findSpace(tree: SpaceTree, id: string): Space | undefined {
  return tree.spaces.find((s) => s.spaceId === id);
}

/**
 * Shared validation for the two create bodies, `{label?, cwd?}`.
 *
 * Unlike `MAX_LABEL_LEN` on a RENAME, an empty or whitespace-only label (or
 * cwd) here is normalised to ABSENT rather than refused: the rename routes
 * refuse a blank value because the operator is replacing a name that
 * already exists and herdr models no "unset" for it (§17) — but a CREATE
 * has nothing existing to protect, and herdr is happy to pick its own
 * default (a tab's number, a space's own default cwd) for a field that
 * was never sent. Refusing a blank create label would only be refusing
 * something herdr already handles; the length ceilings still apply,
 * because a client-supplied value reaching a herdr parameter is governed
 * by paddock's own policy either way (same reasoning as `MAX_READ_LINES`).
 */
function normalizeCreateBody(
  body: Record<string, unknown>,
  home: string | undefined,
): { label?: string; cwd?: HostPath; err?: string } {
  const rawLabel = body.label;
  if (rawLabel !== undefined && typeof rawLabel !== "string") {
    return { err: "label must be a string" };
  }
  if (typeof rawLabel === "string" && rawLabel.length > MAX_LABEL_LEN) {
    return { err: "label must be within the length limit" };
  }
  const label = typeof rawLabel === "string" && rawLabel.trim() !== "" ? rawLabel : undefined;

  const rawCwd = body.cwd;
  if (rawCwd !== undefined && typeof rawCwd !== "string") {
    return { err: "cwd must be a string" };
  }
  if (typeof rawCwd === "string" && rawCwd.length > MAX_TEXT_LEN) {
    return { err: "cwd must be within the length limit" };
  }
  // Expanded HERE, not forwarded verbatim. The tilde in `~/project` is
  // paddock's own invention (`tildeise`), and the create sheet's quick picks
  // are the tree's own tilde-ised cwds coming back — measured live, herdr
  // neither expands nor refuses one: the pane came up in the home directory
  // with nothing saying the chosen folder had been ignored. The length ceiling
  // is checked BEFORE this, against what the client sent, so the bound is on
  // the operator's input rather than on however long this machine's home path
  // happens to be.
  const blank = typeof rawCwd !== "string" || rawCwd.trim() === "";
  const cwd = blank ? undefined : expandHome((rawCwd as string).trim(), home);
  // `null` means the value is not ABSOLUTE after expansion — `~someone/work`,
  // `~/work` on a server with no HOME, or `./relative`. The first version of
  // this forwarded the tilde unchanged, which handed herdr precisely the value
  // the line above exists to stop it seeing; the second refused the tilde and
  // still forwarded `./relative` with a 200, while this very message said
  // "absolute". Both shapes depend on a working directory paddock cannot see,
  // and an absolute path is the measured alternative that says the same thing —
  // so both are refused, with a reason the operator can read: a 400 beats a
  // pane that quietly comes up in the wrong folder. Returned from OUTSIDE the
  // create routes' `try`, like every other deliberate refusal here, so it can
  // never be relabelled as a 502.
  if (cwd === null) {
    return {
      err: "cwd must be an absolute path — a leading ~, or a relative path, cannot be resolved here",
    };
  }

  return { label, cwd };
}

/**
 * A request body as an object, or a 400 reason — and the one place the
 * settings routes require `content-type: application/json`, for the CSRF
 * reason spelled out below.
 *
 * Unlike `jsonBody`, which
 * folds malformed JSON into `{}` so its callers can treat "sent nothing
 * useful" as "sent no fields". `PUT /api/settings` cannot reuse that: folding
 * malformed JSON into an empty object would make a broken request body look
 * exactly like a no-op patch and answer 200, and an uncaught parse error
 * falling past this into Hono's default handler answers a bare 500 with no
 * reason — the task's ban on reporting a save that did not happen extends to
 * never reporting "ok" (implicitly, via 200) for a request that was never
 * understood.
 */
async function strictJsonBody(
  c: Context,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; detail: string }> {
  // Refused BEFORE the body is read, and the reason is CSRF, not tidiness.
  // `c.req.json()` is `text().then(JSON.parse)` and never looks at the header,
  // so without this a POST here is a CORS-SIMPLE request: an
  // `enctype="text/plain"` form on any page the operator visits submits it
  // cross-origin with no preflight, and a browser holding a Cloudflare Access
  // session attaches that session just as readily as to a first-party request.
  // paddock has no authentication of its own, so the preflight IS the control.
  // `PUT /api/settings` gets it from its verb (see the comment on that route);
  // `POST /api/settings/mute` and the telegram test route cannot, and would
  // otherwise hand a drive-by page a multi-day mute or a bot message sent to a
  // chat id of its choosing.
  //
  // Matched on the MEDIA TYPE alone: `application/json; charset=utf-8` is a
  // perfectly ordinary thing for a client to send.
  const mediaType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return { ok: false, detail: "content-type must be application/json" };
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch (e) {
    return { ok: false, detail: `malformed JSON body: ${(e as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, detail: "request body must be a JSON object" };
  }
  return { ok: true, body: raw as Record<string, unknown> };
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

/** A week. Long enough for a holiday, short enough that a fat-fingered mute
 *  cannot silence paddock for a year. */
const MAX_MUTE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Validates a raw PUT body into a `SettingsPatch`, or a 400 reason.
 *
 * `SettingsStore.patch()` merges whatever it is given with no validation of
 * its own, and a bare `as SettingsPatch` cast does no runtime check — so
 * without this, a wrong-typed field (`telegram.token: 12345`,
 * `notify.triggers: "nope"`) type-checks past the cast and is persisted to
 * settings.json verbatim. Unknown top-level keys are silently ignored rather
 * than rejected, so a client on a newer/older schema than this server still
 * gets its recognised fields applied.
 */
function validateSettingsPatch(
  body: Record<string, unknown>,
): { ok: true; patch: SettingsPatch } | { ok: false; detail: string } {
  const patch: SettingsPatch = {};

  if ("telegram" in body) {
    const t = body.telegram;
    if (typeof t !== "object" || t === null) return { ok: false, detail: "telegram must be an object" };
    const tt = t as Record<string, unknown>;
    const out: NonNullable<SettingsPatch["telegram"]> = {};
    if ("token" in tt) {
      if (!isNullableString(tt.token)) return { ok: false, detail: "telegram.token must be a string or null" };
      // Empty string clears it, same as null (see isConfigured). Any other
      // value must be path-safe — the detail names the rule and NEVER echoes
      // the value, which is the credential.
      if (tt.token !== null && tt.token !== "" && !isTokenShape(tt.token)) {
        return { ok: false, detail: TOKEN_SHAPE_DETAIL };
      }
      out.token = tt.token;
    }
    if ("chatId" in tt) {
      if (!isNullableString(tt.chatId)) return { ok: false, detail: "telegram.chatId must be a string or null" };
      out.chatId = tt.chatId;
    }
    patch.telegram = out;
  }

  if ("notify" in body) {
    const n = body.notify;
    if (typeof n !== "object" || n === null) return { ok: false, detail: "notify must be an object" };
    const nn = n as Record<string, unknown>;
    const out: NonNullable<SettingsPatch["notify"]> = {};

    if ("telegram" in nn) {
      if (typeof nn.telegram !== "boolean") return { ok: false, detail: "notify.telegram must be a boolean" };
      out.telegram = nn.telegram;
    }

    if ("triggers" in nn) {
      const triggers = nn.triggers;
      if (!Array.isArray(triggers) || !triggers.every((x) => x === "blocked" || x === "done")) {
        return { ok: false, detail: `notify.triggers must be an array of "blocked" or "done"` };
      }
      out.triggers = triggers as NotifyTrigger[];
    }

    if ("settleMs" in nn) {
      const raw = nn.settleMs;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { ok: false, detail: "notify.settleMs must be an object of {blocked, done}" };
      }
      const sm = raw as Record<string, unknown>;
      const out2: Record<string, number> = {};
      for (const k of ["blocked", "done"] as const) {
        const v = sm[k];
        // Both keys required: a partial object would leave the other trigger's
        // window undefined once merged, and undefined fires immediately.
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_SETTLE_MS) {
          return { ok: false, detail: `notify.settleMs.${k} must be a number between 0 and ${MAX_SETTLE_MS}` };
        }
        out2[k] = v;
      }
      out.settleMs = out2 as Record<NotifyTrigger, number>;
    }

    if ("cooldownMs" in nn) {
      const cooldownMs = nn.cooldownMs;
      if (typeof cooldownMs !== "number" || !Number.isFinite(cooldownMs) || cooldownMs < MIN_COOLDOWN_MS) {
        return { ok: false, detail: `notify.cooldownMs must be a number >= ${MIN_COOLDOWN_MS}` };
      }
      out.cooldownMs = cooldownMs;
    }

    if ("skipWhileViewing" in nn) {
      if (typeof nn.skipWhileViewing !== "boolean") {
        return { ok: false, detail: "notify.skipWhileViewing must be a boolean" };
      }
      out.skipWhileViewing = nn.skipWhileViewing;
    }

    patch.notify = out;
  }

  if ("publicUrl" in body) {
    const u = body.publicUrl;
    if (!isNullableString(u)) return { ok: false, detail: "publicUrl must be a string or null" };
    patch.publicUrl = u;
  }

  // Only `enabled`. The keypair is never patchable and subscriptions arrive
  // through their own routes, so this cannot be used to bypass the validation
  // there — an unknown key inside `push` is refused rather than ignored, for
  // the same reason every other branch here refuses one.
  if ("push" in body) {
    const raw = body.push;
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, detail: "push must be an object" };
    }
    const pp = raw as Record<string, unknown>;
    const out: NonNullable<SettingsPatch["push"]> = {};
    if ("enabled" in pp) {
      if (typeof pp.enabled !== "boolean") {
        return { ok: false, detail: "push.enabled must be a boolean" };
      }
      out.enabled = pp.enabled;
    }
    patch.push = out;
  }

  return { ok: true, patch };
}

/**
 * The decoded length of a base64url key, or -1 when it is not base64url at all.
 *
 * A corrupt key and a wrong-length key are the same refusal to the caller, so
 * the throw is folded into the length rather than given its own branch — but it
 * is NOT swallowed: -1 can never equal 65 or 16, so a malformed value always
 * takes the 400.
 */
function byteLen(b64url: string): number {
  try {
    return b64urlDecode(b64url).length;
  } catch {
    return -1;
  }
}

/** The push half of a settings view. `undefined` — no push store wired — reads
 *  as off rather than as an error, because a paddock built without push is not
 *  a paddock with a broken one. */
function pushView(push: PushStore | undefined): {
  devices: number; vapidPublicKey: string | null; error: string | null;
} {
  if (push === undefined) return { devices: 0, vapidPublicKey: null, error: null };
  return { devices: push.list().length, vapidPublicKey: push.publicKey(), error: push.error };
}

export interface AppDeps {
  store: AgentStore;
  hub: Hub;
  health: () => HealthBody;
  /** Built UI directory. Omit in tests that only exercise the API. */
  staticDir?: string;
  /** herdr actions. Omit in tests that only exercise the read-only API. */
  actions?: HerdrActions;
  /** Settings store. Omit in tests that only exercise the agent API. */
  settings?: SettingsStore;
  /** Push subscriptions and the VAPID keypair. Omit in tests that do not
   *  exercise push; its absence renders the settings section as "off". */
  push?: PushStore;
  /** Reads a harness's own session log. Omit in tests that do not exercise it. */
  journal?: JournalReader;
  /**
   * The commands an agent's project declares, read from its working directory.
   *
   * Injected for the same reason `journal` is: the route must be exercisable
   * without a filesystem. Omitted in `--demo`, where there is no project to
   * read and a real enumeration would put an operator's own command names into
   * the mode README screenshots come from.
   */
  readCommands?: (cwd: string) => Promise<AgentCommand[]>;
  /**
   * Writes one attached image and returns where it landed.
   *
   * Injected so the route is exercisable with no filesystem, and OMITTED in
   * `--demo`: a demo that appeared to accept an upload and quietly dropped it
   * would be exactly the mislabelled control this project bans.
   */
  saveImage?: (bytes: Uint8Array) => Promise<SavedImage | { refused: string }>;
  /**
   * The path↔id map behind the file routes. Omitted in `--demo`, which makes
   * every one of them 404: a demo must never serve a real file off the
   * operator's disk, and README screenshots are taken in that mode.
   */
  files?: FileStore;
  /** The size ceiling, overridable so a test need not write 25 MB to disk. */
  maxFileBytes?: number;
  /**
   * The operator's home, for expanding a `~` path the transcript linkified.
   * Injected rather than read from the environment so a test is not bound to
   * the machine running it.
   */
  homeDir?: string;
  /** The server-side session id for an agent. Never crosses the socket. */
  sessionFor?: (agentId: string) => HerdrAgentSession | null;
  /**
   * Clock for `/ack`'s `acknowledgedAt` stamp, every `settings.view()` call
   * (its `serverNow`), and the mute route's stamped `mutedUntil`. One clock
   * for all of them, or `serverNow` disagrees between GET, PUT and mute
   * responses and the UI's countdown drifts for no visible reason. Same
   * injectable-clock pattern as `Hub`, `Supervisor`, and `DemoSource`
   * elsewhere in this codebase — defaults to `Date.now` in production,
   * overridden in tests so an assertion can compare against a fixed fixture
   * timestamp.
   */
  now?: () => number;
  /** Telegram sender. Injected in tests so the suite never makes a real
   *  network request; defaults to the real transport in production. */
  sendTest?: (o: { token: string; chatId: string; text: string }) => Promise<{ ok: boolean; detail: string | null }>;
  /**
   * Present only in `paddock tunnel`. Its presence is what registers `/pair`
   * and the invite route — the same pattern `actions` uses: a paddock with no
   * tunnel 404s them honestly rather than offering a pairing flow that could
   * not gate anything.
   *
   * Structurally typed rather than importing `Pairing`, so `routes.ts` does not
   * depend on the tunnel module for a type it only reads.
   */
  pairing?: {
    attempt(input: string):
      | { kind: "paired"; token: string }
      | { kind: "wrong"; remaining: number }
      | { kind: "burned" };
    reissue(): { code: string; expiresAt: number };
    current(): { code: string; expiresAt: number };
    readonly pairedCount: number;
  };
  /** The live tunnel URL, for the settings view. */
  tunnelUrl?: () => string | null;
  /**
   * The hostnames this deployment is legitimately reached on, for the
   * same-origin gate — see `origin.ts`. Omitted in tests and in any caller with
   * no public hostname, which is the documented INACTIVE case: the origin/Host
   * comparison still applies, only DNS-rebinding cover is absent.
   */
  publicHosts?: () => readonly string[];
  /**
   * Reads herdr's whole session tree. Absent in --demo, exactly like
   * `actions`: the route then 404s honestly rather than synthesising a tree
   * from fake agents.
   */
  readTree?: () => Promise<SpaceTree>;
  /**
   * Ask the supervisor to re-read herdr now, rather than at the next healing
   * pass. Used by the agent rename route, and deliberately by nothing else.
   *
   * WHY IT HAS TO EXIST: measured against the live herdr schema, `tab.renamed`
   * and `workspace.renamed` are EVENTS — paddock subscribes to both, which is
   * why renaming a tab or a space reaches the Spaces screen immediately.
   * Renaming an AGENT is a method with no event beside it. herdr never
   * announces it, so no subscription can carry it and the dashboard would sit
   * on the old name for up to `reconcileMs` (30s).
   *
   * This does NOT cross the §3 invariant. A management route still never
   * writes to the store or enqueues to the hub — it asks the component that
   * owns the store to re-read its source, exactly as the healing timer does,
   * and the delta reaches browsers by the one path it always has.
   */
  reconcile?: () => Promise<unknown>;
  /**
   * The operator's home directory, so a tilde-ised `cwd` coming BACK from the
   * client can be expanded before it reaches herdr — see `expandHome` in
   * `tree.ts`, which is the same value `toSpaceTree` uses to tilde-ise it on
   * the way out. Optional and absent in tests that do not exercise a path: an
   * absent home leaves the value untouched, which is the same thing
   * `tildeise` does.
   */
  home?: string;
}

/**
 * What an operator reads when a herdr call fails.
 *
 * `err.message`, not `String(err)`. The latter renders an Error as
 * "Error: the socket refused", and that prefix is shown verbatim in the UI —
 * `detail` is surfaced by `.error` on the terminal and by the row sheets. Most
 * routes here already did it this way; four did not, and the difference only
 * became visible when `--demo` started producing errors people are meant to
 * READ ("this is the demo — nothing was sent"), rather than only real herdr
 * failures nobody wants to see anyway.
 *
 * `String` remains the fallback for a thrown non-Error, which is the case
 * `err.message` cannot serve.
 */
function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A rename refusal an operator can read.
 *
 * MEASURED, and it answers a question `docs/roadmap.md` recorded as unknown:
 * herdr REFUSES a duplicate agent name rather than renaming or accepting it.
 * The refusal arrives as
 *
 *   herdr agent.rename failed [agent_name_taken]: agent name obsidian is
 *   already used; candidates: terminal_id=… pane_id=… workspace_id=…
 *   cwd=/home/…/project status=Idle
 *
 * which is relayed straight into `detail` and rendered in the UI. Two problems
 * with that, and only the second is cosmetic: it puts a terminal id, a pane
 * id and an ABSOLUTE HOME PATH on a screen the operator may hand to someone or
 * screenshot — the disclosure §16.6 went out of its way to remove from a row —
 * and it says none of that to the person trying to pick a name.
 *
 * So this one code gets a sentence. Every other failure is relayed verbatim,
 * because a message paddock does not recognise is one it must not paraphrase:
 * guessing at an unknown herdr error is how a report becomes misleading.
 */
function renameDetail(err: unknown): string {
  const raw = detailOf(err);
  if (!raw.includes("agent_name_taken")) return raw;
  // The name herdr objected to, read back out of its own message rather than
  // from the request — so what is quoted is what herdr actually compared.
  const taken = /agent name (\S+) is already used/.exec(raw)?.[1];
  return taken === undefined
    ? "That name is already used by another agent."
    : `Another agent is already called \`${taken}\`. Names have to be unique.`;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const now = deps.now ?? Date.now;

  /**
   * Compression, first in the chain so it covers every route below.
   *
   * Terminal output is highly repetitive — box drawing, indentation, and long
   * runs of the same SGR escape — so it compresses hard: a measured 10,805 B
   * screen gzips to 2,435 B, 23% of the original. At a 3s refresh that is the
   * difference between ~12.8 MB and ~2.9 MB per hour of watching one agent,
   * which on a metered phone connection is the whole point.
   *
   * This is also the honest answer to "should the API move onto the
   * WebSocket": the HTTP headers this would have saved are 111 B of a 10.8 KB
   * response, about 1%. The payload was always where the bytes were.
   */
  app.use("*", compress());

  /**
   * The same-origin gate on every state-changing request — the other half of
   * decision 12, which restored the CORS preflight for the three settings
   * routes and said what it did not cover: "the pre-existing action routes are
   * POST already and carry larger levers ... It is a floor, not a fix."
   *
   * ONE middleware rather than a check per route, because the guard belongs to
   * the VERB, not to a handler's dependencies: `/ack` is registered even in demo
   * mode, `/text` only when `actions` is present, and a future write route must
   * be covered by existing to be a write rather than by remembering to opt in.
   * Both listeners share this app, so this covers the desk's 8787 and the
   * tunnel's gated listener at once.
   *
   * GET and HEAD are deliberately NOT guarded. Browsers omit `Origin` on
   * same-origin GETs, so a guard there would have to accept a missing one and
   * would gate nothing; meanwhile a cross-origin GET cannot read the response,
   * since paddock sends no CORS headers. What guarding reads WOULD achieve is
   * breaking `/sw.js` and the app shell — decision 3's exact failure, arrived at
   * from a new direction. `/ws` is not a route on this app at all: it is
   * intercepted before `app.fetch`, and `ws/serve.ts` guards it there.
   *
   * This is still not authentication. Nothing here identifies anybody; it asks
   * the one question a browser cannot lie about — which page this request acts
   * for — so decision 3 stands untouched.
   */
  app.use("*", async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD") return next();

    const host = hostOf(c.req.raw);
    const origin = c.req.header("origin") ?? null;
    // Read through the thunk on every request, never cached: `publicUrl` is
    // editable from the settings UI while the process runs, and a tunnel URL
    // appears mid-run. Taken as a DEPENDENCY rather than derived here from
    // `settings` and `tunnelUrl`, because `ws/serve.ts` needs the same list and
    // two derivations of one fact is how they come to disagree — which is not
    // hypothetical: the first version of this middleware derived its own, and
    // the gated listener's HTTP writes and its WebSocket upgrades then answered
    // to different allowlists.
    if (allowWrite(origin, host, deps.publicHosts?.() ?? [])) return next();

    reportRefusal(origin, host, deps.publicHosts?.() ?? []);
    return c.json({ ok: false, detail: "cross-origin rejected" }, 403);
  });

  // No authentication middleware. Cloudflare Access is the only gate — see
  // docs/decisions.md before adding one.
  app.get("/api/health", (c) => c.json(deps.health()));

  app.get("/api/agents", (c) =>
    c.json({ hostId: deps.store.hostId, agents: deps.store.snapshot() }),
  );

  /**
   * The whole herdr session, read on demand.
   *
   * A GET, and that does not breach "never put payloads in a GET query
   * string": this request has no parameters at all. The tree is deliberately
   * NOT held in `state/store.ts` — see the design doc §5.2.
   *
   * An empty tree and a broken herdr must never look alike, so a failure is a
   * 502 carrying herdr's own message rather than `{spaces: []}`.
   */
  app.get("/api/spaces", async (c) => {
    if (!deps.readTree) {
      return c.json({ ok: false, detail: "herdr is not connected; no tree to read" }, 404);
    }
    try {
      return c.json(await deps.readTree());
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warn(`spaces: could not read the herdr session: ${detail}`);
      return c.json({ ok: false, detail }, 502);
    }
  });

  // Registered unconditionally, OUTSIDE the `deps.actions` block below:
  // acknowledging touches only paddock's own store and the hub, and spec §7 is
  // explicit that nothing is sent to herdr for it. Gating it on a herdr
  // dependency it does not use made the one v2 feature that works without
  // herdr the one visibly broken in `--demo` — the seeded `done` agent offered
  // a Dismiss button whose POST fell through to the `/api/*` 404, so the card
  // reported "Could not dismiss." forever, in the mode the README says
  // screenshots come from.
  app.post("/api/agents/:id/ack", (c) => {
    const delta = deps.store.acknowledge(c.req.param("id"), now());
    if (!delta) return c.json({ ok: false, detail: "not a fresh done agent" }, 409);
    deps.hub.queue(delta); // reaches every other open browser
    return c.json({ ok: true });
  });

  /**
   * Earlier history from the agent's OWN session log.
   *
   * Registered unconditionally, like `/ack` and unlike the action routes:
   * this reads a file and never touches herdr, so gating it on a herdr
   * dependency it does not use would repeat the mistake `/ack`'s comment
   * records — the one feature that works without herdr being the one
   * visibly broken in `--demo`.
   *
   * POST, not GET: a cursor in a query string lands in edge access logs.
   */
  app.post("/api/agents/:id/history", async (c) => {
    const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
    if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
    if (!deps.journal) return c.json({ ok: false, detail: "journal reading is not configured" }, 404);

    const body = await jsonBody(c);
    // Refused, never coerced: the cursor is opaque and must be one this
    // server issued. Folding garbage to 0 would silently serve the top of
    // the file instead of the page the operator asked for.
    let before: number | null = null;
    if (body.before !== undefined && body.before !== null) {
      if (typeof body.before !== "string" || !/^\d+$/.test(body.before)) {
        return c.json({ ok: false, detail: "before must be a cursor from a previous response" }, 400);
      }
      before = Number(body.before);
    }
    const limit = typeof body.limit === "number" && body.limit > 0 && body.limit <= 200
      ? Math.floor(body.limit)
      : 50;

    const page = await deps.journal.read(deps.sessionFor?.(agent.agentId) ?? null, before, limit);
    if (page.detail !== null) reportJournalMiss(agent.agentId, page.detail);
    else clearJournalMiss(agent.agentId);
    return c.json({ ok: true, ...page });
  });

  /**
   * The commands this agent's own project declares, for the reply field's
   * autocomplete.
   *
   * A POST with no body, like `/api/panes/:id/output` beside it and for that
   * route's stated reason: every per-agent read here is one shape, and an
   * empty payload does not earn a second one. Nothing is read from the body.
   *
   * `cwd` is taken from the agent's OWN record and never from the request.
   * That is the whole of this route's path safety: no directory the browser
   * names can be read, because the browser names none.
   *
   * Every failure answers 200 with an empty list. The autocomplete is a
   * convenience on top of a field that has to keep working, so an unreadable
   * project must cost the operator the list and nothing else — a 500 here
   * would surface as a red error for a feature they never asked for. The
   * reasons are logged rather than swallowed.
   */
  app.post("/api/agents/:id/commands", async (c) => {
    const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
    if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
    if (!deps.readCommands) return c.json({ ok: true, commands: [] });
    // An empty cwd is reachable — `toAgent` defaults herdr's missing `cwd` to
    // "" — and joining it would resolve against paddock's OWN process
    // directory, which has nothing to do with this agent.
    if (agent.cwd === "") return c.json({ ok: true, commands: [] });

    try {
      return c.json({ ok: true, commands: await deps.readCommands(agent.cwd) });
    } catch (err) {
      console.error(`commands: could not read ${agent.cwd}`, err);
      return c.json({ ok: true, commands: [] });
    }
  });

  /**
   * Attach an image, on its way to an agent.
   *
   * The ONE route in paddock that accepts arbitrary bytes and writes them to
   * disk. Raw body rather than multipart: there is one field, and a multipart
   * parser is a larger surface than the thing it would carry.
   *
   * Refusals are 400 with the reason in `detail`, which the client puts in
   * front of the operator verbatim — `saveImage` owns what is acceptable (type
   * sniffed from the bytes, never taken from a header) and this route owns only
   * how that answer is delivered.
   *
   * The size guard here is on the DECLARED length, deliberately ahead of
   * reading the body: buffering half a gigabyte to discover it is too large is
   * the denial of service, not the defence against it. `saveImage` checks the
   * real length again, because a declared one is a claim.
   */
  app.post("/api/agents/:id/image", async (c) => {
    const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
    if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
    if (!deps.saveImage) {
      return c.json({ ok: false, detail: "image upload is not configured" }, 404);
    }

    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      return c.json({
        ok: false,
        detail: `images are limited to ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB`,
      }, 413);
    }

    const saved = await deps.saveImage(new Uint8Array(await c.req.arrayBuffer()));
    if ("refused" in saved) return c.json({ ok: false, detail: saved.refused }, 400);
    return c.json({ ok: true, path: saved.path, name: saved.name });
  });

  /**
   * Exchange a path for an id.
   *
   * A POST because `CLAUDE.md` forbids payloads in GET URLs — they land in edge
   * access logs, and a file path is exactly that. What comes back is meaningless
   * in a log, and an `<iframe src>` and a download link both need a plain GET.
   *
   * THE SCOPE IS UNRESTRICTED, deliberately: any path this process can read. A
   * denylist here would be theatre — `POST /api/panes/:id/text` can already
   * `cat` any file into a pane and print it in the transcript, so this route
   * grants convenience rather than capability. See `docs/decisions.md` and
   * `docs/design/2026-08-28-file-viewer-design.md`.
   *
   * Every refusal gets its OWN sentence. "Could not open" for all of them would
   * send the operator to check the wrong thing — the same reasoning
   * `startup-errors.ts` applies to a refused boot.
   */
  app.post("/api/files", async (c) => {
    if (!deps.files) return c.json({ ok: false, detail: "file viewing is not configured" }, 404);

    const body = await jsonBody(c);
    const asked = typeof body.path === "string" ? body.path : "";
    // Normalised BEFORE the stat: the transcript linkifies `~/…` and
    // `file://…`, and neither is something the filesystem can open. Without
    // this the feature offers taps that always answer "no file".
    const path = resolveOpenable(asked, deps.homeDir);
    if (path === null) {
      return asked.trim() === ""
        ? c.json({ ok: false, detail: "a path is required" }, 400)
        // Said specifically: a relative path is not a typo, it is a path whose
        // meaning depends on a working directory paddock cannot see.
        : c.json({ ok: false, detail: `${asked.trim()} is not an absolute path` }, 400);
    }

    // `statSync` rather than `Bun.file().exists()`, MEASURED: `exists()` returns
    // false for a directory, so an exists-first route reports a directory as
    // missing and sends the operator looking for a file that is right there.
    let stats: Stats;
    try {
      stats = statSync(path);
    } catch (err) {
      const code = errorCode(err);
      if (code === "ENOENT") return c.json({ ok: false, detail: `no file at ${path}` }, 404);
      // Permissions, a broken symlink, a path component that is not a
      // directory: named rather than folded into "not found", because they send
      // the operator somewhere different.
      return c.json({ ok: false, detail: `cannot read ${path}${code ? ` (${code})` : ""}` }, 400);
    }

    if (stats.isDirectory()) {
      return c.json({ ok: false, detail: `${path} is a directory, not a file` }, 400);
    }

    const ceiling = deps.maxFileBytes ?? MAX_FILE_BYTES;
    if (stats.size > ceiling) {
      const mb = (stats.size / (1024 * 1024)).toFixed(1);
      const capMb = Math.floor(ceiling / (1024 * 1024));
      return c.json({ ok: false, detail: `that file is ${mb} MB — the limit is ${capMb} MB` }, 413);
    }

    return c.json({
      ok: true,
      id: deps.files.issue(path),
      name: basenameOf(path),
      render: kindFor(path).render,
    });
  });

  /**
   * What a file is, for a viewer that has only an id.
   *
   * `#/file/:id` survives a reload — that is why it is a route rather than a
   * sheet — and the name and render mode were only ever in memory from the
   * moment the file was opened. Without this the viewer comes back from a
   * refresh holding an id and nothing to render it as.
   */
  app.get("/api/files/:id/meta", (c) => {
    if (!deps.files) return c.json({ ok: false, detail: "file viewing is not configured" }, 404);
    const path = fileFor(deps.files, c.req.param("id"));
    if (path === null) return c.json({ ok: false, detail: "unknown file" }, 404);
    return c.json({ ok: true, name: basenameOf(path), render: kindFor(path).render });
  });

  /**
   * Serve the bytes.
   *
   * `Content-Security-Policy: sandbox` is the load-bearing header, and it is NOT
   * the same as `<iframe sandbox>`. The attribute protects the page doing the
   * embedding; the header protects against this URL being opened DIRECTLY, which
   * anyone can do because the id sits in the viewer's address bar. Without it an
   * HTML file served here is same-origin with paddock and can call paddock's own
   * API with the browser's credentials — driving the operator's agents from a
   * page an agent generated after reading a poisoned README. That is worse than
   * reading any single file, so the header is on BOTH routes, including the
   * download one a reader would assume is exempt.
   */
  const serveFile = async (c: Context, asAttachment: boolean) => {
    if (!deps.files) return c.json({ ok: false, detail: "file viewing is not configured" }, 404);
    const path = fileFor(deps.files, c.req.param("id"));
    if (path === null) return c.json({ ok: false, detail: "unknown file" }, 404);

    const file = Bun.file(path);
    if (!(await file.exists())) {
      // Between the POST and the GET the file can be moved or deleted. Said
      // differently from "unknown file": one is a stale id, the other a stale
      // disk, and they are fixed differently.
      return c.json({ ok: false, detail: "that file is no longer there" }, 404);
    }

    const name = basenameOf(path);
    const headers: Record<string, string> = {
      "content-type": kindFor(path).contentType,
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
    };
    if (asAttachment) {
      // Quotes and backslashes stripped rather than escaped: a filename is not
      // a place to be clever with header parsing.
      headers["content-disposition"] = `attachment; filename="${name.replace(/["\\]/g, "")}"`;
    }
    return new Response(file, { headers });
  };

  app.get("/api/files/:id", (c) => serveFile(c, false));
  app.get("/api/files/:id/download", (c) => serveFile(c, true));

  const pairing = deps.pairing;
  if (pairing) {
    /**
     * The ONE route reachable without a session — `gate.decide` passes it
     * explicitly, because there is otherwise no way to acquire one.
     *
     * `strictJsonBody` for decision 12's reason, and more sharply than
     * anywhere else in this file: this route is reachable from the public
     * internet by design, so the preflight it restores is the only thing
     * standing between a drive-by page and an attempt at the code.
     */
    app.post("/pair", async (c) => {
      const parsed = await strictJsonBody(c);
      if (!parsed.ok) return c.json({ ok: false, detail: parsed.detail }, 400);
      // The three outcomes live in `pairOutcome` — shared with the publishing
      // tunnel's own listener, which serves no app at all and would otherwise
      // carry a transcribed copy of them. A refusal that differed between the
      // two modes is exactly the divergence that sharing prevents.
      //
      // A malformed body is NOT a guess and must not spend the budget —
      // otherwise anyone can burn codes without ever sending one. That rule
      // lives in `pairOutcome` now, with the outcomes it governs.
      const out = pairOutcome(parsed.body.code, pairing);
      if (out.token !== undefined) c.header("set-cookie", setCookie(out.token));
      return c.json(out.body, out.status as 200 | 400 | 429);
    });

    /**
     * Mints a fresh code from an ALREADY PAIRED device: after several days the
     * assumption that the operator is at their desk is the weaker one. It sits
     * under `/api/`, so the gate covers it like every other API route — a
     * trusted device in the operator's hand vouching for the next one.
     *
     * `strictJsonBody` for decision 12's reason, even though the body is
     * empty. The check is a FLOOR under every mutating POST in this file
     * precisely so that no single route has to be argued about on its own
     * merits — and this is the route that MINTS A CREDENTIAL. Today
     * `SameSite=Lax` keeps the session cookie off a cross-site POST, so a
     * drive-by form is refused by the gate before Hono sees it; that makes
     * `SameSite` the only control here, on the one route where it should be
     * the second. The UI already sends `content-type: application/json` with
     * a `{}` body.
     */
    app.post("/api/pair/invite", async (c) => {
      const parsed = await strictJsonBody(c);
      if (!parsed.ok) return c.json({ ok: false, detail: parsed.detail }, 400);
      const { code, expiresAt } = pairing.reissue();
      return c.json({ code: formatCode(code), expiresAt });
    });
  }

  if (deps.actions) {
    const actions = deps.actions;

    // POST, never GET: a payload in a query string lands in edge access logs.
    app.post("/api/agents/:id/output", async (c) => {
      const live = deps.store.snapshot();
      const agent = live.find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
      // Evicted here rather than on a timer: the cache only ever grows when
      // someone polls, so pruning on a poll is both sufficient and
      // self-limiting. Cheap — one pass over a handful of agents.
      pruneScreens(new Set(live.map((a) => a.agentId)));
      // Coerced and clamped, never cast: this is the only client-supplied
      // value besides the store-checked `:id` that reaches a herdr parameter.
      const body = await jsonBody(c);
      const lines = resolveReadLines(body.lines);
      // Opt-IN, so the default request is the fast one. The UI paints from a
      // `visible` read first and only asks for scrollback afterwards; making
      // scrollback the default is what put a multi-second herdr pane-scroll
      // in front of the first frame.
      const scrollback = body.scrollback === true;
      // The digest of the screen the caller already holds, if any. Only a
      // string is honoured, so a malformed value revalidates to "changed" and
      // costs a full response rather than wrongly reporting no change.
      const since = typeof body.since === "string" ? body.since : null;
      try {
        const out = await actions.readOutput(agent.agentId, agent.state, lines, scrollback);
        const digest = digestOf(out.lines);
        rememberScreen(agent.agentId, digest, out.lines);

        // 200, not 304: a 304 is defined against HTTP's own cache validators,
        // which do not apply to POST. This is an application-level answer that
        // happens to mean the same thing.
        if (since !== null && since === digest) return c.json({ unchanged: true });

        // If the screen the caller is holding is still known, send only what
        // moved. Scrollback reads are excluded: they are a different, much
        // larger view of the pane, and diffing one against a viewport would
        // produce a patch that rewrites nearly every line for no saving.
        if (since !== null && !scrollback) {
          const base = heldScreen(agent.agentId, since);
          if (base) return c.json({ patch: diffScreens(base, out.lines), source: out.source });
        }
        return c.json({ ...out, digest });
      } catch (err) {
        return c.json({ ok: false, detail: detailOf(err) }, 502);
      }
    });

    app.post("/api/agents/:id/prompt", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
      try {
        return c.json(parsePrompt(await actions.readPromptScreen(agent.agentId)));
      } catch (err) {
        return c.json({ ok: false, detail: detailOf(err) }, 502);
      }
    });

    /**
     * Send one navigation key, then return the screen it produced.
     *
     * Deliberately NOT restricted to `blocked`, unlike `/answer`. The two are
     * different capabilities: `/answer` commits a reply paddock composed, so
     * it must prove the agent is still asking; a nav key only moves the
     * agent's own cursor on a screen the operator is looking at. Restricting
     * it would also make the keypad appear and vanish under the operator's
     * thumb as the agent's state changed, and would remove the one remote
     * interrupt (`esc`) that a phone genuinely needs.
     *
     * What keeps this from being a general-purpose send endpoint is
     * `isNavKey`: a closed allowlist of nine names, checked here rather than
     * trusted to the UI, so no control sequence can be smuggled through.
     */
    app.post("/api/agents/:id/key", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);

      const key = (await jsonBody(c)).key;
      if (!isNavKey(key)) {
        return c.json({ ok: false, detail: `unsupported key: ${String(key)}` }, 400);
      }

      try {
        await actions.sendNavKey(agent.agentId, key);
        // A TUI repaints asynchronously after the write. Reading immediately
        // races the repaint and returns the PREVIOUS frame — which looks
        // exactly like a key that did nothing, and would send the operator
        // pressing it again.
        await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));
        const out = await actions.readOutput(agent.agentId, agent.state);
        // Re-derived server-side rather than in the browser: the cursor has
        // just moved, and the preview that tells the operator what Enter will
        // commit has to move with it. Parsing it in `web/` would put TUI
        // knowledge on the wrong side of the dependency rule.
        // `parsePrompt`, not `selectedLine`: the preview must be scoped to the
        // menu on screen the same way `/prompt` scopes it. Deriving it from the
        // bare marker scan here is what let a marker left on an ALREADY
        // ANSWERED question reappear as this menu's selection on the first
        // arrow tap — correct on load, wrong the moment the operator moved.
        // The dialog rides along for the same reason `selected` does, and the
        // omission was a shipped bug: an arrow moved the agent to the next
        // question and the UI kept rendering the previous one, because nothing
        // in this response told it otherwise. Reported as "cannot jump to next
        // tab" — the key worked, the screen never changed.
        const parsed = parsePrompt(out.lines.join("\n"));
        return c.json({ ok: true, ...out, selected: parsed.selected, dialog: parsed.dialog });
      } catch (err) {
        return c.json({ ok: false, detail: detailOf(err), lines: [], source: "" }, 502);
      }
    });

    /**
     * Move a question dialog to its next or previous question.
     *
     * Its own route rather than a plain `/key`, for one reason: it WAITS until
     * the screen agrees. `/key` sends and pauses once, which is a guess about
     * repaint speed — when the guess was wrong the re-read returned the
     * previous question and the UI rendered it, so the tap looked ignored.
     * Reported as "left right sometimes not work", and intermittent is the
     * worst way for a control to fail.
     *
     * There is no `Next` button any more: the arrows reach every tab including
     * Submit, so a second control that did the same thing was one more surface
     * for the same class of bug.
     */
    app.post("/api/agents/:id/dialog-tab", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);

      const dir = (await jsonBody(c)).dir;
      if (dir !== "left" && dir !== "right") {
        return c.json({ ok: false, detail: `dir must be "left" or "right"` }, 400);
      }

      try {
        const outcome = await moveDialogTab(agent.agentId, dir, { ...actions, settle });
        if (!outcome.ok) return c.json({ ok: false, detail: outcome.detail }, 409);
        const out = await actions.readOutput(agent.agentId, agent.state);
        // `selected` as well as `dialog`, from the SAME read. Returning one
        // without the other left the "Enter selects" line showing the previous
        // question's answer while the panel showed the new question — reported
        // from a phone, and worse than cosmetic: that line is what says which
        // row Enter will act on, and Enter acts on the cursor.
        const parsed = parsePrompt(out.lines.join("\n"));
        return c.json({ ok: true, ...out, selected: parsed.selected, dialog: parsed.dialog });
      } catch (err) {
        return c.json({ ok: false, detail: detailOf(err), lines: [], source: "" }, 502);
      }
    });

    /**
     * Type literal characters into a question dialog's free-text row.
     *
     * Distinct from `/text`, which SUBMITS a reply through `agent.prompt`. That
     * is the route the reply box uses and it is right for prose, but it is
     * exactly what fails while a menu holds the agent's keyboard: measured, the
     * submitted reply lands nowhere the operator can see, which is the reported
     * defect this route exists to fix.
     *
     * The cursor is MOVED AND VERIFIED before a character is sent — see
     * `dialog-type.ts` for why that is not optional. Characters land only in the
     * row the cursor is on, typing into that row also ticks its checkbox, and
     * `space` inserts there while toggling everywhere else. One row off is not a
     * cosmetic error.
     *
     * Validated here rather than trusted to the UI, like every other
     * client-supplied string that reaches a herdr parameter. Control characters
     * are refused because they are KEYS, not text: a newline is Enter, and
     * Enter on a dialog row means something the operator did not ask for.
     * Non-ASCII is NOT refused — measured to work, and it is what the operator
     * types.
     */
    app.post("/api/agents/:id/type", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);

      const text = (await jsonBody(c)).text;
      const chars = typeof text === "string" ? [...text] : [];
      const printable = chars.every((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code >= 0x20 && code !== 0x7f;
      });
      if (
        typeof text !== "string" || text.trim() === "" ||
        chars.length > MAX_TYPE_CHARS || !printable
      ) {
        return c.json({
          ok: false,
          detail: "text must be printable characters within the length limit",
        }, 400);
      }

      try {
        const outcome = await typeIntoFreeText(agent.agentId, chars, { ...actions, settle });
        if (!outcome.ok) return c.json({ ok: false, detail: outcome.detail }, 409);
        await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));
        const out = await actions.readOutput(agent.agentId, agent.state);
        const parsed = parsePrompt(out.lines.join("\n"));
        return c.json({ ok: true, ...out, dialog: parsed.dialog });
      } catch (err) {
        return c.json({ ok: false, detail: detailOf(err), lines: [], source: "" }, 502);
      }
    });

    /**
     * Send one option digit to a question dialog, and answer with the screen.
     *
     * NOT `/answer`, and the difference is measured rather than stylistic.
     * `/answer` commits a reply and then calls `waitUntilUnblocked`, because an
     * answered prompt is expected to move on. A dialog digit never unblocks
     * anything: a multi-select digit TOGGLES a checkbox, and even a
     * single-select digit only advances to the review tab — the agent stays
     * `blocked` until "Submit answers". Routed through `/answer`, every
     * checkbox tap would wait out the full 15s budget and then report a failure
     * for a toggle that had already worked.
     *
     * So this settles and re-reads, the way `/key` does, and returns the parsed
     * screen with it. That is what keeps the checkbox on the phone honest:
     * `/prompt` is fetched once per state change and never polled, so a mark
     * derived only from that fetch would lag the agent until the state changed.
     *
     * Gated on `blocked` for the same reason `/answer` is: no dialog exists in
     * any other state, and a digit typed into whatever replaced it is a
     * keystroke the operator did not ask for.
     */
    app.post("/api/agents/:id/dialog-key", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
      if (agent.state !== "blocked") {
        return c.json({ ok: false, detail: `agent is ${agent.state}, no dialog to answer` }, 409);
      }

      const key = (await jsonBody(c)).key;
      if (typeof key !== "string" || !OPTION_KEY_RE.test(key)) {
        return c.json({ ok: false, detail: `key must be an option digit, e.g. "2"` }, 400);
      }

      try {
        // NOT a bare `sendOptionKey`: a digit is a toggle only while the cursor
        // is off the free-text row. Parked on it, the digit is TEXT — measured
        // on a phone, a tap appended its digit to the operator's typed answer
        // and the option never moved.
        const outcome = await toggleDialogOption(agent.agentId, key, { ...actions, settle });
        if (!outcome.ok) return c.json({ ok: false, detail: outcome.detail }, 409);
        // A TUI repaints asynchronously after the write — see `/key`'s note.
        await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));
        const out = await actions.readOutput(agent.agentId, agent.state);
        const parsed = parsePrompt(out.lines.join("\n"));
        return c.json({ ok: true, ...out, selected: parsed.selected, dialog: parsed.dialog });
      } catch (err) {
        return c.json({ ok: false, detail: detailOf(err), lines: [], source: "" }, 502);
      }
    });

    /**
     * Add a note to a question dialog, and commit it.
     *
     * `mode` is the whole of this route, and it is a MEASURED distinction
     * rather than a preference. Sent as `note-only` the agent receives
     * "(no option selected) notes: …"; sent as `with-option` it receives the
     * option under the cursor AND the note. The keystrokes differ by one Esc,
     * and getting it wrong silently discards the operator's answer — so the
     * caller states which one it means and the server never guesses.
     *
     * Gated on `blocked` for the reason `/answer` and `/dialog-key` are: no
     * dialog exists in any other state, and these keystrokes typed into
     * whatever replaced it are input the operator never asked to send.
     */
    /**
     * Commit a question dialog's option by walking its cursor onto it.
     *
     * NOT `/answer`, and the difference is measured. `/answer` sends the
     * option's DIGIT and then waits for the agent to leave `blocked`. Sent to
     * this dialog a digit does nothing at all — measured, the cursor stayed
     * put and the dialog stayed up — so the wait ran out its budget and
     * reported a failure for a keystroke that had never landed. On a phone
     * that was a button claiming to answer and silently not answering.
     *
     * Settles and re-reads instead of waiting, the way `/dialog-key` does: the
     * agent may unblock on this Enter or may advance to another question, and
     * a route that assumed the first would fail honestly-looking failures for
     * the second.
     */
    app.post("/api/agents/:id/select", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
      if (agent.state !== "blocked") {
        return c.json({ ok: false, detail: `agent is ${agent.state}, no dialog to answer` }, 409);
      }

      const key = (await jsonBody(c)).key;
      if (typeof key !== "string" || !OPTION_KEY_RE.test(key)) {
        return c.json({ ok: false, detail: `key must be an option digit, e.g. "2"` }, 400);
      }

      try {
        const outcome = await selectByCursor(agent.agentId, key, { ...actions, settle });
        if (!outcome.ok) return c.json({ ok: false, detail: outcome.detail }, 409);
        await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));
        const out = await actions.readOutput(agent.agentId, agent.state);
        const parsed = parsePrompt(out.lines.join("\n"));
        return c.json({ ok: true, ...out, selected: parsed.selected });
      } catch (err) {
        return c.json({ ok: false, detail: detailOf(err), lines: [], source: "" }, 502);
      }
    });

    app.post("/api/agents/:id/note", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
      if (agent.state !== "blocked") {
        return c.json({ ok: false, detail: `agent is ${agent.state}, no dialog to answer` }, 409);
      }

      const body = await jsonBody(c);
      const text = body.text;
      const mode = body.mode;
      const chars = typeof text === "string" ? [...text] : [];
      const printable = chars.every((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code >= 0x20 && code !== 0x7f;
      });
      if (
        typeof text !== "string" || text.trim() === "" ||
        chars.length > MAX_TYPE_CHARS || !printable
      ) {
        return c.json({
          ok: false,
          detail: "text must be printable characters within the length limit",
        }, 400);
      }
      if (mode !== "note-only" && mode !== "with-option") {
        return c.json({
          ok: false,
          detail: `mode must be "note-only" or "with-option"`,
        }, 400);
      }

      try {
        const outcome = await addNote(agent.agentId, chars, mode, { ...actions, settle });
        if (!outcome.ok) return c.json({ ok: false, detail: outcome.detail }, 409);
        // A TUI repaints asynchronously after the write — see `/key`'s note.
        await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));
        const out = await actions.readOutput(agent.agentId, agent.state);
        const parsed = parsePrompt(out.lines.join("\n"));
        return c.json({ ok: true, ...out, selected: parsed.selected, notes: parsed.notes });
      } catch (err) {
        return c.json({ ok: false, detail: detailOf(err), lines: [], source: "" }, 502);
      }
    });

    /**
     * Type into the terminal. Accepted in EVERY state.
     *
     * This is not a loosening of `/answer`'s guard — it is the capability that
     * guard was never meant to provide. `/answer` commits a reply composed for
     * a PROMPT, so it must prove the agent is still asking; typing that reply
     * into whatever replaced the prompt is the exact failure it prevents, and
     * it keeps its 409.
     *
     * This route is the operator typing into a terminal they are looking at,
     * which is the same reasoning that already puts `/key` in every state. The
     * terminal view's reply box points here; before it existed, that box
     * rendered unconditionally against a `blocked`-only route and therefore
     * returned 409 in three states out of four.
     */
    app.post("/api/agents/:id/text", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);

      const text = (await jsonBody(c)).text;
      // The only unbounded client-supplied STRING that reaches a herdr
      // parameter, so it is bounded here for the same reason `lines` is.
      if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT_LEN) {
        return c.json({ ok: false, detail: "text must be a non-empty string within the length limit" }, 400);
      }

      try {
        await actions.sendReply(agent.agentId, text);
        await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));
        const out = await actions.readOutput(agent.agentId, agent.state);
        return c.json({ ok: true, ...out });
      } catch (err) {
        return c.json({ ok: false, detail: detailOf(err), lines: [], source: "" }, 502);
      }
    });

    /**
     * Rename an agent. Validated against `deps.store`, unlike the tab and
     * space routes below it — an agent IS in the store, so reading it here is
     * both correct and the same authority every other `/api/agents/:id/*`
     * route already uses. (Reading the store to validate an id is fine; the
     * §3 invariant this feature must not cross is WRITING to it, or
     * enqueueing to the hub, from a management route — this route does
     * neither: an agent rename rides the existing delta, since `differs()` in
     * `state/store.ts` already compares `a.name !== b.name`.)
     *
     * `name: null` is accepted and forwarded as the one real clear (§7.2,
     * §17) — herdr removes the field rather than storing an empty string, and
     * does not re-derive a name afterward, so a cleared agent falls to
     * paddock's own `basename(cwd)` fallback. That is why this is never
     * called "reset to default" anywhere in the UI: the label that results is
     * paddock's, not herdr's.
     */
    app.post("/api/agents/:id/name", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);

      const name = (await jsonBody(c)).name;
      // Two valid shapes only: `null` (clear) or a non-empty, non-blank
      // bounded string. An empty or whitespace-only string is refused rather
      // than forwarded: no UI path would ever submit one intentionally,
      // since `null` is already the clear control's payload, so refusing it
      // forecloses an ambiguous input rather than a real capability. It also
      // keeps paddock from sending herdr a value that was never measured —
      // only `null` and a real string were (§14.1, §17).
      if (name !== null && (typeof name !== "string" || name.trim() === "" || name.length > MAX_LABEL_LEN)) {
        return c.json({ ok: false, detail: "name must be null or a non-empty string within the length limit" }, 400);
      }

      try {
        await actions.renameAgent(agent.agentId, name);
        // herdr emits no event for this, so ask for a re-read rather than let
        // the dashboard sit on the old name until the healing pass. Failure
        // here is logged and swallowed ON PURPOSE: the rename itself landed,
        // and answering 502 would tell the operator their change did not
        // happen — inviting them to do it again — when the only thing that
        // failed is a follow-up read the 30s timer will repeat anyway.
        try {
          await deps.reconcile?.();
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          warn(`agents: renamed \`${agent.agentId}\` but could not reconcile: ${detail}`);
        }
        return c.json({ ok: true });
      } catch (err) {
        // The LOG keeps herdr's full message — the candidate ids are exactly
        // what someone debugging this needs. The RESPONSE gets the readable
        // one, because that is what an operator sees.
        warn(`agents: could not rename \`${agent.agentId}\`: ${detailOf(err)}`);
        return c.json({ ok: false, detail: renameDetail(err) }, 502);
      }
    });

    /**
     * Output for a pane that has no agent.
     *
     * Separate from `/api/agents/:id/output` because the store cannot
     * validate this id — a shell pane is not in it, by design (§3). The tree
     * is the authority instead.
     *
     * Both herdr calls — `deps.readTree()` and `actions.readPane()` — are
     * wrapped in the same try/catch `/api/spaces` already uses around this
     * exact `readTree()` call, and every sibling route in this block uses
     * around its own herdr call. The gap between validating the pane against
     * a snapshot and reading it is real: a shell pane lives in the tree and
     * not in the store precisely so this route can exist, and that is the
     * same window in which the pane can close. An uncaught throw there would
     * fall through to Hono's default handler as a plain-text 500 instead of
     * paddock's `{ok:false, detail}` 502 carrying herdr's own message — the
     * 404 (unknown pane) and 409 (pane has an agent) outcomes below are
     * deliberate, not errors, and stay outside the catch.
     */
    app.post("/api/panes/:id/output", async (c) => {
      if (!deps.readTree) return c.json({ ok: false, detail: "herdr is not connected" }, 404);
      const id = c.req.param("id");
      try {
        const tree = await deps.readTree();
        const pane = findPane(tree, id);
        if (!pane) return c.json({ ok: false, detail: "unknown pane" }, 404);
        if (pane.harness !== null) {
          return c.json({ ok: false, detail: "this pane has an agent; use /api/agents/:id/output" }, 409);
        }
        const { lines, source } = await actions.readPane(id);
        return c.json({ lines, source });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        warn(`panes: could not read pane \`${id}\`: ${detail}`);
        return c.json({ ok: false, detail }, 502);
      }
    });

    /**
     * Type into a pane with no agent — the shell case §8 promised plain text
     * input for and no route ever delivered (§16.3) — and, with
     * `submit: true`, RUN what was typed.
     *
     * `submit` exists because `pane.send_text` does not submit. Without the
     * key that follows it, the whole shipped shell flow was: open a shell,
     * type `ls`, tap a button labelled **Send**, and watch the text land on
     * the prompt line and sit there. The reply box is single-line, so the
     * operator cannot supply the newline; the only Enter in the app is the
     * keypad's, whose stored default is `hidden`. So the ROUTE performs the
     * whole operator act — one tap on Send is one command run, in one round
     * trip — rather than leaving the client to fire two requests and own the
     * gap between them.
     *
     * Opt-in rather than always-on: typing without running is still a real
     * thing to want (a partial line, a here-doc), and a default that submits
     * would change what every existing caller of this route does.
     *
     * Validation and error shape are `/api/panes/:id/output`'s, verbatim: the
     * 404 (no `readTree`, or unknown pane) and 409 (pane has a harness — use
     * `/api/agents/:id/text` instead) outcomes are deliberate and `return`
     * inside the `try`, so they can never be relabelled a 502. The bad-input
     * 400 for an oversized body is checked before the `try` even opens, same
     * as the agent route.
     */
    app.post("/api/panes/:id/text", async (c) => {
      if (!deps.readTree) return c.json({ ok: false, detail: "herdr is not connected" }, 404);
      const id = c.req.param("id");

      const body = await jsonBody(c);
      const text = body.text;
      // Refused, not truncated — a silently shortened command is a DIFFERENT
      // command, potentially a destructive one. Same ceiling the agent-side
      // `/text` route uses, for the same reason.
      if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT_LEN) {
        return c.json({ ok: false, detail: "text must be a non-empty string within the length limit" }, 400);
      }
      // `=== true`, not truthy: this decides whether a command RUNS, and a
      // body that sent `"submit": "no"` must not run it.
      const submit = body.submit === true;

      try {
        const tree = await deps.readTree();
        const pane = findPane(tree, id);
        if (!pane) return c.json({ ok: false, detail: "unknown pane" }, 404);
        if (pane.harness !== null) {
          return c.json({ ok: false, detail: "this pane has an agent; use /api/agents/:id/text" }, 409);
        }
        await actions.sendPaneText(id, text);
        if (submit) {
          // Its OWN catch, and the reason is that this failure is not the same
          // failure as the one below. The text IS on the prompt line now:
          // reporting a plain error would tell the operator nothing landed,
          // and they would retype a command that is already sitting there —
          // which, once Enter does work, runs it twice. So the half-landed
          // case says both halves, and carries herdr's own reason for the
          // half that did not.
          try {
            await actions.sendPaneKey(id, "enter");
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            warn(`panes: typed into \`${id}\` but could not run it: ${detail}`);
            return c.json({ ok: false, detail: `typed, but not run: ${detail}` }, 502);
          }
        }
        // Settle, then read, then return the screen the command produced.
        //
        // This route used to answer `{ok:true}` alone and leave the browser to
        // discover the result on its next poll. That poll backs off toward
        // MAX_REFRESH_MS while a pane is quiet, so on an idle shell — which is
        // most shells, most of the time — Enter could take the better part of
        // ten seconds to show anything. The operator reported it as "the
        // terminal is slow"; it was neither the terminal nor slow, it was a
        // round trip that never carried the answer back.
        //
        // The agent `/key` route above has settled-and-read since it shipped.
        // This is the same pattern, and the pane routes were the ones missing
        // it. A read costs ~2 ms against herdr; KEY_SETTLE_MS dominates.
        await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));
        const out = await actions.readPane(id);
        return c.json({ ok: true, lines: out.lines, source: out.source });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        warn(`panes: could not send text to pane \`${id}\`: ${detail}`);
        return c.json({ ok: false, detail }, 502);
      }
    });

    /**
     * Send one key to a pane with no agent. Reuses `isNavKey`'s allowlist
     * rather than a second one: the reasoning that closes it on the agent
     * side (a closed set the UI cannot smuggle a control sequence past)
     * applies identically here, and a bare shell is if anything a larger
     * lever than an agent's prompt. A key outside the allowlist is refused
     * with 400 and never reaches herdr.
     */
    app.post("/api/panes/:id/key", async (c) => {
      if (!deps.readTree) return c.json({ ok: false, detail: "herdr is not connected" }, 404);
      const id = c.req.param("id");

      const key = (await jsonBody(c)).key;
      if (!isNavKey(key)) {
        return c.json({ ok: false, detail: `unsupported key: ${String(key)}` }, 400);
      }

      try {
        const tree = await deps.readTree();
        const pane = findPane(tree, id);
        if (!pane) return c.json({ ok: false, detail: "unknown pane" }, 404);
        if (pane.harness !== null) {
          return c.json({ ok: false, detail: "this pane has an agent; use /api/agents/:id/key" }, 409);
        }
        await actions.sendPaneKey(id, key);
        // Settled and read for the reason the `/text` route above gives: a
        // shell's poll has backed off, so the key's effect has to travel back
        // on this response or it waits for the next tick.
        await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));
        const out = await actions.readPane(id);
        return c.json({ ok: true, lines: out.lines, source: out.source });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        warn(`panes: could not send key to pane \`${id}\`: ${detail}`);
        return c.json({ ok: false, detail }, 502);
      }
    });

    /**
     * Rename a tab. Modelled on `/api/panes/:id/output`: 404 when
     * `deps.readTree` is absent, 404 for an unknown id, and a `try`/`catch`
     * around the herdr call that reports `{ok:false, detail}` at 502 — with
     * the deliberate 404 returned from INSIDE the `try`, so a race between
     * validating the id and the tab closing underneath it can never be
     * relabelled a server failure by the catch.
     *
     * Validated against `deps.readTree`, not `deps.store` — a tab is not an
     * agent and is not in the store (§3's invariant). The store and the tree
     * are not interchangeable authorities: an agent id is confirmed by
     * reading the store (see `/api/agents/:id/name` above), a tab or a space
     * id only by reading the tree.
     *
     * `label` is a required, non-empty string. herdr's `tab.rename` ACCEPTS
     * an empty label and stores it as `""` rather than treating it as unset
     * — measured, §17 — so there is no clear for a tab, and an empty OR
     * WHITESPACE-ONLY label is refused with 400 and never forwarded.
     * Whitespace-only was never measured either, and paddock's own
     * `tabLabel` in `tree.ts` normalises a trimmed-empty label to `null`
     * (unnamed) while herdr would still be storing the literal whitespace —
     * exactly the mismatch §17 refuses an empty label to avoid. The check is
     * `label.trim() === ""`, not `label === ""`, so `" "` is refused too;
     * the label FORWARDED on success is still the untrimmed original, same
     * as the agent route below trims only to validate, never to send. It is
     * refused BEFORE the `try` opens, alongside the over-length case: both
     * are client input errors, not herdr failures.
     */
    app.post("/api/tabs/:id/name", async (c) => {
      if (!deps.readTree) return c.json({ ok: false, detail: "herdr is not connected" }, 404);
      const id = c.req.param("id");

      const label = (await jsonBody(c)).label;
      if (typeof label !== "string" || label.trim() === "" || label.length > MAX_LABEL_LEN) {
        return c.json({ ok: false, detail: "label must be a non-empty string within the length limit" }, 400);
      }

      try {
        const tree = await deps.readTree();
        const tab = findTab(tree, id);
        if (!tab) return c.json({ ok: false, detail: "unknown tab" }, 404);
        await actions.renameTab(id, label);
        return c.json({ ok: true });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        warn(`tabs: could not rename \`${id}\`: ${detail}`);
        return c.json({ ok: false, detail }, 502);
      }
    });

    /**
     * Rename a space. Same shape as `/api/tabs/:id/name` immediately above,
     * for the same reasons: validated against `deps.readTree` because a
     * space is not in the store either, and an empty OR WHITESPACE-ONLY
     * label is refused rather than forwarded because `workspace.rename`
     * accepts and stores one verbatim (§17) — there is no clear here either,
     * and neither an empty nor a whitespace-only value was ever measured.
     */
    app.post("/api/spaces/:id/name", async (c) => {
      if (!deps.readTree) return c.json({ ok: false, detail: "herdr is not connected" }, 404);
      const id = c.req.param("id");

      const label = (await jsonBody(c)).label;
      if (typeof label !== "string" || label.trim() === "" || label.length > MAX_LABEL_LEN) {
        return c.json({ ok: false, detail: "label must be a non-empty string within the length limit" }, 400);
      }

      try {
        const tree = await deps.readTree();
        const space = findSpace(tree, id);
        if (!space) return c.json({ ok: false, detail: "unknown space" }, 404);
        await actions.renameSpace(id, label);
        return c.json({ ok: true });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        warn(`spaces: could not rename \`${id}\`: ${detail}`);
        return c.json({ ok: false, detail }, 502);
      }
    });

    /**
     * Close a tab and everything inside it — herdr kills every pane the tab
     * holds, and any pane carrying a working agent kills that agent too.
     * This is paddock's first destructive action (design doc §10).
     *
     * The arm-then-confirm interaction and the "N working agents will be
     * killed" consequence line are a later UI task's job, not this route's —
     * this route just closes, honestly, using the tab already found on the
     * tree read that validated the id.
     *
     * Same shape as `/api/tabs/:id/name` above and for the same reasons: 404
     * when `deps.readTree` is absent, 404 for an unknown id, and a
     * try/catch around the herdr call reporting `{ok:false, detail}` at 502
     * — with the deliberate 404 returned from INSIDE the try, so a race
     * between validating the id and the tab closing out from under it (at
     * the desk, or from another browser) can never be relabelled a server
     * failure by the catch.
     *
     * The success response reports what was closed — the tab's own label
     * and how many panes it held — both already known from the same tree
     * read used to validate the id, rather than inventing a second herdr
     * call to enrich the answer. That lets the screen say what happened
     * instead of refetching and hoping the operator notices something
     * vanished.
     */
    app.post("/api/tabs/:id/close", async (c) => {
      if (!deps.readTree) return c.json({ ok: false, detail: "herdr is not connected" }, 404);
      const id = c.req.param("id");

      try {
        const tree = await deps.readTree();
        const tab = findTab(tree, id);
        if (!tab) return c.json({ ok: false, detail: "unknown tab" }, 404);
        await actions.closeTab(id);
        return c.json({ ok: true, tabId: id, label: tab.label, paneCount: tab.panes.length });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        warn(`tabs: could not close \`${id}\`: ${detail}`);
        return c.json({ ok: false, detail }, 502);
      }
    });

    /**
     * Close a space and everything inside it — every tab, every pane, every
     * agent any of them held. Same shape as `/api/tabs/:id/close` above, and
     * the response reuses `Space`'s own `tabCount`/`paneCount` for the same
     * reason: it is already known from the tree read that validated the id,
     * so no second herdr call is needed to describe what disappeared.
     *
     * One thing this route deliberately does NOT do: refuse when the tree
     * shows exactly one space. Whether herdr permits closing the LAST
     * remaining space is UNMEASURED (design doc §17 probe 3) — establishing
     * that condition means reducing a working herd to one space, and the
     * only herd available to measure against is the operator's own live
     * session. So paddock relays herdr's answer verbatim through the same
     * catch every other action route uses, rather than guessing herdr's
     * policy and enforcing the guess itself. If herdr allows the close, the
     * operator gets what they asked for; if herdr refuses, this is the path
     * by which that refusal — and herdr's own reason for it — reaches the
     * operator as a 502 `detail`, exactly like any other herdr failure.
     */
    app.post("/api/spaces/:id/close", async (c) => {
      if (!deps.readTree) return c.json({ ok: false, detail: "herdr is not connected" }, 404);
      const id = c.req.param("id");

      try {
        const tree = await deps.readTree();
        const space = findSpace(tree, id);
        if (!space) return c.json({ ok: false, detail: "unknown space" }, 404);
        await actions.closeSpace(id);
        return c.json({
          ok: true, spaceId: id, label: space.label,
          tabCount: space.tabCount, paneCount: space.paneCount,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        warn(`spaces: could not close \`${id}\`: ${detail}`);
        return c.json({ ok: false, detail }, 502);
      }
    });

    /**
     * Create a space (herdr's workspace). Body: `{label?, cwd?}`.
     *
     * The only create route with no `:id` to validate against the tree —
     * there is nothing existing to check — but `deps.readTree`'s ABSENCE
     * still 404s honestly, same capability gate every action route uses:
     * a paddock with no session tree (`--demo`) cannot create anything in
     * one either.
     *
     * `workspace.create`'s own envelope carries the new space's id AND its
     * first tab AND its first pane — `actions.createSpace` reads all three
     * straight off it. No `deps.readTree()` call happens here at all, which
     * is what keeps the whole create path's snapshot-read count at zero for
     * this route: §9.1's correction removed a re-read that was never
     * needed, and the surest way to keep it removed is a route that has no
     * tree read to begin with.
     */
    app.post("/api/spaces", async (c) => {
      if (!deps.readTree) return c.json({ ok: false, detail: "herdr is not connected" }, 404);

      const { label, cwd, err } = normalizeCreateBody(await jsonBody(c), deps.home);
      if (err) return c.json({ ok: false, detail: err }, 400);

      try {
        const created = await actions.createSpace({ label, cwd });
        return c.json({ ok: true, ...created });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        warn(`spaces: could not create a space: ${detail}`);
        return c.json({ ok: false, detail }, 502);
      }
    });

    /**
     * Create a tab in an existing space. Body: `{label?, cwd?}`. Same shape
     * as `/api/tabs/:id/close` etc.: 404 when `deps.readTree` is absent,
     * 404 for an unknown space id, and the deliberate outcomes `return`ed
     * from INSIDE the `try` so the `catch` cannot relabel a client error as
     * a 502.
     *
     * The single `await deps.readTree()` below is the ONLY snapshot read
     * this route makes, and it exists to validate the space id — never to
     * find the new tab or pane afterward. `tab.create`'s own envelope
     * carries `root_pane` alongside `tab` (§9.1's correction, measured in
     * `docs/probes/2026-08-25-structural-events.md`), so the new pane's id
     * is read straight off that response.
     */
    app.post("/api/spaces/:id/tabs", async (c) => {
      if (!deps.readTree) return c.json({ ok: false, detail: "herdr is not connected" }, 404);
      const id = c.req.param("id");

      const { label, cwd, err } = normalizeCreateBody(await jsonBody(c), deps.home);
      if (err) return c.json({ ok: false, detail: err }, 400);

      try {
        const tree = await deps.readTree();
        const space = findSpace(tree, id);
        if (!space) return c.json({ ok: false, detail: "unknown space" }, 404);
        const created = await actions.createTab(id, { label, cwd });
        return c.json({ ok: true, ...created });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        warn(`spaces: could not create a tab in \`${id}\`: ${detail}`);
        return c.json({ ok: false, detail }, 502);
      }
    });

    /**
     * Start a coding agent in an existing pane. Body: `{kind, name, args?}`.
     *
     * `kind` is checked against `actions.harnessKinds()` — the harnesses
     * THIS machine actually has installed (`server.agent_manifests`) — and
     * refused with 400 BEFORE `agent.start` is ever called when it is not
     * on that list. The allowlist is never hardcoded (§9.3):
     * `AgentStartParams.kind` is a plain string in protocol 20, not an
     * enum, so the only defensible allowlist is what is measured installed.
     *
     * `name` is REQUIRED — an absent, empty, or whitespace-only value is
     * refused with 400 before `agent.start` is ever called, the same shape
     * the rename routes use for a label. `agent.start`'s own `name` field
     * carries no `?` in the measured schema
     * (`docs/design/2026-08-19-notifications-and-settings-design.md` §10),
     * and whether herdr accepts `null` for it was never measured — this
     * route is not authorised to spawn a live agent to find out — so there
     * is no fallback here to guess one. An earlier version defaulted an
     * absent name to `kind`, which would have made every agent spawned
     * from the UI come out `claude`, then `claude 2`, then `claude 3`: the
     * create sheet (Task 8) pre-fills this field from the space's own
     * label instead — herdr's own convention when a human starts an agent
     * (§14.7) — so the common case stays one tap and the unmeasured
     * `null` question stays unasked.
     *
     * A herdr failure inside `agent.start` gets its OWN inner `catch`,
     * distinct from the outer one: by the time that call runs, the pane
     * already exists (found on the tree read just above) and already held
     * a plain shell before this request arrived. A failed start is
     * therefore neither success nor nothing — the operator is not left
     * wondering whether the pane they were looking at vanished — so the
     * `detail` says which half landed, the same distinction
     * `/api/panes/:id/text` draws with "typed, but not run".
     */
    app.post("/api/panes/:id/agent", async (c) => {
      if (!deps.readTree) return c.json({ ok: false, detail: "herdr is not connected" }, 404);
      const id = c.req.param("id");

      const body = await jsonBody(c);
      const kind = body.kind;
      if (typeof kind !== "string" || kind.trim() === "") {
        return c.json({ ok: false, detail: "kind must be a non-empty string" }, 400);
      }
      const rawName = body.name;
      if (typeof rawName !== "string" || rawName.trim() === "") {
        return c.json({ ok: false, detail: "name must be a non-empty string" }, 400);
      }
      if (rawName.length > MAX_LABEL_LEN) {
        return c.json({ ok: false, detail: "name must be within the length limit" }, 400);
      }
      const name = rawName;

      const rawArgs = body.args;
      if (
        rawArgs !== undefined
        && !(Array.isArray(rawArgs) && rawArgs.every((a) => typeof a === "string"))
      ) {
        return c.json({ ok: false, detail: "args must be an array of strings" }, 400);
      }
      const args = Array.isArray(rawArgs) ? (rawArgs as string[]) : undefined;
      // Bounded by paddock's policy, like every other client value that
      // reaches a herdr parameter — see `MAX_ARGS`. Both refusals are here,
      // before the tree read, so neither can be confused with a 502.
      if (args !== undefined && args.length > MAX_ARGS) {
        return c.json({ ok: false, detail: `too many args — at most ${MAX_ARGS}` }, 400);
      }
      if (args !== undefined && args.reduce((n, a) => n + a.length, 0) > MAX_TEXT_LEN) {
        return c.json({ ok: false, detail: "args must be within the length limit" }, 400);
      }

      try {
        const tree = await deps.readTree();
        const pane = findPane(tree, id);
        if (!pane) return c.json({ ok: false, detail: "unknown pane" }, 404);
        // The same 409 `/api/panes/:id/output`, `/text` and `/key` give, for
        // the same reason and in the same words. This route used to validate
        // the pane's existence and then start an agent regardless, which made
        // a spawn into an occupied pane `agent.start`'s problem — and what
        // herdr does with that is unmeasured. A fourth pane route answering a
        // fourth way to the same question is the defect; the three siblings
        // already settled the answer.
        if (pane.harness !== null) {
          return c.json({ ok: false, detail: "this pane has an agent; use /api/agents/:id/… to drive it" }, 409);
        }

        const kinds = await actions.harnessKinds();
        if (!kinds.includes(kind)) {
          return c.json({ ok: false, detail: `unsupported kind: ${kind}` }, 400);
        }

        try {
          await actions.startAgent(id, kind, name, args);
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          warn(`panes: agent did not start in \`${id}\`: ${detail}`);
          return c.json(
            { ok: false, detail: `shell exists, but the agent did not start: ${detail}`, paneId: id },
            502,
          );
        }
        return c.json({ ok: true, paneId: id });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        warn(`panes: could not start an agent in \`${id}\`: ${detail}`);
        return c.json({ ok: false, detail }, 502);
      }
    });

    /**
     * The harness kinds THIS machine has installed — `server.agent_manifests`,
     * for the create sheet's picker. A GET is right here: no parameters at
     * all, so nothing lands in a query string (unlike every other write
     * route in this file, this one reads nothing client-supplied).
     */
    app.get("/api/harnesses", async (c) => {
      try {
        const kinds = await actions.harnessKinds();
        return c.json({ ok: true, kinds });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        warn(`harnesses: could not read installed kinds: ${detail}`);
        return c.json({ ok: false, detail }, 502);
      }
    });

    app.post("/api/agents/:id/answer", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);

      // THE scope boundary. agent.prompt accepts arbitrary text, so "only a
      // blocked agent may be answered" is enforced here against the store, not
      // trusted to the UI. If someone answered at the desk first, the agent is
      // no longer blocked and this reply must not be typed into whatever is now
      // on screen.
      if (agent.state !== "blocked") {
        return c.json({ ok: false, detail: `agent is ${agent.state}, no longer blocked` }, 409);
      }

      const body = await jsonBody(c);

      // Checked BEFORE the "did you send anything at all" branch, so a
      // non-string key (a JSON number `2` passes a plain truthiness test and
      // reaches herdr as a non-string) is refused with the reason rather than
      // silently falling through to the free-text path or to `agent.send_keys`.
      const supplied = body.key !== undefined && body.key !== null && body.key !== "";
      if (supplied && (typeof body.key !== "string" || !OPTION_KEY_RE.test(body.key))) {
        return c.json({ ok: false, detail: `key must be an option digit, e.g. "2"` }, 400);
      }
      const key = supplied ? (body.key as string) : null;
      // Same treatment for text: `agent.prompt` takes a string, and a JSON
      // number or object would be forwarded into its params otherwise.
      const text = typeof body.text === "string" && body.text !== "" ? body.text : null;
      if (!key && !text) {
        return c.json({ ok: false, detail: "provide key or text" }, 400);
      }

      try {
        if (key) await actions.sendOptionKey(agent.agentId, key);
        else await actions.sendReply(agent.agentId, text!);
        await actions.waitUntilUnblocked(agent.agentId);
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ ok: false, detail: detailOf(err) }, 502);
      }
    });
  }

  if (deps.settings) {
    const settings = deps.settings;
    const sendTest = deps.sendTest ?? sendTelegram;

    // The single most important property of this route: settings.current()
    // holds the raw token and must never reach c.json(...), on any path —
    // only settings.view() is a valid response body, here or in any other
    // handler in this block.
    app.get("/api/settings", (c) => {
      const url = deps.tunnelUrl?.() ?? null;
      return c.json({
        ...settings.view(now(), pushView(deps.push)),
        tunnel: url !== null && pairing ? { url, pairedDevices: pairing.pairedCount } : null,
      });
    });

    /**
     * Validated at the door, not at send time. A malformed subscription stored
     * now fails hours later when a notification is due and the operator is
     * nowhere near the terminal — so `endpoint` must be https and the keys must
     * be the sizes the crypto requires.
     */
    app.post("/api/push/subscribe", async (c) => {
      const push = deps.push;
      if (push === undefined) return c.json({ ok: false, detail: "push is not configured" }, 400);
      const parsed = await strictJsonBody(c);
      if (!parsed.ok) return c.json({ ok: false, detail: parsed.detail }, 400);
      const { endpoint, keys } = parsed.body as {
        endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown };
      };
      if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
        return c.json({ ok: false, detail: "endpoint must be an https URL" }, 400);
      }
      const p256dh = keys?.p256dh;
      const auth = keys?.auth;
      if (typeof p256dh !== "string" || byteLen(p256dh) !== 65) {
        return c.json({ ok: false, detail: "keys.p256dh must be a 65-byte P-256 point" }, 400);
      }
      if (typeof auth !== "string" || byteLen(auth) !== 16) {
        return c.json({ ok: false, detail: "keys.auth must be 16 bytes" }, 400);
      }
      await push.add({ endpoint, p256dh, auth });
      return c.json({ ok: true });
    });

    app.post("/api/push/unsubscribe", async (c) => {
      const push = deps.push;
      if (push === undefined) return c.json({ ok: false, detail: "push is not configured" }, 400);
      const parsed = await strictJsonBody(c);
      if (!parsed.ok) return c.json({ ok: false, detail: parsed.detail }, 400);
      const { endpoint } = parsed.body as { endpoint?: unknown };
      if (typeof endpoint !== "string") {
        return c.json({ ok: false, detail: "endpoint must be a string" }, 400);
      }
      // Removing something absent is not an error: a browser that lost its
      // subscription still deserves a clean "you are unsubscribed".
      await push.remove(endpoint);
      return c.json({ ok: true });
    });

    /**
     * PUT, never GET: a payload in a query string lands in edge access logs.
     *
     * And PUT, never POST — do NOT "simplify" the verb. paddock has no
     * authentication of its own; a Cloudflare Access policy in front is the
     * only gate, and a browser that already holds an Access session will
     * attach it to a cross-origin request just as readily as to a first-party
     * one. What actually stops a drive-by site writing this route is CORS
     * preflight: `PUT` is not a CORS-simple method, so the browser sends an
     * `OPTIONS` preflight first, and nothing here answers it. The same
     * handler mounted on `POST` would be reachable cross-origin from a plain
     * form submit with `enctype="text/plain"` — no preflight, no same-origin
     * check — were the content type not also required (`strictJsonBody`), and
     * that requirement is what the sibling POST routes have to lean on
     * instead. Here the verb is the CSRF control, and it is the stronger of
     * the two: it holds whether or not a future handler remembers to call the
     * helper. Do not trade it for the helper's check.
     */
    app.put("/api/settings", async (c) => {
      const parsed = await strictJsonBody(c);
      if (!parsed.ok) return c.json({ ok: false, detail: parsed.detail }, 400);

      const validated = validateSettingsPatch(parsed.body);
      if (!validated.ok) return c.json({ ok: false, detail: validated.detail }, 400);

      try {
        await settings.patch(validated.patch);
      } catch (e) {
        // Reporting a save that did not happen is worse than reporting none.
        return c.json({ ok: false, detail: (e as Error).message }, 500);
      }
      return c.json(settings.view(now()));
    });

    /**
     * Mute is its own route, not a `notify` patch field, for two reasons.
     * The server stamps the instant from a client-supplied DURATION, so a
     * phone with a skewed clock cannot set a wrong one. And mute must apply
     * immediately while every other field waits for Save — a separate
     * endpoint makes that structural instead of a rule to remember.
     *
     * POST, not PUT, so it does not inherit the sibling route's
     * not-CORS-simple verb; `strictJsonBody`'s content-type requirement is
     * what restores the preflight here. See docs/decisions.md.
     */
    app.post("/api/settings/mute", async (c) => {
      const parsed = await strictJsonBody(c);
      if (!parsed.ok) return c.json({ ok: false, detail: parsed.detail }, 400);
      const forMs = parsed.body.forMs;
      if (typeof forMs !== "number" || !Number.isFinite(forMs) || forMs < 0 || forMs > MAX_MUTE_MS) {
        return c.json({ ok: false, detail: `forMs must be a number between 0 and ${MAX_MUTE_MS}` }, 400);
      }
      const stamp = now();
      try {
        // 0 means unmute. `notify.enabled` is the "off until further notice"
        // control, so there is deliberately no infinite mute here.
        await settings.patchMute(forMs === 0 ? null : stamp + forMs);
      } catch (e) {
        // Reporting a mute that did not happen is worse than reporting none.
        return c.json({ ok: false, detail: (e as Error).message }, 500);
      }
      return c.json(settings.view(stamp));
    });

    app.post("/api/settings/telegram/test", async (c) => {
      const parsed = await strictJsonBody(c);
      if (!parsed.ok) return c.json({ ok: false, detail: parsed.detail }, 400);
      const body = parsed.body;

      // Resolved PER FIELD: an absent or blank value falls back to the stored
      // one via the same `isConfigured` predicate the view and the notifier
      // use. This is what lets an operator verify a pasted token before
      // committing it — the only order anyone actually tries.
      const s = settings.current();
      const pick = (typed: unknown, stored: string | null): string | null => {
        if (typeof typed === "string" && isConfigured(typed)) return typed;
        return isConfigured(stored) ? stored : null;
      };
      const token = pick(body.token, s.telegram.token);
      const chatId = pick(body.chatId, s.telegram.chatId);

      if (token === null || chatId === null) {
        return c.json({ ok: false, detail: "token and chat id must both be set" }, 400);
      }
      // Checked before the request, so a path-unsafe token never reaches a
      // URL. The detail names the rule and never echoes the value.
      if (!isTokenShape(token)) {
        return c.json({ ok: false, detail: TOKEN_SHAPE_DETAIL }, 400);
      }

      // Deliberately does NOT save. A probe is not a commit.
      // `sendTest` is `deps.sendTest ?? sendTelegram`, resolved once above —
      // do not re-resolve it here.
      const r = await sendTest({
        token, chatId,
        text: "paddock test message — notifications are wired up.",
      });
      return c.json(r);
    });
  }

  // API 404s must stay JSON, so this guard comes before the SPA fallback.
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // Embedded assets first, disk second. The binary must be the whole product,
  // and so must the Docker image — its build stage generates the manifest too,
  // so in the container this branch answers and `staticDir` is never reached.
  // `staticDir` is for `make dev`, where the UI is served by Vite and rebuilt
  // constantly, and as an escape hatch for pointing a binary at a UI it was
  // not built with. See docs/architecture.md, "Embedded UI, and where
  // `staticDir` fits".
  const serve = async (path: string): Promise<Response | null> => {
    const embedded = EMBEDDED[path];
    if (embedded) return new Response(Bun.file(embedded), { headers: headersFor(path) });
    if (!deps.staticDir) return null;
    const candidate = Bun.file(`${deps.staticDir}${path}`);
    return (await candidate.exists())
      ? new Response(candidate, { headers: headersFor(path) })
      : null;
  };

  app.get("/*", async (c) => {
    const path = new URL(c.req.url).pathname;
    if (path !== "/") {
      const hit = await serve(path);
      if (hit) return hit;
    }
    const index = await serve("/index.html");
    if (!index) return c.text("UI not built — run `make build`", 404);
    return index;
  });

  return app;
}

function headersFor(path: string): Record<string, string> {
  // Content-hashed assets are safe to cache forever. Everything else —
  // `sw.js`, the manifest, icons — carries no hash, so a long-lived entry for
  // it would pin a stale copy under a name that never changes.
  const immutable = IMMUTABLE_ASSET_RE.test(path);
  if (immutable) {
    return { "cache-control": "public, max-age=31536000, immutable" };
  }
  // `no-cache` means "revalidate before use", NOT "do not store". It is
  // the other half of the immutable-asset trade above: hashed bundles may
  // be kept for a year precisely BECAUSE the document naming them is
  // rechecked on every load.
  //
  // This header was absent, which is not the same as neutral — with no
  // Cache-Control, no ETag and no Last-Modified, browsers fall back to
  // heuristic caching and mobile ones are aggressive about it. A phone
  // that kept an old index.html also kept the old bundle it referenced,
  // pinned `immutable` for a year, so no future deploy could ever reach
  // it. The visible symptom is a UI that fails only where the stale
  // bundle and the current server disagree — which reads as intermittent,
  // not stale.
  return { "cache-control": "no-cache" };
}
