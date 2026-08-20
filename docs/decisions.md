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

14. **Protocol drift is directional, and fields are the real contract.**
    `checkProtocol` compared herdr's protocol with `!==`, so any drift in either
    direction was a fatal startup error. Measured cost: herdr 0.8.0 → 0.8.2
    moved the protocol 19 → 20 and the regenerated types differed by two lines —
    the number and its comment, with a byte-identical status enum. Nothing
    paddock reads had changed, and paddock refused to start at all.

    `scripts/protocol-guard.ts` already encoded the asymmetry that matters: it
    refuses to regenerate against an OLDER herdr, because that shrinks the enums
    and silently narrows the contract, while an upgrade is allowed. The runtime
    gate now matches it. An older herdr throws, since it genuinely lacks what
    this paddock reads. A newer one is accepted and reported once at INFO, and
    `/api/health` carries the observed `herdrProtocol` so the drift is visible
    to a `curl` or a monitor rather than only in a log. Not to the dashboard:
    nothing under `src/web/` reads `/api/health`, so this is the same
    operator-diagnostic surface `lastNotifyError` already uses. Surfacing it in
    the UI would mean putting it on the hub's hello payload.

    What replaces the version comparison is `src/server/herdr/shape.ts`, which
    checks the fields paddock actually reads against the live `agent.list`
    response on every reconcile — not just at startup, because a herdr upgraded
    underneath a running paddock is the ordinary case: the protocol is read only
    when the daemon is first reached, so a long-lived instance keeps working
    across an upgrade and only a restart reveals the break.

    It covers only fields that are REQUIRED in `HerdrAgentRaw`. `name` and
    `terminal_title_stripped` are optional and `adapter.ts` already falls back
    for both, so a pane that was never named legitimately lacks them — checking
    those would report a protocol break on an ordinary install, and a check that
    cries wolf on normal data trains you to ignore it. Zero panes yields
    `unknown`, never `broken`: you cannot conclude a field is gone from no rows.

    Checked against live data rather than `herdr api schema --json`, for the
    reason `doctor.ts` already records — the CLI answers from the binary on disk
    while the socket answers from the running daemon, and the two disagree after
    an upgrade, which is the exact confusion this decision exists to end.

    A broken shape refuses at startup and, once running, is logged on change and
    exposed as `health.schemaWarning`. Rendering every agent in one wrong state,
    or every row under the same label, is worse than not starting — the operator
    would act on it. Do not restore `!==` here without deleting the shape check
    too: that would bring the brittleness back with none of the protection.

15. **An unnamed agent is labelled from `basename(cwd)`, with mandatory
    disambiguation.** herdr does not require an agent name, and the fallback was
    `pane_id` — so an operator who never named anything got a dashboard of
    `w3:p1`, which identifies the pane perfectly and says nothing about the
    work. Measured on a second machine, where nothing had been named: every row
    was coordinates.

    This reverses the letter of a rule this project had from the start, so read
    what the rule was actually protecting. The failure was **two rows rendering
    identically**, because agents commonly share a working directory; `cwd` was
    banned because on its own it cannot promise otherwise. `toAgents` in
    `adapter.ts` supplies that promise — a label climbs to `project p1`, and
    then to `project w1:p1`, the moment the rung below is ambiguous — so the
    guarantee holds and the ban is no longer what enforces it. The ban stays in
    force for anything that drops the suffixing.

    An operator-set name is never rewritten, but it does occupy its label: a
    fallback that would duplicate one moves aside. Distinguishability is a
    property of the screen, not of which field the string came from.

    Labels are recomputed every reconcile, so a suffix appears when an agent
    joins and goes when it leaves. A label that mutates was the accepted cost,
    and the alternative was worse: `AgentChip` renders the name ALONE, so the
    idle section — usually most of the list — would be five identical chips,
    five controls with no way to know which one you are about to tap. A stable
    label nobody can read is not stability worth having.

16. **The new-release notice is a dismissable banner, and the check repeats
    while paddock runs.** Two faults, one symptom: an operator a version behind
    did not know.

    The check fired **once**, at startup, and `latestKnown` was frozen from that
    moment. `paddock start` and a dashboard left open on a phone are the two
    documented ways to use this, and both are exactly the long-lived case that
    could never learn about a release published afterwards. It now re-checks on
    an hourly timer. The timer is not the rate limit — `checkForUpdate`'s 24h
    on-disk cache is, unchanged, so GitHub is still contacted at most once a day
    and `PADDOCK_NO_UPDATE_CHECK=1` still disables everything. Deliberately NOT
    a 24h timer: a tick the same length as the cache window drifts against it,
    and landing a millisecond early means waiting nearly two days.

    The notice itself was one dim 10px line in `HostHeader`, among other dim
    metadata, on the reasoning that `paddock update` is "something the operator
    runs when they feel like it, not an alarm". That reasoning was right and the
    placement was wrong: a line the colour of its neighbours is not read, it is
    skipped. It is now `ReleaseBanner`, and the old line is GONE rather than
    kept — two copies of one fact is how they drift.

    Dismissable, which no other banner in this app is, because of an asymmetry
    unique to this one: you **cannot act on it from the device you are reading
    it on**. `paddock update` runs on the host, which is by definition not the
    phone. A notice you can neither act on nor silence is how a dashboard
    teaches you to ignore banners, and the next one is the connection banner —
    which does mean an agent's state may be wrong right now.

    Dismissal is keyed by **version**, not a boolean. A boolean would make the
    first dismissal permanent and the feature would quietly stop existing.

17. **A same-origin gate on every write and on the `/ws` upgrade.** This is the
    fix decision 12 said it was not. That decision required
    `content-type: application/json` on the three settings routes, restoring the
    CORS preflight, and scaled itself honestly: "the pre-existing action routes
    are POST already and carry larger levers, so this is not new in kind. It is
    a floor, not a fix."

    Two holes were open, and they composed into one attack. `/ws` upgraded
    unconditionally — a WebSocket handshake is exempt from CORS entirely, so no
    preflight and no browser rule stood in the way — while `hubWebSocket.open`
    sends the whole snapshot on connect, so any page the operator visited could
    read every agent's name, id and screen from `127.0.0.1`. And
    `POST /api/agents/:id/text` types arbitrary text into a live coding agent
    while reading its body with `jsonBody`, which never inspects the content
    type: an `enctype="text/plain"` form posts syntactically valid JSON to it as
    a CORS-*simple* request, no preflight, no same-origin check. Read the ids off
    the socket, then type into the agent. On the loopback listener there is not
    even an Access session to borrow — decision 3 gives that port no
    authentication at all, which is correct for an operator on their own machine
    and no defence whatsoever against their own browser.

    `src/server/origin.ts` holds the rule as pure predicates, called from exactly
    two enforcement points: one Hono middleware in `routes.ts` that both
    listeners inherit with the app, and the `/ws` interception in `ws/serve.ts`,
    which is already the single shared definition of that upgrade. Neither is a
    per-route check, because the guard belongs to the **verb**: a future write
    route must be covered by existing, not by remembering to opt in.

    The allowlist itself is ONE thunk, built in `index.ts` and handed to every
    consumer — both apps' middleware and both listeners' upgrade — rather than
    derived where it is used. That is not tidiness: the first version derived it
    twice, once in the middleware from `settings`/`tunnelUrl` and once at the
    call site, and the gated listener's writes and its WebSocket upgrades
    consequently answered to DIFFERENT allowlists. A gate with a seam in it is
    the failure this repo keeps rediscovering, and `tests/origin-tunnel.test.ts`
    is what found this instance.

    Three asymmetries are deliberate, and each one is load-bearing.

    **GET and HEAD are not guarded.** Browsers omit `Origin` on same-origin
    GETs, so a guard there would have to accept a missing one and would gate
    nothing; a cross-origin GET cannot read the response anyway, since paddock
    sends no CORS headers. What guarding reads *would* achieve is breaking
    `/sw.js` and the app shell — decision 3's exact failure reached from a new
    direction.

    **A missing `Origin` passes a write but fails an upgrade.** Browsers always
    send it on a POST, so its absence means a non-browser caller, which carries
    no hostile page to act for; refusing would break every command-line use and
    buy nothing. Browsers also always send it on a WebSocket handshake —
    same-origin included, unlike a GET — so requiring it there costs a browser
    nothing and shuts out a non-browser reader. That is worth having, because
    herdr's control socket is a FILE whose permissions keep other local users
    out, while paddock's port is TCP and every uid on the host can reach it.

    **The host allowlist is opportunistic, and empty means inactive.** Writes
    require `Origin` to equal `Host`, which closes ordinary cross-site CSRF with
    no configuration at all. It cannot close DNS rebinding, where the browser is
    tricked into resolving `evil.example` to `127.0.0.1` so that `Host` and
    `Origin` *agree*. Catching that needs to know the deployment's real
    hostname, and paddock already does — `settings.publicUrl` plus a live
    `paddock tunnel` URL — so `publicHostsFrom` derives the allowlist from those
    and needs no new setting. But it is enforced only when non-empty. Making it
    unconditional would mean a named-tunnel operator who never set `publicUrl`
    loses the reply path, and `publicUrl` lives in the **Notifications**
    section: a Telegram convenience would silently become the difference between
    a working dashboard and a read-only one, for a reason no operator could
    guess. So knowing a public hostname buys rebinding protection on top;
    not knowing one costs nothing that already worked. Loopback is always
    allowed even against a populated list, or setting a public URL would break
    desk browsing and `make dev`.

    **This is not authentication and decision 3 still stands.** Nothing here
    identifies anybody. It asks the one question a browser cannot lie about —
    which page this request acts for — and no token is minted, held or checked.

    A refusal is reported on stderr, once per distinct `origin -> host` pair and
    at most 20 pairs, because the likeliest cause is not an attack but a
    misconfiguration. A dashboard that quietly stopped accepting replies would be
    unexplainable; unbounded logging from a caller who chooses the origin would
    be a flood. The message names the REMEDY, and `refusalReason` picks it,
    because the two causes need opposite fixes: `Origin` and `Host` disagreeing
    means a proxy is rewriting `Host`, while the pair AGREEING and being refused
    anyway means `publicUrl` names a hostname this deployment is not reached on.
    Telling the second operator to check their proxy would send them to a file
    that is already correct.

18. **The journal — flattened server-side, never mixed with reconstruction,
    menus stripped, prose only, no session id on the wire, quiet in the UI.**
    `POST /api/agents/:id/history` reads a harness's own session log so "Show
    earlier" can answer with what was actually said, instead of the client's
    best guess from screen snapshots. Six decisions went into it.

    **The journal is flattened server-side; the client only ever sees lines.**
    `journal/` returns text, and the terminal renders it the way it renders any
    other history — no per-harness knowledge crosses into `web/`. Same
    reasoning as `parsePrompt` living in `src/server/`: harness- and
    protocol-shaped assumptions stay on the server side of the socket. A
    structured-turns payload was considered, so a future conversation view
    could reuse the route unchanged, and rejected — it would put a second
    renderer, and per-harness rendering rules, in `web/`. Pushing history over
    the WebSocket was rejected too: it needs file watching and a per-agent
    buffer for every open pane, which is a lot of machinery for an affordance
    the operator taps.

    **Journal history and reconstruction never coexist for one agent.** Where
    a journal is readable it is the ONLY source above the live screen, and the
    reconstructed path (`web/history.ts`) is switched off for that agent.
    Where one is not, nothing changes from before this feature. Two sources
    for one range means reconciling overlapping text produced by two different
    mechanisms — guesswork of exactly the kind this feature exists to remove.

    **One continuous scroll, with menus stripped from journal lines.** Journal
    text joins the buffer above the live screen with no labelled divider, and
    that cost is stated plainly: those lines are a RECONSTRUCTION RENDERED AS
    PROSE, and will not look like the live screen below them — they cannot
    reproduce the box drawing and colour the agent actually painted. That
    sharp edge is cosmetic and accepted. A different one is not: a journal
    turn can contain an old prompt menu — `❯ 1. Yes / 2. No` — which, blended
    directly above the live screen with no divider, reads as the question
    being asked NOW. `prompt-parse.ts` already records this exact failure
    mode in its own scoping comment (a marker left on an already-answered
    question reappearing as the live menu's selection), so cursor markers and
    option rows are stripped from journal-derived lines before they ever
    leave the server (`stripMenu` in `src/server/journal/text.ts`). Only the
    live screen may ever render a selectable menu; the client additionally
    never treats a journal line as a source of option buttons — those come
    from `/prompt` alone.

    **Prose is served; tool output is not.** The journal holds far more than
    the screen ever showed: every file the agent read, every command's
    output, any secret that passed through either. paddock has no
    authentication of its own (decision 3), so what this route serves is
    bounded at the source rather than at the gate. Kept: assistant text, and
    user text the operator actually typed. Summarised: a `tool_use` becomes
    one line (`▸ Bash · <hint>`). Dropped entirely: every `tool_result`,
    subagent traffic, and thinking blocks.

    **The session id never reaches the browser.** `adapter.ts` maps
    `agent_session` into a server-side map of `agentId → session ref`; the
    wire type `Agent` gains exactly one field, `hasJournal: boolean`, which is
    all the UI needs to choose a history source. A session id is a filesystem
    key, and the browser has no use for one paddock could not itself resolve.

    **A missing journal is quiet in the UI and loud on the host.** The
    operator sees the old behaviour, not an error: falling back to
    reconstruction is a working dashboard, and a red banner for a pane that
    never had a journal would be noise for the common case (a plain shell
    pane has no journal by definition). The server does not get to be quiet —
    `CLAUDE.md` forbids swallowing errors — so each cause (no adapter for
    this harness, no session ref from herdr, file missing, permission denied)
    logs once per agent on the host and travels in the response's `detail`;
    an unparseable line skips that line, never the whole file. On the client,
    `source: "reconstruction"` is read as this same signal, not a failure: it
    means "the server has no journal for this agent," arrives with
    `lines: []`, and the terminal falls back to its existing client-side
    reconstruction without surfacing anything to the operator.
