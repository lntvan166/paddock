import { Hono, type Context } from "hono";
import { compress } from "hono/compress";
import { resolveReadLines, type HerdrActions } from "@server/herdr/actions";
import { parsePrompt, selectedLine } from "@server/herdr/prompt-parse";
import { sendTelegram } from "@server/notify/telegram";
import {
  isConfigured,
  isTokenShape,
  MAX_SETTLE_MS,
  MIN_COOLDOWN_MS,
  TOKEN_SHAPE_DETAIL,
  type SettingsStore,
} from "@server/settings/store";
import type { AgentStore } from "@server/state/store";
import type { Hub } from "@server/ws/hub";
import { EMBEDDED } from "@server/embedded";
import { isNavKey, type NotifyTrigger, type SettingsPatch } from "@shared/types";
import { diffScreens, digestOf } from "@shared/screen";

export interface HealthBody {
  ok: boolean;
  hostId: string;
  agents: number;
  clients: number;
  herdrConnected: boolean;
  /**
   * Epoch ms of the last herdr event. Exposed deliberately: a stuck event stream
   * is otherwise invisible, which is how a comparable system dropped every
   * event while reporting success.
   */
  lastEventAt: number | null;
  /**
   * The notifier's last send failure (a bad token, an unreachable API), or
   * `null` if the most recent attempt succeeded or none has been made yet.
   * Required, not optional: a broken token must be visible within seconds via
   * `/api/health`, and an optional field lets a future edit to `health()`
   * silently drop it with nothing — neither the type checker nor a test —
   * to notice.
   */
  lastNotifyError: string | null;
  /**
   * The running build's own version string (see `@server/version`).
   * Required for the same reason as `lastNotifyError`: an operator debugging
   * a report against "whatever paddock happened to be running" should never
   * have to guess it from a binary that may since have been replaced.
   */
  version: string;
  /**
   * The newest version `checkForUpdate` has seen on GitHub, or `null` if none
   * is known yet or none is newer than `version`. Required, not optional —
   * the same reasoning as `lastNotifyError`: a future edit that drops this
   * field from `health()` must be a type error, not a silently missing key.
   */
  latestKnown: string | null;
}

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
 * A request body as an object, whatever the client actually sent.
 *
 * `c.req.json()` rejects on malformed JSON and resolves with `null`, a number
 * or an array for well-formed-but-not-an-object bodies — none of which can be
 * indexed safely. Every field read off the result is `unknown` and validated
 * before use; nothing here is cast into a shape the body may not have.
 */
async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
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

    if ("enabled" in nn) {
      if (typeof nn.enabled !== "boolean") return { ok: false, detail: "notify.enabled must be a boolean" };
      out.enabled = nn.enabled;
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

    patch.notify = out;
  }

  if ("publicUrl" in body) {
    const u = body.publicUrl;
    if (!isNullableString(u)) return { ok: false, detail: "publicUrl must be a string or null" };
    patch.publicUrl = u;
  }

  return { ok: true, patch };
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

  // No authentication middleware. Cloudflare Access is the only gate — see
  // docs/decisions.md before adding one.
  app.get("/api/health", (c) => c.json(deps.health()));

  app.get("/api/agents", (c) =>
    c.json({ hostId: deps.store.hostId, agents: deps.store.snapshot() }),
  );

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
        return c.json({ ok: false, detail: String(err) }, 502);
      }
    });

    app.post("/api/agents/:id/prompt", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
      try {
        return c.json(parsePrompt(await actions.readDetection(agent.agentId)));
      } catch (err) {
        return c.json({ ok: false, detail: String(err) }, 502);
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
        return c.json({ ok: true, ...out, selected: selectedLine(out.lines.join("\n")) });
      } catch (err) {
        return c.json({ ok: false, detail: String(err), lines: [], source: "" }, 502);
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
        return c.json({ ok: false, detail: String(err), lines: [], source: "" }, 502);
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
        return c.json({ ok: false, detail: String(err) }, 502);
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
    app.get("/api/settings", (c) => c.json(settings.view(now())));

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
