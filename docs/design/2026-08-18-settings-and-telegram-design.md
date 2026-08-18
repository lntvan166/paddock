# Settings tab and Telegram notifications — design

**Status:** approved, not yet implemented.
**Supersedes nothing.** Extends `docs/design/2026-08-17-paddock-design.md`.

## Goal

Two capabilities that share one surface:

1. **Telegram notifications** when an agent becomes `blocked` or `done`, so the
   operator learns something needs them without opening the dashboard. This is
   the gap the README's opening premise describes and the product does not yet
   close.
2. **A settings view** at `#/settings` holding the Telegram configuration, a
   notification switch, a refresh-rate choice, and display preferences.

Telegram rather than Web Push, decided deliberately: Web Push needs a service
worker, a VAPID keypair, a permission prompt and — on iOS — a Home Screen
install before a single notification can arrive. Telegram needs a bot token and
an HTTPS POST, works on any device already running Telegram, and is unaffected
by an expired Access session (see `docs/gotchas.md`, "Deployment and Access").

The cost of that choice is stated plainly because it is real: **bot messages
are not end-to-end encrypted.** Telegram can read them. Web Push payloads are
encrypted with keys only the browser holds. Agent names and states will
therefore sit on a third party's infrastructure, and the mitigation is content
minimalism — name, state, link, never terminal output.

## Scope

**In:** Telegram token and chat id, notification on/off, which transitions
fire, quiet hours, per-agent cooldown, public URL, refresh-rate preset, theme,
terminal font size, line wrap.

**Out, deliberately:** message templates, multiple chat destinations, editing
the host label (that is `PADDOCK_HOST_ID`, an environment concern), notification
sounds, making `HISTORY_CAP` or the idle-section default configurable. Each was
considered and dropped as YAGNI.

## The distinction that shapes the UI

Settings divide into two kinds, and conflating them is the primary way this
feature misleads its operator:

| Kind | Scope | Stored | Examples |
|---|---|---|---|
| Per-device | This browser only | `localStorage` | Refresh rate, theme, font size, wrap |
| Server-global | The whole paddock process | `settings.json` | Telegram config, notify on/off, triggers, quiet hours, public URL |

Sending happens on the server. A "notifications off" switch therefore silences
every device, not the phone it was tapped on. The view renders these as two
headed sections, and the global section says so in words. A switch whose scope
the operator has to guess is a switch that will be misread.

## Architecture

### Integration point

`server/index.ts` already fans deltas out at the composition root:

```ts
onDelta: (d) => hub.queue(d),
```

becomes

```ts
onDelta: (d) => { hub.queue(d); notifier.observe(d); },
```

Nothing in `state/store.ts`, `supervisor.ts` or `ws/hub.ts` changes.

This placement is load-bearing rather than incidental. The dependency rule is
`herdr/socket → herdr/adapter → state/store → ws/hub → web/`, and the two
placements a developer would reach for first both break it: inside `hub.ts` the
transport layer learns that Telegram exists, and inside `store.ts` the state
layer learns about outbound integrations. Hanging the notifier off the
composition root makes it a leaf that nothing upstream imports, which is the
same shape the rule already protects.

### `observe` must not be awaited

`onDelta` is a synchronous fan-out feeding the WebSocket broadcast. `observe`
therefore returns `void`, dispatches its send without awaiting, and catches its
own failures. An awaited Telegram call would put a third party's latency —
including its timeouts — directly in front of every browser update.

### New modules

```
src/server/settings/store.ts     load, validate, patch, persist
src/server/notify/telegram.ts    transport only: send(token, chatId, text)
src/server/notify/notifier.ts    policy: transitions, triggers, quiet hours, cooldown
src/web/prefs.ts                 per-device preferences, one localStorage owner
src/web/components/Settings.tsx  the view
```

## Data model

Payload types live in `src/shared/types.ts`, which remains the single contract
imported by both sides. Per-device preferences are **not** added there: they
never cross the wire, and putting them in the shared contract would imply they
do.

```ts
export type NotifyTrigger = "blocked" | "done";

/** What GET /api/settings returns. The token is never a member. */
export interface SettingsView {
  telegram: { configured: boolean; hint: string | null; chatId: string | null };
  notify: {
    enabled: boolean;
    triggers: NotifyTrigger[];
    quietHours: { start: string; end: string } | null;  // "22:00" / "08:00", server local
    cooldownMs: number;
  };
  publicUrl: string | null;
  error: string | null;   // a settings file that failed to load
}
```

`PUT /api/settings` accepts a partial patch of the same shape plus a
write-only `telegram.token`.

## Settings store

**Location:** `$PADDOCK_CONFIG_DIR/settings.json`, defaulting to
`~/.config/paddock/settings.json`. File mode `0600`, directory `0700` — the
file holds a bearer credential.

**Atomic write.** Write `settings.json.tmp`, `fsync`, then `rename()`. A crash
partway through a direct overwrite leaves a truncated file, and the value lost
would be the token — the one field the operator cannot regenerate from the UI.

**A malformed file is never silently replaced.** Overwriting it with defaults
would destroy a token to fix a typo. Instead: log at ERROR, run with defaults
in memory, leave `notify.enabled` false, expose the fault as `error` on
`GET /api/settings` and on `/api/health`, and refuse to persist until the
operator saves explicitly — an explicit save is an informed overwrite. This
follows the project's standing rule that an error is surfaced, never swallowed.

**Environment seeds the first run only.** `PADDOCK_TELEGRAM_TOKEN` and
`PADDOCK_TELEGRAM_CHAT_ID` populate the file when it does not yet exist, so a
headless or container deployment never has to open the UI. Once the file
exists it wins; environment variables do not silently override a value the
operator set in the dashboard.

**The token is never logged**, at any level, including on send failure.

## Notifier

State: `Map<agentId, AgentState>` of the last state seen. `Delta` carries only
the new agent, so a transition cannot be derived without it.

Rules, each of which prevents a specific failure:

- **Transition, not state.** An agent already `blocked` emitting further output
  deltas must not notify again. `docs/gotchas.md` records this as observed in a
  comparable system.
- **First sight is not a transition.** The map populates silently on boot.
  Without this, restarting paddock pings the operator once per currently-blocked
  agent — a burst of notifications caused by nothing having happened.
- **Quiet hours drop; they never queue.** A queue delivers a pile at 08:00
  about agents unblocked five hours earlier. That is noise wearing the costume
  of signal, and it teaches the operator to ignore the channel.
- **Quiet hours wrap past midnight**, and that is the ordinary case rather than
  an edge one: `22:00`–`08:00` means `start > end`, so the window is
  `t >= start || t < end`. Read with the naive `start <= t < end`, the most
  common setting an operator will type silences nothing at all. Equal start and
  end means a zero-length window, not a permanent one.
- **An empty `triggers` array sends nothing**, and is a legal state distinct
  from `enabled: false` — the switch stays on while the operator narrows what
  it fires on.
- **Per-agent cooldown**, default 60s. Guards a flapping agent. 60s rather than
  minutes because a genuine `working → blocked → working → blocked` sequence is
  a real event the operator wants both halves of.
- **A failed send does not consume the transition.** `lastSeen` is left
  unchanged so the next delta retries. The cooldown is what stops this becoming
  a hot loop against an unreachable Telegram.

**Message content** is the agent name, the new state, and a deep link built
from `publicUrl` and the agent hash. Never terminal output, and never the task
text, which may carry pasted secrets.

**`agentHash` must move to `src/shared/` first.** It currently lives in
`src/web/route.ts`, and the notifier is server code: the dependency rule runs
`… → ws/hub → web/`, so a server module importing from `web/` reverses it.
Verified as a rule the codebase actually keeps — nothing under `src/server/`
imports `@web/` today. The pure functions `agentHash` and `agentIdFromHash`
therefore move to `src/shared/route.ts`, which both sides may import, and
`src/web/route.ts` keeps the React hook and re-exports them so no call site
changes. Duplicating the `#/agent/<encoded id>` format into the notifier is the
alternative and is rejected: two sources of truth for a URL shape means a
notification link that silently stops matching the app it points at.

Sent as **plain text with no `parse_mode`.** Agent names originate in herdr and
may contain Markdown or HTML metacharacters; with no parse mode there is
nothing to escape and no way for a name to corrupt or inject into the message.

**`publicUrl` is a discovered requirement, not a requested one.** paddock binds
loopback and genuinely cannot know the hostname it is reached by, so without
this setting the message ships with no link. Unset is legal; the message is
then text only.

## Telegram transport

`POST https://api.telegram.org/bot<token>/sendMessage`, JSON body
`{chat_id, text}`. A 10-second `AbortController` timeout — an unbounded fetch
would leak a pending request per delta against a black-holed network.

Telegram signals application errors in a `200` body: `{ok: false, description,
error_code}`. `401` means a bad token, `400` a wrong chat id. The `description`
is surfaced verbatim to the settings view, because "Bad Request: chat not
found" tells the operator exactly what to fix and a generic "send failed" does
not.

Volume is far below Telegram's limits (30 messages/second overall, one per
second per chat); no client-side rate limiter is warranted.

## API

| Route | Behaviour |
|---|---|
| `GET /api/settings` | Returns `SettingsView`. The token is **never** a member; `configured` and a four-character `hint` stand in for it. |
| `PUT /api/settings` | Partial patch. Accepts `telegram.token` write-only. |
| `POST /api/settings/telegram/test` | Sends a real message and returns `{ok}` or the verbatim Telegram description. |

Bodies on POST and PUT, never query strings — a token in a query string lands
in edge access logs, which is precisely the failure `docs/gotchas.md` already
records for payloads.

The token is write-only because paddock has no authentication of its own;
Cloudflare Access is the only gate. Anything `GET /api/settings` returns is
readable by whatever passes that gate, and by any future XSS. A bearer
credential that never travels outward cannot be exfiltrated by either.

## Client

**Routing.** A third view. `route.ts` gains a `#/settings` match beside the
existing agent match, and `App.tsx` renders `Settings` for it. The existing
"malformed hash lands on the list" behaviour is unchanged.

**`src/web/prefs.ts` is the single owner of `localStorage`.** `install.ts:48`
already documents that Safari private mode throws outright on access; that
hazard is handled once, in one module, rather than in each component that
wants a preference. Every key stays namespaced `paddock.*`, and the existing
`paddock.term.wrap` key is reused verbatim so no operator's current setting is
reset by this change.

**Applying each preference:** theme sets `documentElement.dataset.theme` —
`styles.css:42` already defines `:root[data-theme="dark"]` and nothing has ever
driven it. Font size sets a custom property consumed by `.term`. The refresh
preset raises `AgentTerminal`'s interval floor; the existing backoff to
`MAX_REFRESH_MS` is untouched.

**Refresh presets, not a milliseconds field:** Live (250 ms), Balanced (1 s),
Frugal (3 s). A free-numeric input invites a value that hammers herdr, and the
three named points cover the real decision — which is whether the connection is
metered, not which precise interval is optimal.

## Failure modes

| Condition | Behaviour |
|---|---|
| No token configured | Notification switch disabled, labelled "not configured" |
| Telegram unreachable or rejecting | ERROR log without the token, `lastNotifyError` on `/api/health`, shown in the view |
| Settings file unwritable | `PUT` returns 500 with the reason; the view shows it rather than reporting a save that did not happen |
| Settings file malformed | Defaults in memory, notifications off, `error` surfaced, no overwrite until an explicit save |
| `publicUrl` unset | Message sent without a link, not suppressed |

## Testing

- **Settings store:** atomic write survives an interrupted write; mode is
  `0600`; a malformed file does not erase the token; environment seeds only when
  the file is absent.
- **Notifier:** transition detected; repeat delta in the same state does not
  notify; first sight after boot does not notify; cooldown suppresses; quiet
  hours drop rather than defer; a failed send leaves `lastSeen` unchanged so the
  next delta retries.
- **Transport:** URL and body shape; a `{ok:false}` body surfaces its
  description; the timeout fires.
- **View (DOM):** the token is never rendered back from a `GET`; only the hint
  appears.

Every one of these is to be broken deliberately and observed failing before it
is trusted, per the project's standing rule that a test which cannot fail reads
as coverage while providing none.

## Decisions recorded

1. **Telegram over Web Push** — smaller, no iOS install ritual, unaffected by
   Access session expiry. Accepts that Telegram can read message content.
2. **Notifier at the composition root** — the only placement that does not make
   an upstream layer aware of a downstream concern.
3. **Quiet hours drop rather than queue** — a deferred burst describes a world
   that no longer exists.
4. **Token write-only over the API** — Access is the only gate, so anything
   readable is readable by anyone past it.
5. **Config persists, history still does not** — `settings.json` is the first
   durable state paddock has owned. Configuration is not a recording of agent
   activity, so "viewer, not recorder" is unaffected in substance.
