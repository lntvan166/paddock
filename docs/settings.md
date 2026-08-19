# Settings

Open `#/settings` from the gear icon on the agent list. It has two sections,
because the settings behind them live in two different places.

## This device

Theme, refresh rate, terminal font size, line wrap.

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
  defaults to 5s and `done` to 10s. 0 sends on the state change itself.

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
minimalism is the whole mitigation for choosing Telegram over Web Push, so it
is enforced by a test rather than left to habit.

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

  10s is a starting value. If false finishes persist, raise `done` to 30–60s —
  a main agent that spends 20s composing a review before its status flips back
  is inside 10s but outside nothing longer.

- **mute drops rather than queues** — a pile delivered when mute lifts
  describes agents unblocked hours earlier, which is noise wearing the costume
  of signal.
- a **failed send does not consume the transition**, so the next update
  retries; the per-agent cooldown bounds that, and is floored at 1 s so it
  cannot be disarmed
