# Web Push — design

paddock sends a Web Push notification when an agent needs you, delivered to the
installed PWA. Telegram notifications stay exactly as they are; this is a second
transport, not a replacement.

This is **Group C** of a three-part UX pass, and the last one. Groups A (CLI
presentation) and B (the tunnel QR) are on `improve-ux`. **The release gate ends
here** — nothing has shipped from any of the three, and this is the one that
unblocks them.

---

## Why this reopens a decision that was deliberately closed

`docs/roadmap.md` retired Web Push. v2 shipped Telegram instead, and the stated
reasoning was sound: push needs a service worker, a VAPID keypair, a permission
prompt and a subscription store, while Telegram needs a bot token and an HTTPS
POST and works today on any device that already runs Telegram.

That reasoning has not become wrong. What reopens it is the argument recorded
on the other side, in the same file:

> **A Telegram tap cannot open the iOS PWA, and only Web Push can.** iOS opens
> `https://` links in Safari even when the URL is inside an installed web app's
> scope. There are no `url_handlers`, no protocol handlers in Safari, and
> Universal Links need a native app. Telegram's own `openLink` on iOS forces the
> external browser, making it worse rather than better.

So a Telegram tap lands in Safari, which keeps a storage container separate from
the Home Screen app — and can therefore mean re-doing a Cloudflare Access login
the PWA already holds. **A Web Push notification from the installed PWA opens
the PWA** (iOS 16.4+). That is the entire case, and it is narrow: it buys one
thing, for one platform, for people who have installed the app.

Telegram stays because it needs no install, works on a desktop, and is the only
thing that works at all before someone has added paddock to their Home Screen.

### One recorded blocker is stale

The roadmap says the missing PWA icons make this impossible, since Safari
delivers push only to a Home Screen app. That was resolved: `public/` carries
192, 512 and maskable icons plus an `apple-touch-icon`, and `index.html` links
a `manifest.webmanifest`. The roadmap's own "Known v1 gaps" already marks it
done — the Web Push entry's citation of it simply was not updated, and this
design corrects it.

---

## What a notification carries, and why the old reason does not apply

`composeMessage` in `notify/notifier.ts` sends `<name> is <state>` and nothing
else. Its comment is explicit about why, and about what that costs:

> Telegram bot messages are not end-to-end encrypted and Telegram can read them;
> the design accepts that cost and names content minimalism as the ONLY
> mitigation for choosing Telegram over Web Push.

**That reason does not transfer.** Web Push payloads are encrypted end-to-end to
the browser under RFC 8291; Apple and Google cannot read them. The third party
that motivated the restraint is gone.

The restraint stays anyway, on different grounds: **a notification renders on a
lock screen**, visible to anyone near the phone, and shown by default on iOS
even while locked. `a.task` is `terminal_title_stripped` — live, agent-authored
text that may carry a pasted credential. So a push payload is exactly
`{ name, state, agentId }`: the same minimum, for a new reason, and the two
transports stay consistent.

The `agentId` is not optional decoration. It is what makes the tap land on
`#/agent/<id>` inside the PWA, which is the only reason this feature exists.

---

## Where the keypair and the subscriptions live

`~/.config/paddock/push.json`, mode `0600`, holding the VAPID keypair and one
record per subscribed device.

Not `settings.json`, and the distinction is one paddock already draws.
`settings.json` is documented in `docs/settings.md` and meant to be hand-edited;
`paddock.state.json` and `update-check.json` are written by paddock and read by
nobody. A VAPID private key is never user-facing and a device list is a growing
record — both are **state**, not config. There is precedent for a secret in
`settings.json` (the Telegram bot token), but a token is something a person
pastes *in*, while these are things paddock writes *out*, and the file users are
told to edit is the file they will paste into an issue.

It also contains the blast radius: a corrupt `push.json` degrades push without
touching the settings the dashboard runs on.

### The keypair is generated once and NEVER silently regenerated

This is the rule the storage section exists for.

A fresh keypair invalidates every subscription in existence, and the failure has
no symptom whatsoever: every phone simply stops buzzing, and nothing on any
screen explains it. Minting a replacement when the file cannot be read is
therefore the worst available behaviour — it converts a loud, fixable I/O error
into permanent silence.

So: generated on first use; and if `push.json` is later unreadable, paddock
**says so and disables push**. The error surfaces through
`SettingsView.push.error`, exactly as `SettingsStore` already surfaces a broken
`settings.json`. This is the same shape as `docs/gotchas.md`'s existing entries:
the wrong answer given quietly is worse than the failure reported.

### Dead subscriptions are pruned, and only on the codes that mean dead

A push service answering `404` or `410` is stating that the subscription no
longer exists. That one is removed.

**Everything else keeps it.** A `429` is rate limiting, a `500` is their
problem, and a network error is probably ours. Pruning on any failure is how one
bad afternoon quietly unsubscribes every device the operator owns.

### A push failure can never reach the dashboard

Sends are awaited inside the notifier's own `try`/`catch`, reported, and
dropped. The fan-out calls each transport independently, so a Telegram failure
does not suppress push and a push failure does not suppress Telegram.

---

## Files

A new `src/server/push/`, mirroring the split `notify/telegram.ts` already
states in its header — *"Transport only — every policy decision lives in
notifier.ts."*

| file | responsibility |
|---|---|
| `push/vapid.ts` | the RFC 8292 `Authorization` header: an ES256 JWT plus the public key |
| `push/encrypt.ts` | RFC 8291 `aes128gcm` payload encryption |
| `push/send.ts` | one HTTPS POST, and what its response means |
| `push/store.ts` | `push.json` — the keypair and the subscriptions |
| `public/sw.js` | the service worker |
| `web/components/settings/PushSection.tsx` | the permission flow |

And the existing files it reaches into:

| file | change |
|---|---|
| `notify/notifier.ts` | a second optional sender beside the existing one |
| `settings/store.ts` | the `push` view fields, and `enabled` in the patch |
| `shared/types.ts` | `SettingsView.push`, `SettingsPatch.push` |
| `routes.ts` | the two subscribe/unsubscribe routes |
| `index.ts` | constructs the push store and wires the second sender |

**Two transports do not earn an abstraction.** `NotifierOpts` gains a second
optional sender beside the `send` it already has, rather than a `Transport[]`.
`notifier.ts` is a working file whose comments carry hard-won reasoning, and
restructuring it to generalise over exactly two cases would put every one of
those comments at risk for no gain.

### The encoder is hand-rolled, and that is the opposite call to the QR's

`web-push` fails the dependency bar Group B applied: MPL-2.0, and five
transitive dependencies (`asn1.js`, `http_ece`, `https-proxy-agent`, `jws`,
`minimist`).

Group B took a dependency because Reed–Solomon is not in the platform. Here it
is: Bun's WebCrypto supplies ECDH P-256, ECDSA P-256, `deriveBits`, HKDF and
AES-GCM — every primitive both RFCs need. Hand-rolling is roughly 120 lines of
well-specified glue over platform crypto, not an implementation of an algorithm.

**And RFC 8291 §5 publishes a worked example with every intermediate value** —
the salt, both keypairs, the IKM, the CEK, the nonce and the final ciphertext.
So the encryption is verified against the standard rather than against its own
first run. That is a stronger correctness position than Group B's golden matrix,
which could only ever pin what the encoder happened to produce.

### VAPID, and two details that break working-looking code

```
Authorization: vapid t=<jwt>, k=<base64url uncompressed public key>
```

The JWT is `{aud, exp, sub}` signed ES256, where `aud` is the **origin** of the
subscription endpoint, not the endpoint itself.

WebCrypto's ECDSA emits a raw `r‖s` signature, which is what the spec wants.
Node's `crypto` emits DER, and code ported from a Node example produces a
signature every push service rejects while looking entirely correct.

`sub` is **required**. RFC 8292 §2.1 accepts a `mailto:` or an `https:` URL, so
paddock sends `https://github.com/lntvan166/paddock`. There is no operator email
to assume, and CLAUDE.md forbids putting one in a tracked file regardless.

### The encryption, in full

```
IKM   = HKDF(salt=auth_secret, ikm=ECDH(as_priv, ua_pub),
             info="WebPush: info"‖0x00‖ua_pub‖as_pub, L=32)
CEK   = HKDF(salt=salt, ikm=IKM, info="Content-Encoding: aes128gcm"‖0x00, L=16)
NONCE = HKDF(salt=salt, ikm=IKM, info="Content-Encoding: nonce"‖0x00,     L=12)
body  = salt(16) ‖ rs(4) ‖ idlen(1)=65 ‖ as_pub(65) ‖ AES-128-GCM(plaintext‖0x02)
```

`ua_pub` is the subscription's `p256dh` (65 bytes, uncompressed); `as_pub` is a
freshly generated ephemeral key, per message. The `0x02` is RFC 8188's
last-record delimiter. `rs` is the record size as a big-endian `uint32`, set to
**4096** — one record always holds the whole payload, since `{name, state,
agentId}` cannot approach it and multi-record framing would be machinery for a
case that cannot arise.

Request headers: `Content-Encoding: aes128gcm`,
`Content-Type: application/octet-stream`, `TTL: 3600`, and the VAPID
`Authorization`.

**`TTL: 3600`** is how long a push service holds a message for a phone that is
offline. A "needs you" arriving six hours later is noise; a phone in a pocket
through a meeting should still get it. One hour is the compromise, and it is a
number to revisit with real use rather than a derived constant.

---

## The service worker, and one deliberate omission

Three handlers — `push`, `notificationclick`, and `install`/`activate` claiming
clients so an updated worker takes over promptly — and **no `fetch` handler at
all**.

That omission is the design:

1. paddock has no offline story, so a caching worker could only ever serve a
   stale app shell.
2. It sidesteps the Access hazard entirely. `docs/gotchas.md` records that an
   expired Cloudflare Access session turns a service-worker fetch into an HTML
   login page rather than an error. A worker that never fetches cannot be fooled
   by it.

That second point **narrows a constraint this design was expected to inherit**.
A `push` event does not fetch — it renders a notification from the payload it
was handed — so an expired Access session does not break the notification. It
breaks the *tap*, which lands on an Access login. Which is correct behaviour,
and no worse than any other way of opening the app.

`sw.js` is hand-written in `public/`, unbundled: Vite copies `public/` to the
dist root, `gen-embedded` picks it up, and it is served at `/sw.js` with no new
route. Root scope is what push requires, and `IMMUTABLE_ASSET_RE`'s `/assets/`
anchor means it is revalidated rather than pinned for a year — the bug that
comment already records having caused once.

`push` renders with **`tag: agentId`**, so a second alert for the same agent
replaces its predecessor rather than stacking. That matches the notifier's
transition-based dedup, and it is the difference between a glance and a
pocketful. `notificationclick` focuses an existing paddock window when there is
one and opens `#/agent/<id>` otherwise.

---

## The iOS flow, with no user-agent parsing anywhere

CLAUDE.md forbids device detection and permits "capability + install state".
That is not a constraint to be worked around here — it is the better mechanism,
because iOS supplies exactly the signal needed for free: **`window.PushManager`
is `undefined` in a Safari tab and defined inside an installed PWA.**

| detected | shown |
|---|---|
| `PushManager` present | the enable button |
| absent, and not `display-mode: standalone` | "Add paddock to your Home Screen first, then enable notifications here" |
| absent, and standalone | this browser does not support push — said plainly |
| permission already `denied` | say it must be changed in browser settings, because `requestPermission()` will not ask again |

Every row is a capability or an install state. Nothing inspects a user agent,
and the iOS-specific behaviour falls out of the capability check rather than
being special-cased.

Permission is requested **only from a tap**. iOS enforces it, and it is right
regardless: a permission prompt on page load is the one guaranteed way to be
denied permanently.

---

## Settings and routes

`SettingsView` gains:

```ts
push: {
  enabled: boolean;
  /** How many devices are subscribed. */
  devices: number;
  /** Rides along so subscribing is one fetch rather than two. */
  vapidPublicKey: string | null;
  /** Non-null when push.json failed to load. Surfaced, never swallowed. */
  error: string | null;
}
```

`SettingsPatch` gains `push?: { enabled?: boolean }`. Only that: the keypair is
never patchable, and subscriptions arrive through their own routes rather than
by writing a settings field, so that the validation below cannot be bypassed.

**Whether THIS device is subscribed is a client-side question**, answered by
`registration.pushManager.getSubscription()` — not by the server, which knows a
count and a set of endpoints but has no way to tell which one is the browser
currently asking. `devices` exists to answer "how many phones will buzz", which
is a different question and the one worth showing in settings.

Two routes, both under `/api/`, so decision 17's same-origin gate and the tunnel
gate already cover them:

- `POST /api/push/subscribe` — `{ endpoint, keys: { p256dh, auth } }`
- `POST /api/push/unsubscribe` — `{ endpoint }`

Both validate before storing: `endpoint` must be an `https:` URL, `p256dh` must
decode to 65 bytes, `auth` to 16. A malformed subscription is refused loudly
rather than stored to fail silently at send time, when the operator is nowhere
near the terminal.

`PushSection.tsx` sits beside the existing `NotifySection.tsx`.

---

## Tests

**`encrypt.ts` is pinned to the standard, not to itself.** RFC 8291 §5's worked
example supplies fixed inputs and every intermediate value; the test asserts the
IKM, the CEK, the nonce and the final ciphertext byte for byte. This is the one
piece of this design that cannot be verified by looking at it.

**`vapid.ts`** — the JWT's three claims, `aud` being the endpoint's *origin*,
`exp` inside 24 hours, and specifically that the signature is 64 raw bytes
rather than a DER structure.

**`send.ts`**, with an injected `fetch`, one case per outcome: `201` succeeds,
`404` and `410` prune, and `429`, `500` and a thrown network error all **keep**
the subscription. That last group is the one that earns its place, because
pruning on any failure is how one bad afternoon unsubscribes every device.

**`store.ts`**'s important test is a negative: an unreadable `push.json`
surfaces an error and does **not** generate a replacement keypair. Plus a
keypair stable across reloads, and subscriptions deduped by endpoint.

**`sw.js`** is tested the way Groups A and B tested the pairing page's inline
script — extracted from the shipped file and run against a faked `self` and
`clients` in happy-dom. A `push` event produces a notification carrying
`tag: agentId`; a `notificationclick` focuses an existing window when one exists
and opens the deep link when none does.

And one guard that reads oddly and earns its place: **an assertion that `sw.js`
registers no `fetch` handler.** Adding caching later would silently reintroduce
the Access hazard, and this makes that a failing test rather than a discovery.

**The notifier** fans out to both transports, and each is asserted not to
suppress the other when it fails.

---

## Documentation

`docs/roadmap.md`'s Web Push entry is **un-retired**, and its stale citation of
the missing PWA icons corrected — that gap is closed and the roadmap already
says so elsewhere.

**Decision 23** records the reversal: that push was retired in favour of
Telegram, what changed (nothing about the original reasoning — only that the
recorded counter-argument is now being acted on), that Telegram stays, and that
the payload keeps Telegram's content minimalism for a different reason than the
one that motivated it.

`docs/settings.md` gains the push section and the Home Screen requirement.

`docs/gotchas.md` gains the narrowing: an expired Access session breaks a
service-worker *fetch*, and paddock's worker deliberately performs none — so it
breaks the tap, not the notification.

---

## Sequencing

This is the last of the three. When it lands, Groups A, B and C release
together.
