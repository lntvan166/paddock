# Notifications and settings, second pass

Status: approved, not yet built.
Supersedes parts of `docs/design/2026-08-18-settings-and-telegram-design.md`
(quiet hours, the test-message route, the message body). Everything that
document says about *why Telegram rather than Web Push* still stands, with one
new piece of evidence recorded in §9.

---

## 1. What is wrong today

All six items below come from running v2 against real agents for a day, not
from review.

1. **"Done" notifications are usually false.** A main agent that delegates to a
   subagent goes `working → done` the moment the subagent finishes, then back
   to `working` seconds later when it reviews the result or starts the next
   one. `Notifier.#one()` fires on the *edge* of a transition, so the message
   is factually true at the instant it is sent and stale by the time the phone
   buzzes. Opening paddock shows `working`. This happens on nearly every
   delegated task, which makes the finish notification worse than useless: it
   trains the operator to ignore the channel.

2. **The test-message button tests the stored credentials, not the typed
   ones.** `POST /api/settings/telegram/test` reads `settings.current()`. An
   operator who pastes a token and presses "Send test message" — the obvious
   order, and the only order that lets them find out whether the token works
   before committing it — gets "token and chat id must both be set".

3. **Quiet hours cannot express the real intent.** It is a single `HH:MM`
   range in *server local time*, with no timezone and no way to express more
   than one window. The operator's phone and the dev-box need not share a
   timezone, and nothing in the UI says which one the field means.

4. **Save is invisible.** It sits at the bottom of a long single-column form.
   On a phone the operator changes a field near the top, never scrolls, and
   leaves believing the change took.

5. **A Telegram tap cannot land in the installed app.** paddock is used as an
   iOS Home Screen PWA. Tapping the link in a Telegram message opens Safari,
   not the app.

6. **The message's link is a bare URL** in the text, rather than a tap target.

## 2. Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| 1 | Notify only once a state has **held still** for a per-trigger settle window. | A single global window (delays `blocked`, the one alert wanted fast); an edge notification plus a correction message (two messages per handoff instead of none). |
| 2 | The test route accepts on-screen credentials in its POST body, per-field fallback to stored, and does **not** save on success. | Auto-saving on a successful test — it makes a probe into a commit, and the operator did not ask for one. |
| 3 | **Delete quiet hours. Replace with "Mute for 1h / 4h / 8h."** | A timezone picker plus a repeatable range list. It is more machinery for a worse fit: silence is wanted *now*, because the operator is going to bed, not on a schedule set once and forgotten. |
| 4 | A sticky "Unsaved changes" bar that appears when the form is dirty, plus a toast on the result. | Save in the header (implies it also commits the "This device" prefs, which save themselves instantly); toast alone (fixes the invisible outcome, not the unfindable button); autosave on blur (sends half-typed tokens). |
| 5 | Record the iOS finding; ship an inline **Open in paddock** button as the best available tap target. | Claiming a deeplink exists. It does not — see §9. |

Explicitly **not** in this shipment: spawning a new agent from paddock. It is
possible — see §10 for the measured constraints — and it gets its own design.

### 2.1 Why "mute until" and not a schedule

An absolute epoch-ms instant has no timezone, so it cannot be misread by a
phone in one zone and a server in another. It is also self-describing in the
UI: "muted until 07:14, in 6h 22m" needs no explanation, whereas
"22:00–08:00" silently invites the question *whose 22:00*.

There is no "mute indefinitely" option. `notify.enabled` is already that
control, and two controls for one state is how an operator ends up muted
without knowing why.

## 3. Data model

`Settings.version` goes to `2`.

```ts
export interface Settings {
  version: 2;
  telegram: { token: string | null; chatId: string | null };
  notify: {
    enabled: boolean;
    triggers: NotifyTrigger[];
    /** Per trigger: how long the state must hold before a message is sent.
     *  0 means fire on the edge, i.e. v2's behaviour. */
    settleMs: Record<NotifyTrigger, number>;
    /** Epoch ms. Notifications are suppressed while now < this. */
    mutedUntil: number | null;
    cooldownMs: number;
  };
  publicUrl: string | null;
}
```

Defaults: `settleMs: { blocked: 5_000, done: 10_000 }`, `mutedUntil: null`.
`quietHours` is removed from the interface entirely.

`blocked` settles fast because a blocked agent is waiting on the operator and
every second of the window is a second of an agent doing nothing. `done`
settles longer because it is the state that lies.

**10s is a starting value, not a measured one.** It covers the common case —
a main agent that resumes immediately after a subagent returns. It does *not*
cover a main agent that spends 20s composing a review before its status flips
back to `working`. The field is in the UI precisely so it can be raised; if
misfires persist, raise `done` to 30–60s. Record the observed value in
`docs/settings.md` once known.

### 3.1 Migration

`SettingsStore.load()` currently merges with

```ts
this.#s = { ...defaults(), ...(JSON.parse(raw) as Settings) };
```

That is a **shallow** merge: a stored `notify` object replaces
`defaults().notify` wholesale. A v1 file would therefore load with no
`settleMs` at all — the notifier would read `settleMs[state]` as `undefined`
and pass it to `setTimeout`, which coerces to 0 and silently restores exactly
the edge-firing bug this document exists to remove. A shape whose absence
degrades to the old behaviour without erroring is worse than one that throws.

So v2 replaces the spread with an explicit `migrate(parsed): Settings` that:

- fills every missing `notify` key from `defaults()`, `settleMs` per trigger;
- drops `quietHours` if present, logging one INFO line naming what was
  discarded and that mute replaces it — the standing rule is that nothing is
  dropped silently;
- stamps `version: 2` and persists once, so the file on disk matches the code
  that reads it.

A file that is not valid JSON keeps today's behaviour exactly: record
`error`, use defaults, and **do not overwrite it**.

## 4. Notifier

### 4.1 State

```
#lastSeen:     Map<agentId, AgentState>   // the truth. Never reverted.
#lastNotified: Map<agentId, AgentState>   // what was actually sent about.
#pending:      Map<agentId, {state, timer, attempts}>
#lastSentAt:   Map<agentId, number>       // unchanged, cooldown
```

Splitting "what we saw" from "what we told them" is what removes the
optimistic-write-and-revert dance in today's `#one()` — three of the longest
comments in the file, all of them explaining a subtlety that only exists
because one map was doing both jobs.

`#lastNotified`'s job is to stop a re-announcement *within* one held episode
(a task-line-only delta arriving while the state has not changed) — not
across episodes. It is cleared the moment the episode it describes ends, i.e.
on every genuine transition (§4.2 step 3), not only on `removedIds`: a
`blocked → working → blocked` flap is two distinct episodes, both worth
telling the operator about, and an entry left over from the first would
silently drop the second forever.

### 4.2 Flow

On each upserted agent in a delta:

1. First sight (`prev === undefined`): record `#lastSeen`, return. This
   preserves v2's behaviour deliberately — a paddock restarted while an agent
   is already blocked says nothing, because it cannot distinguish "just
   blocked" from "blocked for an hour", and announcing every agent on every
   restart is its own noise problem.
2. `prev === a.state`: return. (A task-line-only update.)
3. State changed. **Cancel any pending timer for this agent** — the claim it
   was going to make is void — set `#lastSeen` to the new state, and **clear
   `#lastNotified` for this agent**: the episode it recorded has just ended,
   so the dedup has served its purpose and must not suppress the next one.
4. If the new state is not in `triggers`, return.
5. Arm a timer for `settleMs[state]`. `unref()` it.

When the timer fires:

1. If `#lastSeen.get(id) !== state`, the state moved. Drop it. (Belt and
   braces: step 3 above already cancels, so this is the guard against a race,
   not the primary mechanism.)
2. If `#lastNotified.get(id) === state`, already reported. Drop.
3. Gate, in order: `notify.enabled` → `isConfigured(token) && isConfigured(chatId)`
   → **not muted** (`mutedUntil === null || now >= mutedUntil`). A failure at
   any of these three drops the notification.
4. Cooldown (`now - lastSentAt >= cooldownMs`). Unlike the three above, a
   cooldown miss **re-arms the timer for the remaining cooldown** rather than
   dropping: the cooldown bounds how *often* paddock may speak about one
   agent, and treating it as a drop would lose a real finish just because a
   `blocked` message went out 20s earlier. A cooldown deferral does **not**
   count against the attempt cap in step 5 — it is not a failure.
5. Record the attempt on `#lastSentAt` **before** sending, then send. On
   success set `#lastNotified` and clear `lastError`. On failure, re-arm at
   `cooldownMs` with `attempts + 1`, up to **3 attempts**, then give up and
   leave `lastError` set.

`#lastSentAt` is stamped per *attempt*, not per success, preserving v2's
reasoning exactly: a broken token fails every send, and recording only
successes would leave `since` permanently infinite and turn the retry path
into one Telegram POST per delta forever.

The mute check happens at **fire** time, not schedule time, and a suppressed
message is **dropped, never queued** — carried over verbatim from v2's quiet
hours reasoning: a pile delivered at 08:00 describes agents unblocked five
hours earlier, which is noise wearing the costume of signal.

The bounded retry is a genuine improvement, not a rewrite for its own sake.
Today a failed send reverts `#lastSeen` so "the next delta re-detects the
transition" — but a finished agent produces no further deltas, so for `done`,
the state this whole document is about, today's retry can never fire. A
failed finish notification is currently lost outright.

### 4.3 Lifecycle

`setTimer` / `clearTimer` are injected through `NotifierOpts`, the way `now`
already is, so tests are deterministic and nothing waits in real time.

Timers are cleared on `removedIds` — which must now clear **all four** maps
(`#lastSeen`, `#lastNotified`, `#pending`, `#lastSentAt`), not the two it
clears today; a surviving `#lastNotified` entry for a recycled agent id would
suppress that agent's first real notification — and by a new `dispose()`,
called from the server's shutdown path. Combined with `unref()`, a pending settle can neither hold the
process open nor fire against a torn-down store.

`inQuietHours()` and its `minutes()` helper are deleted. `tests/notifier.test.ts`
loses its quiet-hours cases and gains §8's.

## 5. Credential handling

### 5.1 The test route

```
POST /api/settings/telegram/test
  { }                          → use stored token and chat id (today's behaviour)
  { token, chatId }            → use these
  { token }                    → typed token, stored chat id
```

Resolution is **per field**: an absent or blank value falls back to the stored
one, via the same `isConfigured` predicate the rest of the process uses. If
either field is still unconfigured after resolution, 400 with the existing
message. Success does not save — the sticky bar (§6.2) keeps saying "Unsaved
changes", so a green test cannot be mistaken for a commit.

The token travels in a POST body, never a query string: query strings land in
edge access logs.

### 5.2 A token's charset is now validated

`sendTelegram` builds `api.telegram.org/bot${token}/sendMessage`. The token is
interpolated into a **URL path**, and nothing validates its shape today — so a
token containing `/` or `..` addresses a different Telegram method than the one
this code intends. This is a pre-existing hole on the *stored* token path, not
something the new route introduces; the new route just makes it reachable with
one fewer step.

Guard added in both `validateSettingsPatch` and the test route: `/^[A-Za-z0-9:_-]+$/`
and a length bound. Rejection detail names the rule and **never echoes the
value**.

Everything `sendTelegram` already does about not leaking the token stays
untouched — in particular the `(e as Error).message`-only catch, which exists
because Bun attaches the request URL (containing the token) to a fetch error.

## 6. UI

### 6.1 Splitting Settings.tsx

`Settings.tsx` is 414 lines before this change adds a mute block, two settle
inputs, a relocated test button, a dirty bar and a toast. Split first:

```
Settings.tsx                shell, load, dirty tracking, save
settings/DeviceSection.tsx  theme, rate, font, wrap — behaviour unchanged
settings/TelegramSection.tsx token, chat id, test button + result
settings/NotifySection.tsx  mute, enabled, triggers + settle, cooldown, public URL
settings/SaveBar.tsx        sticky "Unsaved changes" + Save
settings/Toast.tsx          role="status" live region
```

Each section takes its values and setters as props and owns no fetching. The
shell keeps every request, so there is still exactly one place that knows how
settings reach the server.

### 6.2 The save bar

A `baseline` is captured from the GET response and re-captured from each
successful PUT. Dirty is a field-by-field comparison against it, plus
`token !== ""` — the token is write-only, so anything typed counts as a
change.

The bar renders **only when dirty**: fixed to the bottom of the viewport,
`padding-bottom: env(safe-area-inset-bottom)`, containing "Unsaved changes"
and Save. The form reserves matching bottom space unconditionally, so the bar
never covers the last field and nothing jumps when it appears.

Save stays disabled until the GET has landed, for the reason already commented
in `Settings.tsx`: a form that never loaded would PUT empty values over a
working configuration.

### 6.3 The toast

`role="status"`, `aria-live="polite"`, 3s auto-dismiss, and it announces
success only. **Errors do not use it** — they keep the existing banner, which
persists. An error the operator must catch within three seconds is a swallowed
error.

Under `prefers-reduced-motion` it appears and disappears with no fade. It
stays local to Settings; no global toast system is invented for one caller.

### 6.4 Mute

Rendered at the top of the notify section, because it is the "right now"
control:

```
muted:     Muted until 07:14 (in 6h 22m)     [ Unmute ]
unmuted:   Mute for   [ 1h ]  [ 4h ]  [ 8h ]
```

Tapping applies **immediately** — it is not part of the form and does not wait
for Save. See §7 for why that is structural rather than a convention.

### 6.5 Settle inputs

Inside the existing "Notify on" fieldset, attached to the trigger each one
belongs to, because that is where the confusion lives:

```
Notify on
  [x] Blocked    wait [  5 ]s before sending
  [x] Done       wait [ 10 ]s before sending

  Only notify once the agent has held this state for the whole
  wait. A subagent finishing flips an agent to done for a moment;
  waiting means you hear about the real finish, not that blip.
```

Seconds in the UI, milliseconds in the contract, converted at the boundary.
Server validation: finite, `0 <= settleMs <= 600_000`. Zero is legal and is
exactly v2's behaviour, so the feature can be switched off rather than only
tuned.

No device detection anywhere in the above; width media queries for layout and
`(pointer: coarse)` for touch targets, per the standing UI rules. Any new
colour is defined on bare `:root` first, then redefined under
`prefers-color-scheme` and `[data-theme]`.

## 7. API contract

`src/shared/types.ts`:

```ts
SettingsView.notify: {
  enabled: boolean;
  triggers: NotifyTrigger[];
  settleMs: Record<NotifyTrigger, number>;
  mutedUntil: number | null;
  cooldownMs: number;
}
SettingsView.serverNow: number;   // new
```

`serverNow` is new because the UI must render "in 6h 22m" from an absolute
instant and **the phone's clock is not the server's**. The view carries the
server's own reading so the client computes one offset at load and ticks
locally from there.

`SettingsPatch.notify` drops `quietHours` and gains `settleMs`. It does **not**
gain `mutedUntil`:

```
POST /api/settings/mute   { forMs: 14400000 }  → mutedUntil = serverNow + forMs
POST /api/settings/mute   { forMs: 0 }         → unmute (mutedUntil = null)
                                               → returns the updated SettingsView
```

Two reasons this is its own route rather than a patch field. The server stamps
the instant, so a phone with a skewed clock cannot set a wrong one — the
client only ever sends a duration. And mute must apply immediately while every
other field waits for Save; making that a different endpoint makes it
structural, instead of a rule everyone has to remember. `forMs` is validated
as a finite number, `0 <= forMs <= 7 days`.

Dropping `quietHours` from the contract is a breaking change, but paddock
ships server and UI as one binary. The only exposure is a tab left open across
an upgrade, which the existing build-id stale bar already handles.

## 8. Testing

`make test` builds the UI first. Timers are injected, so no test waits in real
time.

**Notifier**

- **The reported bug, as a test:** `working → done → working` inside the
  settle window sends **nothing at all**.
- A state held for the full window fires exactly once.
- `blocked` uses its own shorter window (a `blocked` settle does not wait for
  `done`'s).
- Mute suppresses at fire time; a message suppressed by mute is dropped, not
  delivered late once mute expires.
- Cooldown still bounds two sends about the same agent, and a cooldown miss
  **defers** rather than drops: the message arrives once the window passes.
- A failed send retries at `cooldownMs`, at most 3 times, then stops with
  `lastError` set — and a cooldown deferral does not consume an attempt.
- `dispose()` and `removedIds` both clear pending timers, and `removedIds`
  clears `#lastNotified` too: an agent id that returns must be able to notify
  again.
- The existing guarantee that `a.task` never appears in a message body still
  holds.

Mutation-checked, per this repo's habit: deleting the cancel-on-reversal in
step 3 must turn the first test red. If it does not, the test is decorative.

**Settings store**

- A v1 file with `quietHours` loads as v2: default `settleMs` present,
  `quietHours` gone, `version: 2`, persisted once.
- A malformed file still records `error` and does **not** overwrite.
- `current()` still returns a deep copy — the existing route tests depend on
  it being a snapshot.

**Routes**

- Test route: body credentials used; per-field fallback to stored; 400 when
  either is unresolved; token charset rejected on both the patch and the test
  path, with no echo of the value.
- Mute route: stamps from server time, validates `forMs`, `0` unmutes, returns
  the updated view.

**Components** (happy-dom, via `tests/support/dom.ts`)

- The save bar appears on an edit and clears after a successful save.
- The toast renders as a live region and carries the success text.
- The test button posts the on-screen token rather than `{}`.

**Existing tests that must be updated**, not left to rot:
`tests/notifier.test.ts`, `tests/settings-view.test.tsx`,
`tests/prefs-applied.test.tsx`, `tests/notify-wiring.test.ts`.

## 9. Telegram to the iOS PWA: not possible

Investigated because the operator runs paddock as an iOS Home Screen PWA and
wants a Telegram tap to land in it.

**It cannot.** iOS opens `https://` links in Safari even when the URL is
inside an installed web app's scope. There are no `url_handlers`, no protocol
handlers in Safari, and Universal Links require a native app. Telegram's own
`openLink` on iOS forces the external browser, which makes it worse rather
than better.

There is exactly one documented exception: **a Web Push notification from the
installed PWA opens the PWA** (iOS 16.4+).

Two consequences worth recording. Safari keeps a storage container separate
from the Home Screen app, so a Telegram tap can mean re-doing a Cloudflare
Access login already held in the PWA. And `docs/roadmap.md` retired Web Push
on the reasoning that Telegram "works today on any device" — that is still
true, and this is new evidence on the other side of the trade, because push is
the only mechanism that can land a tap *inside* the app on iOS. Recorded in
the roadmap for whoever revisits it; the decision is not reopened here.

What ships instead: the link becomes an inline keyboard button.

```
reply_markup: { inline_keyboard: [[{ text: "Open in paddock", url }]] }
```

Telegram rejects a non-`https` button URL (`Button_url_invalid`), so a
`publicUrl` that is not https falls back to appending the plain text link
exactly as today. Both branches are tested. `sendTelegram` gains an optional
`replyMarkup` and stays transport-only; choosing button-versus-text-link is
policy, so it is decided in `notifier.ts`.

The message body is otherwise unchanged: name, state, link, and **nothing
else** — specifically not `task`, which is live agent-authored text that may
carry a pasted credential. Content minimalism is the only mitigation the
design claims for choosing Telegram over Web Push, and it is not being spent
here.

## 10. Deferred: spawning an agent from paddock

Confirmed feasible against the installed herdr (protocol 19) while scoping
this work, and deliberately **not** designed here. Findings, so the next
design starts from measurement rather than a fresh investigation:

- `tab.create` takes `{ workspace_id?, cwd?, label?, env?, focus }`.
- `agent.start` takes `{ name, kind, pane_id, args?, timeout_ms? }`, where
  `kind` is a fixed enum including `claude`, `codex`, `gemini`, `pi`.
  `timeout_ms` must exceed 3000 and is capped at 300000.
- **`agent.start` blocks on readiness, default 30s.**
  `src/server/herdr/socket.ts` sets `HERDR_TIMEOUT_MS = 10_000`, so a naive
  call times out at paddock's own socket layer before herdr answers. Needs a
  per-call timeout override.
- Result shapes for `tab.create` are **not** in `src/shared/herdr-api.d.ts`.
  This repo has already shipped a bug from assuming one — `actions.ts` read
  `result.text` from `agent.read` for all of v2 while herdr sends
  `result.read.text` — so this needs `scripts/gen-herdr-types.ts` extended,
  not a hand-written literal.
- It would be paddock's first **creating** action. Every action today drives
  an agent that already exists. Spawning processes on the dev-box from a phone
  is a different risk class and deserves its own decisions about which kinds
  are permitted and where `cwd` may point.

## 11. Docs to update

- `docs/settings.md` — mute and settle replace quiet hours; note the observed
  good value for `done` once known.
- `docs/decisions.md` — why mute rather than a schedule; why settling rather
  than edge-firing.
- `docs/architecture.md` — the notifier is no longer purely delta-driven; it
  owns timers and a `dispose()`.
- `docs/roadmap.md` — the iOS finding (§9) and the spawn-agent entry (§10).
- `README.md` and `.env.example` — wherever quiet hours is named.

## 12. Build order

1. Config schema + `migrate()`, with tests. Nothing else can be written
   against a shape that does not exist.
2. Notifier settle, mute, bounded retry, `dispose()`.
3. Token charset guard; test route body credentials; mute route.
4. Split `Settings.tsx`, behaviour unchanged, tests still green.
5. Save bar, toast, mute UI, settle inputs.
6. Inline keyboard button and its https fallback.
7. Docs.

Steps 1–3 are server-only and independently verifiable. Step 4 is a pure
refactor and should be a commit that changes no behaviour, so that step 5's
diff is only the new UI.
