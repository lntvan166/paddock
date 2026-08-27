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

   Bind address, added later: the default listener binds loopback *by default*,
   not unconditionally — `PADDOCK_HOST` can move it. That is not a softening of
   this decision, because it adds no authentication and removes none: there was
   never any. It exists because a container cannot use loopback at all. A
   published port is delivered to the container's own interface, so a
   loopback-bound listener refuses it, and `docker-compose.yml` shipped a
   container nothing could reach for exactly that reason.

   What protects a non-loopback bind is therefore NOT paddock. It is whatever
   sits in front of the port — the `127.0.0.1:` prefix on a compose publish, a
   container network, a firewall. paddock's only contribution is to say so: a
   non-loopback bind prints a warning naming the address and the fact that the
   port has no authentication behind it. Do not read this entry as permission
   to bind `0.0.0.0` on a workstation; on a shared network that hands every
   device full control of the operator's agents.

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
    `docs/design/2026-08-20-quick-tunnel-design.md`. **Amended by decision 22**,
    which admits exactly one narrow exception — a code in a URL *fragment*,
    which is never transmitted and so reaches no log. Read the two together.

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
    a journal is readable it is the ONLY source RENDERED above the live screen:
    the reconstructed buffer is not drawn for that agent, and the two are never
    concatenated or reconciled. It keeps ACCUMULATING in the background, and
    that is deliberate rather than an oversight — `history.ts` can only commit
    a line it watched scroll off the viewport, so a buffer switched off at the
    source would be empty at the exact moment it is needed: when a journal read
    answers `source: "reconstruction"` and the pane falls back. Merging costs a
    diff per poll and buys the fallback its content. Where no journal is
    readable, nothing changes from before this feature. Two sources DISPLAYED
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
    one line (`▸ Bash ×3 · Read timer.ts`), a run of the same tool collapsing
    to one `×N` token, and the hint drawn from a short allow-list of input
    fields — never `pattern`, since a search pattern routinely embeds the very
    secret being searched for. Dropped entirely: every `tool_result`, subagent
    traffic, and thinking blocks.

    "User text the operator actually typed" is narrower than "a `user` record
    whose content is a string", and the difference is measured rather than
    theoretical. The harness injects its own blocks into that same field —
    subagent `<result>` bodies, `<task-notification>`/`<output-file>` rows,
    `<system-reminder>`s, `<local-command-stdout>`, and the
    `<command-name>`/`<command-message>`/`<command-args>` triple a slash
    command expands to. Across the three largest session logs on the
    development machine, 733 string-content `user` records would have been
    served and 176 of them carried a `<result>` body. `<result>` is also how a
    SIDECHAIN's output reaches a record whose top-level `isSidechain` flag is
    absent, so that flag alone never closed the hole. Those blocks are
    stripped before anything is served, and a record stripping empties is
    dropped rather than rendered as a bare speaker row (`stripInjected` in
    `src/server/journal/text.ts`).

    A NAMED LIST is not enough on its own — hooks, plugins and future harness
    versions inject blocks with vocabularies nobody has listed — so a second,
    weaker rule runs alongside it: an element whose tag NAME is kebab- or
    snake-cased is machine output, because harness injections name their blocks
    that way while the markup in a typed message is HTML or JSX (`<div>`,
    `<AgentRow>`). This rule is an inference, not a contract, and it is
    deliberately the weaker of the two. It fires only on a BALANCED pair or a
    self-closing element, never on an unmatched bracket: `<old-name>` in
    "replace `<old-name>` with `<new-name>`" is a placeholder, and truncating
    at it deleted the operator's instruction. What it still costs is a message
    quoting a real custom element or framework tag with both halves present —
    `<router-view>…</router-view>` — which loses that element and everything
    between the tags. The named list, by contrast, may take an opener's whole
    remainder, because a truncated `<result>` really does mean the rest of the
    record is machine output.

    Absolute paths remaining in genuinely typed
    prose are NOT redacted: that is content the operator wrote and asked to
    see, and a scrubber over it would mangle real messages while doing nothing
    about the secret a person can type directly. The bound is on the KIND of
    content served, which is what "bounded at the source" means.

    A failure `detail` carries a FIXED PHRASE, never a stringified error. Node
    and Bun stringify a filesystem error with the path it failed on, and the
    route returns `detail` to the browser verbatim, so an ordinary miss on a
    rotated log would otherwise disclose the operator's home path — the same
    filesystem key the next decision keeps off the wire. The raw error goes to
    the host log, where the host can act on it.

    **The session id never reaches the browser.** `adapter.ts` maps
    `agent_session` into a server-side map of `agentId → session ref`; the
    wire type `Agent` gains exactly one field, `hasJournal: boolean`. That
    field is a HINT that this pane is worth trying — a property of the
    harness, decided once at reconcile time — not a guarantee any given
    request will succeed: the session ref can be missing or the file can be
    gone even when the harness itself has an adapter. The per-request
    `source` on each `/history` response is the actual answer, and
    `AgentTerminal` decides which history is "in play" for a pane from that
    answer, not from the static hint — an earlier version of this code
    rendered off `hasJournal` alone and stranded a pane whose every request
    came back `source: "reconstruction"` on permanently empty journal lines,
    never reading `history.settled` at all. A session id is a filesystem key
    regardless, and the browser has no use for one paddock could not itself
    resolve.

    **A missing journal is quiet in the UI and loud on the host — but only
    for that specific answer, never for a failed request.** The operator
    sees the old behaviour, not an error, when the server answers
    `source: "reconstruction"`: falling back to reconstruction is a working
    dashboard, and a red banner for a pane that never had a journal would be
    noise for the common case (a plain shell pane has no journal by
    definition). The server does not get to be quiet — `CLAUDE.md` forbids
    swallowing errors — so each cause (no adapter for this harness, no
    session ref from herdr, file missing, permission denied) logs once per
    agent on the host and travels in the response's `detail`; an unparseable
    line skips that line, never the whole file. On the client,
    `source: "reconstruction"` is read as this same signal, not a failure: it
    always arrives with `lines: []`, and the pane hands itself over to its
    existing client-side reconstruction permanently, without surfacing
    anything to the operator. A REJECTED request (a network blip, herdr
    itself unreachable) is a different thing entirely and is not silent: it
    is neither "no journal" nor "no more history", so it is surfaced the same
    way a failed key press or reply already is, the affordance is left in
    place for a retry, and the cursor is left exactly where it was so the
    retry asks for the same page rather than skipping ahead.

19. **Homebrew ships from a personal tap, not `homebrew/core`, and `paddock
    update` refuses under it.** Core is closed to paddock on two independent
    counts, and neither is a matter of effort. Notability: a self-submission
    by the repository owner needs 90 forks, 90 watchers or 225 stars
    (`Package-Acceptance-Policy.md`). Self-update: *"Software that updates
    itself conflicts with Homebrew's version and upgrade management"*
    (`Acceptable-Formulae.md`) — which is `paddock update`, exactly. The
    obvious escape hatch is closed by name: casks are for pre-built
    distributions, and *"Open-source command-line-only software normally
    belongs in homebrew/core as a formula built from source… A rejection from
    homebrew/core does not by itself make the software eligible for
    homebrew/cask."*

    herdr, by contrast, IS a core formula — built from a source tarball with
    `rust` and `zig` as build deps, bottled by Homebrew's own CI, at ~32k
    stars. That is the template if paddock ever qualifies: source build, no
    self-update. It is also why the tap formula carries `depends_on "herdr"` —
    a tap formula may depend on a core one, so brew can guarantee the thing
    paddock is useless without. No version constraint, because paddock's herdr
    check is directional and core never moves backwards.

    The bare name `paddock` is free in both core and cask and is deliberately
    left unclaimed elsewhere, so a future core submission can still have it.
    Until then the install is `brew install lntvan166/paddock/paddock`: since
    Homebrew 6.0.0 a non-official tap needs explicit trust, and the
    fully-qualified form grants it for that one formula in a single command.

    Under brew, `paddock update` refuses rather than warning-and-proceeding.
    Warning and proceeding would leave `brew info` lying about what is
    installed and let the next `brew upgrade` silently revert the operator —
    and disabling self-update is a precondition for core anyway, so a clean
    refusal is the same direction the project would have to move regardless.

20. **No embedded terminal emulator.** §16.3's shell pane was asked to do one
    thing: let the operator type into a shell from the phone. xterm.js was
    considered for it and refused.

    What it would buy is real emulation — cursor addressing, resize, the
    ability to run a full-screen program (`vim`, `htop`, anything that paints
    a screen rather than appending lines). What it costs is roughly 80 KB
    gzipped on top of a measured 102.45 KB bundle, in a project that rejected
    a 76 KB webfont on the grounds that it would be the single largest payload
    on a slow mobile link (decision 6), and that ships one JS chunk
    deliberately because an extra round trip costs more than the bytes it
    would save at ~250 ms RTT (decision 5). Typing `claude` or `ls` into a
    shell needs neither cursor addressing nor a full-screen program — the two
    things that actually justify an emulator's weight.

    What shipped instead is `pane.send_text` / `pane.send_keys`, the shell's
    mirror of the agent path's `agent.prompt` / `agent.send_keys` — wired into
    the existing reply box and keypad, behind the same closed `NavKey`
    allowlist recorded in `docs/gotchas.md` (never guess a keystroke; render
    real labels or fall back to raw output plus free text).

    **Corrected 2026-08-25.** This entry claimed the shipped solution covered
    "pressing Ctrl-C to stop one" and "type a command, interrupt one". It does
    not, and did not when the claim was written. `NAV_KEYS` in
    `src/shared/types.ts` is `up, down, left, right, enter, esc, tab, space,
    backspace`; `C-c` is outside it, and `tests/pane-input.test.ts` pins that
    `{key: "C-c"}` is refused with a 400 and never forwarded to herdr. So:
    **typing a command is covered. Interrupting one is not.**

    Widening that allowlist is a separate decision with its own reasoning —
    `NavKey` is closed precisely so the UI cannot smuggle a control sequence
    past it, and a bare shell is a larger lever than an agent's prompt. Do not
    add `C-c` to make this paragraph true again; write the entry that argues
    for it.

    Revisit only on a STATED need to run a full-screen program from a phone —
    not a general wish for higher fidelity, which is a bottomless ask against
    a bundle-size budget. And note that lazy-loading xterm.js behind a route
    guard so only an opened terminal pays for it would not dodge decision 5;
    it would reopen it, on the same one-screen app the "one chunk" reasoning
    was written for.


21. **The session tree is read on demand and never replicated into state.**
    `GET /api/spaces` calls `session.snapshot` and shapes it in
    `herdr/tree.ts`, per request. Nothing about spaces, tabs or panes-without-
    agents is held in `state/store.ts`, and no tree ever rides a WebSocket
    frame. When the tree changes, the hub sends a payload-free `tree-stale`
    and whoever is looking at the Spaces screen refetches.

    The reason is the delta path, not the read cost. `state/store.ts` computes
    the deltas that `notify/notifier.ts` rides: a transition into `blocked` or
    `done` is what arms a Telegram message. Putting the tree in that store
    would put "a pane was split", "a tab was renamed", "a shell opened" onto
    the same path — a browse feature reaching the notifier, where every new
    field is a new way to send an operator a message about nothing. Keeping it
    out means the notifier's inputs stay exactly the agent transitions it was
    designed for, and the Spaces screen cannot regress it.

    The costs are real and accepted. Reading a shell pane cannot be validated
    against the store — a shell is not in it — so `POST /api/panes/:id/*` pays
    a `session.snapshot` (~17-19 ms measured) per request, roughly ten times an
    agent poll's herdr work; `SHELL_MIN_REFRESH_MS` matches the RATE instead of
    the interval to compensate, and every shell keystroke pays it too. The
    screen is also honestly "as of" a moment rather than live (design §5.2).

    What would change it: a herdr event stream that reports tree changes
    field by field, so a tree could be maintained incrementally without
    polling — and even then it belongs in its own store, not the agent one, or
    the notifier is back in the blast radius. A cached tree with an
    invalidation window is NOT the answer: it makes a pane id's validation
    stale, which is the one thing the pane routes must not be.

22. **A pairing code may travel in a URL fragment, and only there.** Decision 13
    ends "Not a token, and not a precedent for one." This is that precedent,
    drawn as narrowly as it can be: `paddock tunnel` draws a QR encoding
    `https://<host>/#<code>`, so scanning it opens the dashboard already paired.

    A fragment is never sent in an HTTP request. It reaches neither Cloudflare
    nor paddock nor any access log, which is what distinguishes it from the
    obvious `?code=` and satisfies `CLAUDE.md`'s query-string rule on the merits
    rather than on a technicality. There is no transmitted secret.

    **Rejected, and the reasoning matters more than the conclusion:** it is
    tempting to argue that a QR carrying the code makes a photograph of the
    terminal into a pairing. That is weak and must not be the basis for
    anything — the code is ALREADY on that screen, one line above the QR, and
    anyone who can photograph one can photograph the other. The real delta is
    that a QR bundles URL and code into a single scannable artifact, so a
    shoulder-surfer gets both in one camera motion instead of one scan plus
    reading eight characters. Real, and modest. The log exposure is the durable
    difference, and it is the one this decision turns on.

    What it costs: the code lands in the phone's browser history. `CODE_TTL_MS`
    is ten minutes and five wrong guesses reissue early, so such an entry is
    worthless almost immediately — but it is a real cost and it is why this is a
    decision rather than a shrug.

    **The hazard it introduces, and the containment.** An auto-submitted
    fragment is a GUESS, and a guess spends one of five attempts — the same
    budget `routes.ts` already protects when it refuses to let a malformed body
    spend one. A stale QR reloaded a few times would burn the live code and
    invalidate the QR on the operator's own screen. So the page submits a
    fragment at most once per load, clears it with `history.replaceState`
    BEFORE attempting, and stops on rejection instead of retrying. This defends
    the operator from their own reload; it does not defend against an attacker
    who photographed the QR, who could already POST five wrong codes.

    See `docs/design/2026-08-25-tunnel-qr-design.md`.

23. **Web Push ships alongside Telegram, reversing a retirement.** v2 retired
    Web Push and shipped Telegram instead. That reasoning was not wrong and is
    not being overturned: push needs a service worker, a VAPID keypair, a
    permission prompt and a subscription store, where Telegram needs a bot token
    and an HTTPS POST and works on any device that already runs Telegram.

    What changed is that the counter-argument recorded beside it in
    `docs/roadmap.md` is now being acted on. **A Telegram tap cannot open the
    iOS PWA and only Web Push can:** iOS opens `https://` links in Safari even
    within an installed web app's scope — there are no `url_handlers`, no
    protocol handlers in Safari, and Universal Links need a native app — and
    Safari keeps a storage container separate from the Home Screen app, so a
    Telegram tap can mean re-doing a Cloudflare Access login the PWA already
    holds. That is the entire case, and it is narrow: one thing, one platform,
    for people who have installed the app.

    **Telegram stays.** It needs no install, works on a desktop, and is the only
    thing that works at all before someone has added paddock to their Home
    Screen. The notifier fans out to both, and a failure in either cannot
    suppress the other — asserted in both directions, because the ORDER is not
    obvious: a Telegram rejection deliberately gets no retry and propagates out
    of `#fire`, so push is dispatched BEFORE that await and settled in a
    `finally`.

    **The payload keeps Telegram's content minimalism, for a different reason.**
    `composeMessage`'s comment named minimalism as the mitigation for Telegram
    being able to read messages. Push payloads are encrypted end to end under
    RFC 8291, so the push service cannot read them and that reason does not
    transfer — but a notification renders on a LOCK SCREEN, and `a.task` is
    agent-authored text that may carry a pasted credential. Same restraint, new
    justification; neither transport inherits the other's.

    **The crypto is hand-rolled, which is the opposite call to the tunnel QR's
    dependency (decision 22's design).** `web-push` fails the bar that took —
    MPL-2.0 and five transitive dependencies — and the reason the QR took one
    does not apply: Reed-Solomon is not in the platform, while ECDH P-256,
    ECDSA P-256, HKDF and AES-GCM all are. RFC 8291 §5 also publishes a worked
    example, so the encryption is verified against the standard's own ciphertext
    rather than against its first run.

    **The service worker registers no `fetch` handler.** See `docs/gotchas.md`:
    that is what keeps an expired Access session from turning a worker fetch
    into an HTML login page, and it narrows that hazard to the tap alone.

    **The keypair is generated once and never silently regenerated.** An
    unreadable `push.json` disables push and says so. A replacement keypair
    invalidates every subscription in existence with no symptom whatsoever.

    See `docs/design/2026-08-25-web-push-design.md`.

24. **Presence is keyed by connection and matched per device, and it governs
    push only, never Telegram.** A Safari tab and the installed PWA on one
    phone share a `deviceKey` but hold separate sockets and separate location
    hashes; keying presence by `deviceKey` would let whichever last spoke
    overwrite the other's entry, so suppression would flicker on which surface
    moved most recently. Each connection holds its own entry instead, and
    `viewers()` unions them — a device is viewing an agent if *any* of its
    connections is.

    Suppression then matches per **device**, not globally: if the phone is on
    the pane and a tablet is not, the tablet is still told. The cheaper global
    rule is right for one device and wrong for two, and paddock is built
    around more than one screen watching the same agents.

    **Push only.** A `deviceKey` identifies one browser; a Telegram chat can be
    read from a laptop, a desktop, or a second phone, so presence can make no
    claim about whether its reader is looking at anything. Suppressing
    Telegram on a phone's presence would silence the transport that exists
    precisely because it works where the PWA does not — decision 23's whole
    reason for shipping it.

    **Two cheaper designs were rejected, both on the same budget.** Deciding
    suppression inside `sw.js` via `clients.matchAll()` on push receipt needs
    no wire change, no shared contract, and no server state, and per-device
    correctness falls out for free because each device judges for itself. It
    was rejected on two counts: nothing is left holding the episode, so it
    cannot fire when the last viewer walks away — it silently becomes a drop
    rather than a deferral, the opposite of what withholding is supposed to
    do — and every suppression becomes a push that displays nothing, which is
    the behaviour WebKit counts against a subscription and can revoke it for.

    A silent clearing push — push on `blocked → working` with a flag telling
    `sw.js` to close the tag and render nothing, so the lock screen clears
    without the phone being touched — was rejected on the WebKit objection
    alone, arrived at from the other direction: it is still a push that
    displays nothing. A *visible* resolution push is WebKit-safe but costs a
    second buzz per resolution, which is the opposite of the request. A
    feature that spends the push subscription to save a buzz is a bad trade
    either way it is reached.

    See `docs/design/2026-08-26-notification-presence-design.md`.


25. **A theme changes hue, never meaning.** paddock offers Dracula, Gruvbox and
    Nord. Those are SYNTAX-HIGHLIGHTING palettes — their red means "string
    literal" — and paddock's is a SEMANTIC one, where red is spent on exactly
    one thing: an agent that has stopped and needs a person. So a theme sets
    the chrome, and may set a state colour ONLY as a legibility adjustment for
    its own ground. The meaning never moves.

    What forced the distinction, and it is not what the obvious design
    predicts: "themes change the chrome, the state colours stay fixed" is
    unsafe. paddock's dark state colours were tuned against `--bg: #08090a`, a
    near-black, and every popular palette uses a LIGHTER ground — measured,
    Dracula puts `--danger` at 4.25 and Nord at 3.73, both below AA, before
    anything is changed at all. Keeping the hexes is what breaks them.

    `tests/themes.test.ts` asserts AA for `--danger`, `--warn` and `--ok`
    against each theme's own `--bg`, **whether the theme overrode them or
    inherited them**. Inheriting is exactly how a theme drops below AA
    unnoticed, and no other test in the suite asserts a computed colour — the
    same blind spot that let `shadcn init` turn `--accent` near-white while
    1159 tests passed.

    A theme must not touch `--term-bg` / `--term-fg` — herdr sends the agent's
    own truecolor escapes, chosen for a dark terminal, so a light pane would
    render white output onto a light ground — or `--tile-*`, which carry their
    own backgrounds at ratios documented per hue. The audit refuses a block
    that does.

    Named themes do not follow the OS. That is inherent to a flat picker where
    each entry is one palette, and it is the right trade: a named theme is a
    deliberate choice, and Dracula has no light variant to switch to.

    See `docs/design/2026-08-26-theme-picker-design.md`.

26. **An attached image lands in a directory paddock owns, never the agent's
    working directory.** The upload route is the only code in paddock that
    accepts arbitrary bytes and writes them to disk, and decision 3 gives this
    listener no authentication of its own — so reachability IS authority here.
    Writing into the agent's `cwd` would be more convenient for the agent, which
    could then be handed a relative path, and it would make "anything that can
    reach paddock can write into your repository" true. It is not worth it: the
    agent reads an absolute path just as well, so the whole benefit was
    cosmetic while the cost was a write primitive aimed at a git working tree.

    Three refusals travel with that choice, and each replaces a default that
    would have been a guess. The TYPE is sniffed from the bytes rather than
    taken from `content-type`, because a declared type is a claim by the caller
    and this file is one a coding agent is then told to open. HEIC is refused
    even though it is what an iPhone camera writes — Safari converts a Photo
    Library pick to JPEG on upload, so it rarely fires, and when it does,
    refusing names the problem at the moment of attaching instead of letting the
    agent fail to open a file it cannot read. And the NAME is generated here,
    never the client's: a phone filename can collide, carry separators, or be a
    path.

    Cleanup runs on every write rather than on a timer. The directory only grows
    when an upload happens, so that is the moment growth occurs — and it reports
    into a log the operator is already reading, where a background sweep would
    fail at three in the morning unseen. Two bounds, because either alone leaks:
    age never touches thirty photos uploaded this afternoon, and a byte cap
    never touches one file forgotten for a year. One floor overrides the byte
    cap — nothing under an hour old is evicted for size — because a burst must
    not drop the image the operator is about to name, and an agent may re-read a
    path later in the same conversation.

    What this does NOT do is delete on removal: tapping a chip's ✕ withdraws the
    attachment from the composer, and the file waits for the prune. Deleting it
    then would need paddock to delete files on demand, which is a capability it
    has never had and which this feature did not earn.

27. **The terminal screen tracks the keyboard inset, reversing decision-by-comment
    in `keyboard-inset.ts`.** That module's own note excluded the terminal's
    reply box from the inset it publishes for sheets, on the grounds that the
    terminal "is NOT in a fixed sheet and whose layout must not move when the
    keyboard opens". The first half was wrong and the second half was the wrong
    trade.

    `.term` IS `position: fixed; inset: 0`. On iOS the keyboard overlays the
    layout viewport rather than shrinking it, so a fixed shell keeps its foot
    underneath the keyboard and the reply row at that foot is typed into blind —
    the identical failure that module documents for sheets.

    It appeared to work because Safari shifts the VISUAL viewport to reveal a
    focused field. That reveal is a heuristic computed against the layout as it
    stands at the moment of focus, so focusing during mount — transcript still
    painting, reply field still sizing itself — leaves it computed against a
    layout that then changes. Reported from a phone as "quick focus hides the
    UI, opening slowly works well", which is the shape of a correctness
    guarantee resting on something that only usually fires.

    So the layout moves after all, and the movement is the fix rather than the
    cost: the transcript gets shorter while the keyboard is up, which is what
    every messaging app does and is plainly better than typing blind. The lift
    is declared AFTER the shared `position: fixed; inset: 0` rule, because
    `inset` sets `bottom` and a lift declared earlier loses to it — the same
    cascade mistake that had just left the reply field's own text against its
    top edge.
