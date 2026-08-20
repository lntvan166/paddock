# Decisions

One entry per decision, each with the reason. These are recorded so a later
session does not silently re-litigate them.

1. **Unix socket over CLI/plugin.** herdr exposes a socket API with 90 methods
   and a published JSON Schema. Speaking it directly avoids a per-event process
   spawn and an install step; action methods run on their own one-shot
   connection rather than forking a CLI invocation each time.

2. **Generated types from `herdr api schema --json`, not hand-transcribed.**
   `make types` regenerates `src/shared/herdr-api.d.ts` and commits it.
   Hand-transcribed payload contracts drift silently: a field gets renamed
   upstream, the consumer keeps reading the old key, and the failure surfaces
   as wrong content on screen rather than a build error. Generated types turn
   that into a build error instead.

3. **No application auth token.** A shared secret that gates every route also
   401s `/sw.js`, which silently disables the service worker and therefore
   push notifications. Cloudflare Access sits in front of the tunnel hostname
   instead — it provides identity, policy, and audit logging that a token in a
   URL does not. paddock itself binds loopback only and has no authentication
   of its own. See `docs/deploy-cloudflare.md` for how the gate is verified.
   Do not reintroduce a token as a "hardening" improvement.

   Scope, added later: this governs the DEFAULT listener, which is still
   unauthenticated and loopback-only. `paddock tunnel` adds a separate,
   temporary listener with a cookie gate, because a quick tunnel cannot have
   Access in front of it at all — see decision 13 for why that is not the
   mechanism this decision rules out.

4. **`agent.list`, not `pane.list`.** Only `agent.list` returns the
   operator-assigned `name` field; `PaneInfo` has no `name` (it has `label`).
   Using `pane.list` is the difference between a useful dashboard and one
   where every row renders identically.

5. **One JS chunk, no code-splitting.** The target network is a high-latency
   mobile link (~250 ms RTT with heavy jitter). At that RTT, an extra round
   trip costs more than the bytes that splitting would save, for a
   single-screen app. One screen, one chunk.

6. **No webfont.** The system font stack (and system monospace stack where
   needed) is used instead. This is the single largest available saving on
   first-page load over a slow mobile link.

7. **Actions are POST routes; state changes ride the existing delta path.**
   Reading a pane and answering a blocked agent are plain HTTP calls that
   return their result to the caller. Rejected: a `ClientMessage` union sent
   over the WebSocket — it needs request/response correlation ids the
   protocol has no field for, and error handling across a socket that can
   reconnect mid-request is harder than reading an HTTP status. Also
   rejected: POST-only with no delta involvement at all — the state change an
   action causes (or a dismissal's `acknowledgedAt`) would only reach the tab
   that made the request, and every other open browser would disagree until
   the next 30s reconcile.

8. **Persistent-grant options are rendered verbatim, with no special
   treatment.** One real probed option was "Yes, and always allow access to
   tmp/ from this project" — a policy change, not a one-time approval.
   Detecting that case would mean matching a label's text against a pattern,
   which is exactly the guessing `docs/gotchas.md` forbids for option
   handling: a pattern that misfires either nags on an option that was safe,
   or stays silent on one that granted something lasting.

9. **The acknowledge flag is paddock-local and never sent to herdr.**
   `agent.focus` would clear `done` at the source, but it also yanks the
   focused pane in herdr's own desktop UI — dismissing a card from the phone
   must not steal window focus at the desk. `acknowledgedAt` lives only in
   `Agent` (see `shared/types.ts`) and is carried across state updates by
   `carryAcknowledged`.

   **Where that claim comes from:** herdr's own CLI documentation for
   `agent.focus` / `herdr agent focus`, which is out of this tree — nothing in
   this repository demonstrates the focus-stealing behaviour, and no paddock
   test can, since paddock never calls the method. A future challenger should
   re-read that documentation (or probe `agent.focus` against a live herdr with
   the desktop UI visible) rather than treat the sentence above as evidence in
   itself. The behaviour could also change upstream without anything here
   failing.

10. **Settling a state instead of notifying on the change.** Notifying on a
    state *change* was wrong in a way that only shows up against real agents:
    a main agent that delegates goes `working → done` the moment a subagent
    finishes, and back to `working` seconds later. Every delegated task
    produced a "done" message that was already false when the phone buzzed.
    The cooldown does not help — it bounds how *often* paddock speaks, not
    whether what it says is still true.

    The notifier now arms a per-trigger timer and the next transition cancels
    it, so a message is only sent about a state that has held. `blocked`
    settles in 5s because a blocked agent is waiting on a human; `done`
    settles in 10s because `done` is the state that lies.

    Two follow-on effects worth knowing. `#lastSeen` split into `#lastSeen`
    plus `#lastNotified`, which deleted the optimistic-write-and-revert dance
    that one map doing two jobs had required. And the retry became explicit
    and bounded: v2 "retried on the next delta", which for a finished agent
    can never happen, because a quiet `done` agent produces no further
    deltas — so a failed finish notification was simply lost.

    A third map, `#episode`, exists because the send is `await`ed: a Telegram
    POST takes up to 10s, and the agent can transition several times before
    `#fire` resumes. Neither `#lastNotified` nor the retry may then be written
    on behalf of an episode that has ended, and STATE CANNOT IDENTIFY AN
    EPISODE — `blocked → working → blocked` leaves `#lastSeen` reading
    "blocked" again, so a `#lastSeen === state` check calls the first episode's
    late continuation current. A counter bumped on every genuine transition
    can tell them apart; that is the whole reason it is there, and it is not a
    redundant third copy of `#lastSeen`.

11. **Mute until, rather than quiet hours.** Quiet hours was one `HH:MM`
    range in *server local* time, with no timezone field and no way to
    express a second window. An absolute epoch-ms instant cannot be misread
    by a phone in one zone and a server in another, and it is self-describing
    in the UI: "muted until 07:14" needs no explanation, where "22:00–08:00"
    silently invites the question *whose 22:00*.

    It also matches when silence is actually wanted — now, because the
    operator is going to bed — rather than on a schedule set once and
    forgotten.

    Mute is `POST /api/settings/mute` taking a **duration**, not a patch
    field taking an instant, for two reasons: the server stamps the time so a
    skewed phone clock cannot set a wrong one, and mute applies immediately
    while every other field waits for Save. A separate endpoint makes that
    structural rather than a convention. There is no indefinite mute;
    `notify.enabled` is that control, and two controls for one state is how
    an operator ends up muted without knowing why.

12. **`content-type: application/json` is required on every settings write.**
    The design mandated `POST /api/settings/mute` and never mentioned CORS.
    POST stays, for the reasons the design gives: the server stamps the mute
    instant from a client-supplied duration, and mute applies immediately while
    every other field waits for Save, which a separate endpoint makes
    structural rather than a convention.

    But POST is a CORS-*simple* method, and `PUT /api/settings` is deliberately
    PUT precisely because PUT is not — a cross-origin write of that route
    forces an `OPTIONS` preflight that nothing answers. paddock has no
    authentication of its own (decision 3), and a browser holding a Cloudflare
    Access session attaches it to a cross-origin request as readily as to a
    first-party one, so that preflight is the whole CSRF control. Hono's
    `c.req.json()` is `text().then(JSON.parse)` and ignores the content type,
    which left the mute route reachable from an `enctype="text/plain"` form on
    any page the operator visits: a silent multi-day mute or unmute, which is
    exactly the "operator stops trusting the channel" failure the settle work
    exists to fix. The same door made the test route's chat id
    attacker-choosable — the operator's own bot posting into a chat of someone
    else's choosing. Capability exposure, not credential exposure: the token
    never leaves the server.

    So `strictJsonBody` refuses any body whose media type is not
    `application/json`, which restores the preflight requirement for all three
    settings routes at one point. A `charset` parameter is accepted — the match
    is on the media type, not the whole header — because
    `application/json; charset=utf-8` is what several ordinary clients send.

    Scale honestly: the pre-existing action routes are POST already and carry
    larger levers, so this is not new in kind. It is a floor, not a fix for
    CSRF in general, and it is not a reason to reintroduce an application auth
    token (decision 3 still stands).

13. **A pairing gate on its own socket, for quick tunnels only.** Decision 3
    stands for the default listener: `127.0.0.1:8787` has no authentication and
    Cloudflare Access in front of a named tunnel remains the recommended
    deployment. But a *quick* tunnel cannot take an Access policy — Access
    applications are keyed by a domain in your own account and
    `trycloudflare.com` is Cloudflare's — so `paddock tunnel` without a gate
    would publish keystroke access to every agent on the machine, which is the
    plain-`200` outcome `docs/deploy-cloudflare.md` §3 exists to warn about.

    This is not the mechanism decision 3 forbids, for three reasons. The
    credential is a same-origin cookie, not a token in a URL or header, so a
    browser attaches it to page requests and to the WebSocket upgrade alike —
    the exact property decision 3 observes a shared secret lacks. The gate lives
    on a second listener that exists only while `paddock tunnel` runs, so the
    default socket is untouched. And paddock has no service worker: Web Push was
    superseded by Telegram in v2, so `/sw.js` does not exist to be broken — and
    `docs/gotchas.md` already records that an expired Access session breaks a
    service-worker fetch the same way, so this introduces no constraint the
    recommended deployment does not already impose.

    Rejected: exempting loopback by `Host` header on a single port. `cloudflared`
    connects over loopback like any local client, so a tunnel request and a desk
    request are indistinguishable at the socket; the only difference is a header
    the REMOTE client controls, and `Host: localhost` through the tunnel would
    take the exempt path. Two listeners make the gate a property of the socket a
    request arrived on, which nothing outside the machine can forge.

    Not a token, and not a precedent for one. See
    `docs/design/2026-08-20-quick-tunnel-design.md`.
