# Settings

Open `#/settings` from the gear icon on the agent list. It has two sections,
because the settings behind them live in two different places.

## This device

Theme, refresh rate, terminal font size, line wrap, and the terminal keypad —
whether its second row is collapsed, and whether a blocked agent may open it
for you.

The keypad pair is deliberately per-device rather than a server setting: it is
about how much of *this* screen a row of keys is worth, and the same account on
a laptop has room a phone does not.

Stored in this browser's `localStorage` and nowhere else: open paddock on a
second device and it starts from defaults, not a synced copy.

The refresh rate is offered as three named points — Live (250 ms), Balanced
(1 s), Frugal (3 s) — rather than a milliseconds box, because the real decision
is whether the connection is metered, not which precise interval is optimal.

## All devices

Telegram token and chat id, the notification switch, the per-agent cooldown,
and the public URL used for a notification's deep link, plus:

- **notification triggers** (`blocked`, `done`) and a **settle window** per
  trigger — how long the state must hold before a message is sent. `blocked`
  defaults to 5s and `done` to 10s. 0 sends on the state change itself, and
  600s is the ceiling. A hand-edited `settings.json` holding a window outside
  that range (or a cooldown under 1s) is corrected on load, and the correction
  is logged rather than applied silently.

- **mute** — silence every notification for 1, 4 or 8 hours. Stored as an
  absolute instant stamped by the server, so it has no timezone to be misread
  by a phone in one zone and a dashboard in another. There is no indefinite
  mute: the Notifications switch is already that control.

These live on the paddock **process**, one copy for every device that connects
to it, because **sending happens on the server**: turning notifications off
from your phone also silences your laptop. There is exactly one place a
Telegram message is ever sent from, not one per browser that happened to open
the dashboard.

The public URL (e.g. `https://paddock.example.com`) is what turns a bare
"docs-cleanup is blocked" into a tap-through link — set it once here.

**While a `paddock tunnel` run is live, its quick-tunnel URL overrides this
field for notifications — in memory only, never written to
`settings.json`.** The saved `publicUrl` may be a named-tunnel deployment's
real hostname, and a quick tunnel's URL is temporary and different on every
run, so overwriting the file with it would clobber that value the moment the
tunnel closed. A notification sent during the run links to the live quick
tunnel; the file on disk, and what `GET /api/settings` reports, is unchanged
throughout. This is also why a **Tunnel** section — paired-device count, and a
button to mint a code for another device — appears in Settings only while
`paddock tunnel` is the process serving the page; a paddock started the
ordinary way, or a named-tunnel deployment behind it, has no tunnel to pair
and does not show the section at all.

## Push notifications

Per **device**, not per account: a subscription belongs to the browser it was
made in, so the control commits immediately and does not take part in Save. The
device count in that card is how many phones will buzz — it deliberately does
not say whether *this* one is among them, because the server holds a set of
endpoints and cannot tell which of them is the browser asking. The browser
answers that itself.

**On iOS, add paddock to your Home Screen first.** Safari delivers push only to
an installed web app, never to a page open in a tab — so the card asks for that
before it offers anything else. paddock detects this from capability rather than
by inspecting a user agent: `PushManager` simply does not exist in a Safari tab.

The point of push, and the only thing it does that Telegram cannot: a tap opens
**paddock itself**. iOS opens an `https://` link in Safari even when the URL is
inside an installed app's scope, so a Telegram tap always lands in the browser —
and Safari keeps a storage container separate from the Home Screen app, which
can mean re-doing a Cloudflare Access login the app already holds.

If notifications are **blocked**, the card says so and points at browser
settings. It cannot ask again: `requestPermission()` prompts once, and a page
that keeps calling it is a page whose button silently does nothing.

The VAPID keypair and the subscriptions live in `push.json` beside
`settings.json`, mode `0600`. It is written by paddock and is not meant to be
hand-edited. **If it becomes unreadable, push turns off and says so** — paddock
will not mint a replacement keypair, because a new key silently invalidates
every subscription that exists and every phone simply stops buzzing with nothing
on screen to explain it.

**"Skip push for the agent I'm watching"** (`notify.skipWhileViewing`, default
**on**) withholds push — push only, never Telegram — from a device whose pane
is already open on the agent that changed. It does not lose the notification —
**but only when Telegram is not ready to announce it instead**: a fully
withheld push (every subscribed device is looking at the agent that changed)
is *held* and fires the moment the last device showing that pane leaves it,
while the agent is still in the state that triggered it. With both transports
configured, a fully withheld push is simply dropped and the Telegram message
is the announcement — Telegram is never suppressed by presence, so there is
always something to say instead of holding. On by default because the
duplicate buzz on the device already showing the pane is the complaint this
exists to fix, and the deferral means defaulting to quiet costs nothing — see
decision 24 for why it is scoped to a device, and why Telegram is exempt.

## The Telegram token

Written to `~/.config/paddock/settings.json` at file mode `0600`, in a
directory created `0700`, by an atomic write — a truncated file would lose the
one value you cannot regenerate from the UI.

**It is never sent back to a browser.** `GET /api/settings` reports only
whether a token is configured and its last four characters, never the token
itself. paddock has no authentication of its own, so anything an endpoint
returns is readable by whatever passes the gate in front of it, and by any
future XSS.

`PADDOCK_TELEGRAM_TOKEN` and `PADDOCK_TELEGRAM_CHAT_ID` seed the file on first
run only, so a headless deployment never has to open the UI. Once the file
exists it wins; the environment does not silently override a value you set in
the dashboard.

## What a notification contains

An agent name, its new state, and a link. Never terminal output, and never the
agent's task line — that is live agent-authored text which can carry pasted
secrets, and **Telegram bot messages are not end-to-end encrypted**. Content
minimalism is the mitigation, so it is enforced by a test rather than left to
habit.

The same restraint applies to a push notification, for a **different** reason.
A push payload *is* encrypted end to end, so the push service cannot read it —
but the notification renders on a **lock screen**, visible to anyone near the
phone. Two transports, one rule, two justifications; neither inherits the
other's.

Policy is deliberate about the failures that make an alert channel worth
ignoring:

- keyed on the **transition**, not the state, so an agent that stays blocked
  does not repeat
- **first sight after boot is silent**, or restarting paddock would ping once
  per already-blocked agent
- **a settle window is not a delay, it is a confirmation.** A main agent that
  delegates goes `working → done` the instant a subagent returns, then back to
  `working` when it reviews the result. Notifying on that change produces a
  message that is true when sent and stale when read. Waiting for the state to
  hold means the message describes something that is still the case.

  10s is a starting value. If false finishes persist, raise `done` to 30–60s.
  A main agent that spends about 20 seconds composing a review before its
  status flips back to `working` is not covered by a 10s window — the window
  closes first and the message goes out — but a 30–60s one covers it.

- **mute drops rather than queues** — a pile delivered when mute lifts
  describes agents unblocked hours earlier, which is noise wearing the costume
  of signal.
- **a failed send is retried on a timer**, at the cooldown, for at most 3
  attempts in total; after that it stops and the reason is on `/api/health` as
  `lastNotifyError`. Retrying was not always on a timer: it used to wait for
  the agent's next update, which a finished agent never sends — so a `done`
  notification that failed was simply lost. The cooldown is floored at 1 s so
  the retry cannot become a hot loop
