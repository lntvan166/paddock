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

Telegram token and chat id, the notification switch, which states fire one
(`blocked`, `done`), quiet hours, the per-agent cooldown, and the public URL
used for a notification's deep link.

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
- **quiet hours drop rather than queue** — a pile delivered at 08:00 describes
  agents unblocked five hours earlier
- a **failed send does not consume the transition**, so the next update
  retries; the per-agent cooldown bounds that, and is floored at 1 s so it
  cannot be disarmed
