# Notification presence and clearing — design

Two complaints about push, both about the same thing: paddock has no idea
whether anyone is already looking.

1. **It pushes for the agent you are watching.** Open a pane on the phone, the
   agent blocks, and the phone buzzes about the pane already filling the screen.
2. **A handled notification never goes away.** Answer the agent from the herdr
   terminal on the laptop and the phone's lock screen still says it is waiting,
   for the rest of the day.

This design adds a presence signal, uses it to withhold push from the device
that is already showing the agent, and sweeps stale notifications when the app
comes forward. It is a change to `notify/`, one new state module, the first
client-to-server message this WebSocket has ever carried, and one new setting.

`public/sw.js` is **not** touched.

---

## The rules, chosen before the mechanism

Four decisions fix everything that follows. They were taken deliberately, and
each one rejects a cheaper option that looks equivalent and is not.

**1. Suppression is per agent, not per app.** Push for `api-refactor` is
withheld only while a client is foregrounded *on `api-refactor`'s pane*. Being
somewhere else in paddock — the list, Settings, another agent — suppresses
nothing. The cheaper rule ("quiet while paddock is open") loses an alert for
`schema-migration` because you happened to be reading `docs-cleanup`, which is
the opposite of what the feature is for.

**2. Suppression is per device.** If the phone is on the pane and a tablet is
not, the tablet is still told. This costs a device identity on the wire and a
lookup against the subscription store; the alternative is a global rule that is
right for one device and wrong for two.

**3. Withholding defers, it never drops.** Look at an agent as it blocks, then
pocket the phone without answering, and something must still tell you. So a
fully withheld notification is *held*, not discarded, and fires when the last
viewer leaves while the agent is still blocked. This mirrors the rule
`cooldownMs` already follows in `#fire`, and for the same reason: dropping
loses a real event to protect against a duplicate one.

**4. Presence governs push only, never Telegram.** A device key identifies one
browser. A Telegram chat can be read from a laptop, a desktop, or a second
phone, so presence can make no claim about whether its reader is looking at
anything. Suppressing Telegram on a phone's presence would silence the
transport that exists precisely because it works where the PWA does not.

---

## What was rejected, and why it will look attractive again

**herdr's `focused` flag.** `agent.list` already returns `focused` per pane, and
it is tempting: it needs no new channel, no new state, and it appears to answer
the laptop half of the complaint for free. It does not. `focused` means "the
selected pane in its tab" — it survives a closed lid, a locked screen, and a
terminal buried four windows deep. The pane you left running while you walked
away is *exactly* the pane herdr still reports focused, so suppressing on it
silences the one agent you most need to hear about. This is recorded in
`docs/gotchas.md` because it is the first thing anyone revisiting this will
reach for.

**Deciding it in the service worker.** `sw.js` could call `clients.matchAll()`
on receipt, find a visible client already on that pane, and show nothing. No
wire change, no shared contract, no server state — roughly a fifth of the work,
and per-device correctness falls out for free because each device judges for
itself. It was rejected on two counts. Nothing is left holding the episode, so
it cannot fire when you walk away — it silently becomes rule 3's rejected
"drop" variant. And every suppression becomes a push that displays nothing,
which is the behaviour WebKit counts against a subscription and can revoke it
for. A feature that spends the push subscription to save a buzz is a bad trade.

**A silent clearing push.** Same WebKit objection, arrived at from the other
direction: pushing on `blocked → working` with a flag telling `sw.js` to close
the tag and render nothing would clear the lock screen without touching the
phone, which is the ideal behaviour and the reason it keeps getting proposed.
Not as the primary mechanism, on the same budget grounds. A *visible* resolution
push ("`api-refactor` is working again") is WebKit-safe but costs a second buzz
per resolution — the opposite of the request.

**Presence over an HTTP heartbeat.** Same presence module, same notifier logic,
but the client POSTs `/api/presence` every 30s instead of using the socket.
Leaves the read-only WebSocket contract intact, which is worth something. It
loses on the behaviour that matters: closing a tab releases nothing promptly
because there is no close event to hang the release on, so suppression outlives
your departure by up to a heartbeat, and it costs a phone radio one POST every
30s for a fact the socket already had a place to carry.

---

## Presence

### `src/server/state/presence.ts`

```ts
interface Entry { deviceKey: string | null; agentId: string | null; at: number }

class PresenceStore {
  set(client: object, e: { deviceKey: string | null; agentId: string | null }): void
  drop(client: object): void
  viewers(agentId: string): Set<string>          // device keys, stale entries excluded
  onChange(cb: (agentId: string) => void): void  // a viewer set may have shrunk
  dispose(): void
}
```

It lives in `state/` because it is upstream of both the things that use it:
`ws/serve.ts` writes it and the notifier reads it, and neither may import the
other. `hub.ts` does not touch it — the hub broadcasts and knows nothing else,
which is the property `docs/architecture.md` protects.

### Keyed by the connection, not by the device

A Safari tab and the installed PWA on one phone share a `deviceKey` and have
separate sockets and separate location hashes. Keyed by `deviceKey`, whichever
of the two last spoke would overwrite the other: the tab sitting on the agent
list would erase the PWA's "viewing `api-refactor`" and the suppression would
flicker on which surface moved most recently.

So each connection holds its own entry and `viewers()` unions them. A device is
viewing an agent if **any** of its connections is.

### The keep-alive is the heartbeat's reply

Entries carry `at`. `viewers()` ignores anything older than 60s, and a sweep
timer the store owns — unref'd, like every other timer paddock arms — drops
expired entries and emits `onChange` for each. Expiry is therefore an event like
any other, and nothing has to poll for it.

The client refreshes by re-sending its `viewing` frame once per heartbeat it
receives. The hub already sends one every 20s, so the reply *is* the liveness
proof and no new timer exists on either side. 60s is three missed heartbeats.

This gives release three layers, cheapest first:

1. an explicit `agentId: null` when the page goes hidden or the hash changes,
2. the socket's `close` handler, which already exists and already runs,
3. the TTL, for the mobile socket that dies without either.

Layer 3 is load-bearing, not belt-and-braces. iOS suspending a backgrounded PWA
without delivering `visibilitychange` first is the normal case.

### `deviceKey`

`base64url(SHA-256(endpoint))`, computed in the browser and cached by a small
`src/web/device-key.ts` so `store.ts` can await it without learning anything
about push. `PushSection.tsx` already holds the subscription; the hash is taken
from the same `getSubscription()` result.

A hash rather than the endpoint itself. An endpoint is a bearer credential for
pushing to that device: it is already stored once, in `push.json`, and there is
no reason to put it on a second wire or to create a second thing that must never
reach a log line. `index-wiring.ts` already refuses to log an endpoint for this
reason and logs only its origin.

`crypto.subtle` requires a secure context, which the service worker already
requires, so this adds no constraint that push did not already impose.

**Amended from the plan as written: the hash is persisted, not computed per
notification.** `StoredSubscription.deviceKey` is stamped by `push/store.ts`
at subscribe time (`add`) and backfilled on load for a `push.json` written
before the field existed, rather than hashed from `push.list()` at the
composition root on every send as first specified. `deviceKeys()` is
therefore a synchronous `Set` read, no different in shape from `list()`.

The reason is `#fire`, not a preference: the notifier needs the device roster
*before* it decides whether to stamp `#lastSentAt`, and that stamp has to
happen in the same tick as reading `since` — the comment on `#fire` already
explains why an attempt, not just a success, consumes the cooldown. Hashing
per send would put an `await hashEndpoint(...)` between that read and that
write, an interleaving window `#fire` does not have today and that a roster
getter has no business introducing. A synchronous `pushDeviceKeys()` closes
over `push.deviceKeys()` and keeps the ordering exactly what it was before
presence existed. No subscription still means no key in the roster —
presence is still recorded, it matches no target, and it suppresses nothing.

`paddock tunnel` unattached is a whole second paddock with its own notifier, so
it gets presence from the same `index.ts` wiring; `run.ts` only has to pass the
store into `hubWebSocket`. Attached (`upstream`) it has no hub, store or
notifier at all and therefore no presence either — the process it proxies to
owns all of it, which is the property that keeps an attached tunnel from
notifying twice.

### The first message this socket has ever accepted

`src/shared/types.ts` gains its first `ClientMessage`:

```ts
export type ClientMessage =
  | { type: "viewing"; deviceKey: string | null; agentId: string | null };
```

`serve.ts`'s `message()` no-op gets its v2 job. Its comment requires that any
such change be unable to land on one listener only; both listeners already go
through the `hubWebSocket()` factory, so that holds by construction rather than
by discipline.

This is untrusted input, and the first of it here, so:

- a frame that is not JSON, or is JSON of the wrong shape, is ignored — never
  thrown from, because throwing in a Bun `message` handler drops the socket and
  a malformed frame would then be a way to disconnect a dashboard;
- an unknown `type` is ignored, so a newer client talking to an older server
  degrades to no presence rather than to a broken socket;
- frames over a small cap (1 KB) and non-string ids are refused;
- one entry per connection, so nothing here can grow a map without bound.

The `agentId` is only ever compared against ids the store already holds and used
as a `Map` key. It never reaches herdr, so there is no injection surface behind
it — worth stating because "an id from the browser" would otherwise have to be
re-audited by whoever reads this next.

No user-agent parsing, no `isMobile`: presence is `document.visibilityState`
plus the hash, which is capability and state, exactly as the UI rules require.

---

## The notifier

`NotifierOpts` gains two getters, read at send time like `publicUrlOverride`
and for the same reason — a device can subscribe or a viewer can arrive between
two notifications:

```ts
viewers?: (agentId: string) => Set<string>   // device keys on that pane now
pushDeviceKeys?: () => Set<string>           // the subscribed roster now
```

`sendPush`'s payload gains `skipDeviceKeys`. `buildPushSender` in
`index-wiring.ts` hashes each target's endpoint and skips the matches. That is
its only change, and it stays transport-only: the decision is made above it,
where `notifier.ts` says every policy decision lives.

### Why the roster getter exists

`#fire` stamps `#lastSentAt` per *attempt*, not per success, and its comment
explains why: a broken token fails every send, and stamping only successes
leaves `since` permanently infinite, which turns the retry path into one POST
per delta.

That reasoning is about a send that was *made and failed*. A withheld push makes
no request at all — there is nothing to rate-limit, and consuming the cooldown
would delay the deferred re-fire by up to `cooldownMs` for no reason anyone
could name.

So the notifier decides before it stamps:

```
skip     = skipWhileViewing ? viewers(agentId) : ∅
roster   = pushDeviceKeys()
withheld = roster.size > 0 && every key in roster is in skip

if (withheld && !telegramReady) { defer(); return }   // nothing sent, nothing spent
```

`roster.size > 0` guards the case where nothing is subscribed. No devices is not
suppression, and deferring would wait for a departure that can never happen.

**Partial suppression sends.** One device on the pane and another not means the
other is told and the episode counts as announced — you were informed, on a
device that was not already showing you.

### Deferral

```ts
#deferred = new Map<string, { agent: Agent; state: NotifyTrigger; episode: number; attempts: number }>()
```

The agent snapshot rather than the id, matching what the existing retry path
already closes over — a rename between deferral and fire shows the old name,
which is already true of a retry and not worth a second mechanism to fix.

Cleared in `#see` on any genuine transition, because that ends the episode the
entry describes, and in `#forget`, because a departed pane has nothing pending.
`dispose()` clears it too.

`reconsider(agentId)` is new and public, called from `presence.onChange`. It
re-arms at zero delay and asserts nothing itself: `#fire` re-reads triggers,
mute, presence and cooldown, so `reconsider` only says "look again". Entries
whose `#lastSeen` has moved on, or whose `#episode` is no longer current, are
dropped rather than armed.

`#episode` is what makes this safe. A deferral belonging to a `blocked` episode
you have since left and re-entered cannot fire against the current one — the
same property that already stops a late Telegram success from resurrecting a
suppression, reused rather than re-invented.

### Mute wins, and drops

A deferred episode that meets an active mute in `#fire` is discarded, not
re-deferred. `mutedUntil` is documented as dropping rather than queuing —
"a pile delivered when mute lifts describes agents unblocked hours earlier" —
and a deferral that survived mute would be exactly that pile, arriving one entry
at a time.

---

## Clearing

`src/web/notifications.ts`:

```ts
closeFor(agentId: string): Promise<void>   // you just opened this pane
sweep(agents: Agent[]): Promise<void>      // close any tag no longer blocked or done
```

`sw.js` already tags every notification with the agent id, which is all the
sweep needs — so the service worker is untouched, the no-`fetch`-handler
assertion in `tests/sw.test.ts` stays true, and decision 23 stays unamended.

Both functions feature-detect `navigator.serviceWorker` and
`registration.getNotifications` and return silently when either is absent. This
is capability detection, not a swallowed error: the API genuinely does not exist
in some browsers paddock is opened in, and there is no failure to report. An
actual rejection from `getNotifications` is logged, not hidden.

`useNotificationSweep(agents)` runs it on `visibilitychange → visible`, on
entering a pane route, and whenever the agent list changes. The third trigger is
not redundant: if you are already in the app when an agent finishes, its stale
alert should clear without needing a background-and-return cycle.

**What this cannot do**, accepted deliberately: if you never pick the phone up,
the notification stays until you do. Clearing it without the phone being touched
requires a push that renders nothing, which is the trade the rejected options
section refuses.

---

## Settings

`notify.skipWhileViewing: boolean`, default `true`. Four touch points, the same
four every other notify field has:

- the type in `src/shared/types.ts`;
- the default and the normalizer in `settings/store.ts` — a non-boolean on disk
  falls back to the default with a warning, as `triggers` and `settleMs` already
  do, rather than throwing on a hand-edited file;
- the PUT validator in `routes.ts`, refusing a non-boolean explicitly rather
  than ignoring it;
- a `Checkbox` in `NotifySection.tsx`, matching the trigger checkboxes
  already in that card rather than introducing a second control idiom for one
  boolean.

The copy names the deferral, because a feature that withholds a buzz reads as a
broken feature unless the UI says otherwise:

> **Skip push for the agent I'm watching** — while a device has this agent's
> pane open, push to that device waits until you leave it. Other devices and
> Telegram are unaffected.

Off restores today's behaviour exactly: `skip` is empty, `withheld` is false,
and every path below it is the one that ships now.

---

## Files

**New**

| File | Purpose |
| --- | --- |
| `src/server/state/presence.ts` | Connection-keyed presence, TTL sweep, `onChange` |
| `src/web/device-key.ts` | `SHA-256` of this device's endpoint, cached |
| `src/web/notifications.ts` | `closeFor`, `sweep`, capability-guarded |

**Changed**

| File | Change |
| --- | --- |
| `src/shared/types.ts` | `ClientMessage`; `notify.skipWhileViewing` |
| `src/server/ws/serve.ts` | `message()` parses and validates `viewing`; `close` drops presence |
| `src/server/notify/notifier.ts` | `viewers`/`pushDeviceKeys`, withhold-before-stamp, `#deferred`, `reconsider` |
| `src/server/index-wiring.ts` | `buildPushSender` skips matching device keys |
| `src/server/index.ts` | Construct `PresenceStore`, hash the roster, wire `onChange` → `reconsider`, dispose |
| `src/server/tunnel/run.ts` | `presence` added to the `hubWebSocket` deps |
| `src/server/settings/store.ts` | Default and normalizer for the new field |
| `src/server/routes.ts` | PUT validator for the new field |
| `src/web/store.ts` | Send `viewing` on open, hash change, visibility change, heartbeat |
| `src/web/components/settings/NotifySection.tsx` | The checkbox and its copy |
| `src/web/components/App.tsx` | `useNotificationSweep(agents)` |

---

## Tests

Fixtures use invented agent names (`api-refactor`, `flaky-test-fix`,
`docs-cleanup`, `schema-migration`), per `CLAUDE.md`.

**`tests/presence.test.ts`** — two connections on one device union rather than
overwrite; an entry past the TTL is excluded from `viewers()`; the sweep emits
`onChange` when it drops one; `close` drops immediately; `dispose()` clears the
timer.

**`tests/notifier-presence.test.ts`** — the important one:

- viewing the pane withholds the push, and nothing is sent;
- the withheld episode fires when the last viewer leaves;
- a withheld send does **not** consume the cooldown;
- partial suppression sends to the other device and marks the episode announced;
- `blocked → working → blocked` across a deferral fires once, not twice;
- an expired presence entry releases the deferral without a client message;
- mute discards a deferral rather than queuing it;
- Telegram still sends while push is withheld;
- `skipWhileViewing: false` reproduces current behaviour exactly.

**`tests/ws-client-message.test.ts`** — a malformed frame neither throws nor
drops the socket; an unknown `type` is ignored; an oversized frame is refused; a
valid frame reaches the presence store.

**`tests/notifications.test.ts`** — the sweep against a fake registration:
closes a tag whose agent is now `working`, keeps one still `blocked`, closes a
tag for an agent no longer in the list, and does not throw when
`getNotifications` is absent.

**Settings** — default is `true`; a non-boolean on disk falls back and warns;
the PUT route refuses a non-boolean.

`make check`, `make check-clean` and `make test` all pass before the branch is
considered done.

---

## Documentation

- `docs/architecture.md` — the presence module and where it sits in the arrow.
- `docs/settings.md` — the new field.
- `docs/decisions.md` — decision 24: why presence is device-keyed rather than
  global, why it governs push only, why the service-worker-local version and the
  silent clearing push were both rejected on WebKit's push budget. Recorded
  because both will be re-proposed by anyone who sees the line count.
- `docs/gotchas.md` — **herdr's `focused` is not "a human is watching."**

---

## Sequencing

1. `presence.ts` and its tests, alone — no consumers.
2. `ClientMessage`, `serve.ts` validation, `store.ts` sending. Presence is now
   populated and read by nobody; nothing behaves differently.
3. `device-key.ts`, the roster hashing in `index.ts`, `buildPushSender`'s skip.
4. The notifier: withhold-before-stamp, `#deferred`, `reconsider`, wiring.
5. The setting, defaulted **off** while the branch is in progress and flipped to
   `true` in the same commit as the docs, so a half-wired presence store can
   never withhold a real notification.
6. `notifications.ts` and the sweep — independent of 1–5 and shippable alone if
   the rest slips.

Step 6 answers complaint 2 on its own. Steps 1–5 answer complaint 1 and are
worth nothing without each other.
