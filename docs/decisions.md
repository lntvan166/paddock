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
