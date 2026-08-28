# Opening a file from the phone

**Status:** approved in conversation, not yet built.
**Date:** 2026-08-28.

## The problem

An agent generates something to look at — an HTML design page, a PDF, a chart —
and the operator cannot see it. They are away from the machine, which is the
entire premise of paddock, and the file sits on a disk they are not near.

The workaround until now has been publishing to a hosted artefact service, and
it does not survive contact with reality: it needs an account the operator is
not signed into from the phone. So the artefact exists, is finished, and is
unreachable by the one person who asked for it.

paddock already has the two things this needs — it knows the agent, and it has a
tunnel to the phone. What it has never had is any way to hand over a file.

## What this is not

- **Not a file browser.** No tree, no directory listing, no navigation. You open
  a path you already have.
- **Not an editor.** Read only, in every sense: nothing here writes.
- **Not a preview pipeline.** paddock does not convert, thumbnail or transform
  anything. It serves the bytes and lets the browser render them.

## Scope: which files can be opened

**Any path, unrestricted.** No allowlist of types, no denylist of locations, no
containment root.

The operator's explicit decision, taken after the alternatives were put to them,
and recorded here rather than left implicit — a future reader would otherwise
assume it was an oversight and "fix" it.

**What was put to them.** paddock's listener has no authentication of its own —
`docs/decisions.md` decision 3 — so reachability IS authority. An unrestricted
file route means the following are fetchable by anything that can reach the
tunnel: `~/.config/paddock/settings.json` (the Telegram bot token),
`~/.config/paddock/push.json` (the VAPID private key), `~/.cloudflared/`
credentials, `~/.ssh/`, and any `.env`. Three narrower options were offered — a
type allowlist plus a credential denylist, a type allowlist alone, and a
session-scoped time bound — and each was declined in favour of the unrestricted
route.

**Why that is defensible, and it is not "the owner accepted a risk".** paddock
can ALREADY read any file the process can read, and has been able to since v2.
`POST /api/panes/:id/text` types into a shell pane (`pane.send_text`) and
`/api/panes/:id/key` presses Enter — so anything that can reach paddock can run
`cat <any path>` and read the result in the transcript. Where there is no shell
pane, `agent.prompt` can ask an agent to do the same.

So a file route grants NO new capability. It is a convenience over a capability
the product already ships, and one it must ship: typing into an agent is the
whole point of paddock, and `docs/decisions.md` decision 3 already states that
anything reaching this port "can read every agent's screen and type into them".
A denylist here would have been theatre — it would refuse `settings.json` at one
route while the pane beside it printed the same bytes on request.

One honest difference: BINARY files. Getting a PDF out through a terminal pane
needs base64 gymnastics, so this route makes binary retrieval materially easier
rather than merely more convenient. That is the only genuine widening, and it is
small next to the text case being already open.

**The axis this does NOT settle**, and which matters more than the file set:
*who can reach the route*. A NAMED tunnel puts Cloudflare Access in front, so an
identity check happens before any request reaches paddock. A QUICK tunnel is a
public URL whose only gate is a rotating ten-minute pairing code, and `README.md`
already calls it "a try-it path, not a deployment". This feature makes that
distinction sharper, and the implementation should say so where the operator
will see it rather than only here.

An earlier draft of this design enforced "only paths an agent printed" by having
the server remember paths it saw in output. It was dropped as complexity the
operator did not want. Note what that means: the browser names the path, so the
bound is not "what an agent produced" but "what anything reaching paddock asks
for". The two were never equivalent and the difference is written down here so
nobody re-derives the narrower claim from the feature's name.

## Architecture

### Two routes, because a path may not travel in a URL

`CLAUDE.md` forbids payloads in GET query strings: they land in edge access
logs. A file path is exactly such a payload, and a path segment is logged just
as a query string is — so neither `?path=` nor `/api/files/%2Fpath%2Fto%2Ffile`
is acceptable.

    POST /api/files        { path }        -> { id }
    GET  /api/files/:id                    -> the bytes
    GET  /api/files/:id/download           -> the bytes, as an attachment

The POST carries the path in a body, where the existing rule already puts
payloads. The GET carries an opaque id, which is meaningless in a log — and a
GET is required because an `<iframe src>` and a download link cannot be POSTs.

`id` is random and server-issued. The map lives in memory, is capped, evicts
oldest-first, and dies with the process. It is not a capability to be shared: it
is only shorter than the path.

### The response, and the one header that matters

    Content-Type:               derived from the EXTENSION, `application/octet-stream` when unknown
    Content-Security-Policy:    sandbox
    X-Content-Type-Options:     nosniff

`Content-Security-Policy: sandbox` as a RESPONSE HEADER is the load-bearing
part, and it is not the same as `<iframe sandbox>`.

The iframe attribute protects the page that embeds it. The header protects
against the URL being opened directly — which anyone can do, since the id is in
the address bar of the viewer. Without it, an HTML file served from paddock's
own origin is same-origin with paddock: it can read `localStorage`, call
`/api/agents/:id/text` with the browser's credentials, and drive the operator's
agents. That is a worse outcome than reading any single file, and it is reachable
from a page an agent generated after reading a poisoned README.

With the header the response is forced into a unique opaque origin. It renders;
it can reach nothing.

Derived from the extension, deliberately unlike `uploads/store.ts`, which
sniffs the BYTES. That route accepts what a stranger's phone sends and hands it
to an agent; this one reads a file the operator already has and hands it to
their own browser, where being wrong costs a bad render rather than a bad file
on disk. `nosniff` then stops the browser second-guessing it — a text file the
browser decides looks like HTML would otherwise become HTML.

### Demo mode omits the route entirely

`--demo` must not serve host files, for the same reason it omits `readCommands`
and `saveImage`: README screenshots are taken in that mode, and a demo that
served a real file would put the operator's own filesystem into an image bound
for a public repository. Absent, the route answers 404 and means it.

## The viewer

One screen, reached by tapping a path or by an explicit open.

| What it is | How it renders |
|---|---|
| `.html` | sandboxed iframe |
| `.pdf` | sandboxed iframe — iOS renders PDFs natively |
| `.png .jpg .jpeg .gif .webp .svg` | inline image |
| `.md .txt .json .csv .log` and other text | monospace text, no highlighting |
| anything else | download only, with the reason said |

**Download is always available**, whatever the type, because "or download it if
I want" was the operator's own framing and because it is the escape hatch when a
render is wrong.

**Failures are said, not swallowed.** A path that does not exist, a directory, a
permission error and a file too large each get their own sentence. "Could not
open" for all four would send the operator to check the wrong thing — the same
reasoning `startup-errors.ts` already applies to a refused boot.

**A size ceiling.** Large files are refused rather than streamed to a phone over
a tunnel; the refusal names the size. The ceiling is a constant, not a setting.

## Tapping a path in the transcript

Path-shaped tokens in the terminal become tappable and open the viewer. This is
the only change to the terminal itself.

- Absolute paths (`/…`) and `~/…`, plus `file://` URLs.
- A token that is not a real file still linkifies; tapping says it is not there.
  Deciding in advance would mean a filesystem round trip per token per poll.
- Linkification happens in the ANSI render path, which today emits inert spans.

**This does not narrow anything.** Since the browser may name any path, tapping
is a convenience over typing, not a restriction.

## Testing

Pure and route-level tests carry this; the viewer is thin.

- **Route:** an unknown id is 404; the id is opaque and not the path; the map
  caps and evicts; `download` sets `Content-Disposition` and the plain GET does
  not; the demo build has no route at all.
- **Headers:** every served response carries `Content-Security-Policy: sandbox`
  and `nosniff`. This is the test that matters most — losing that header is
  silent, and the consequence is an agent-authored page with paddock's API.
- **Type mapping:** extension to content-type and to render mode, including the
  unknown case falling to download.
- **Failures:** missing, directory, unreadable and oversized each produce their
  own distinguishable message.
- **Linkification:** absolute, `~` and `file://` tokens become links; ordinary
  prose containing a slash does not — the same rule the slash-command trigger
  already uses, and the same regression it guards.

happy-dom performs no layout and does not render iframes, so the viewer's
rendering is verified in a browser rather than asserted in the suite, as with
the keyboard inset and the composer alignment.

## Documentation owed

- `docs/decisions.md`: the unrestricted scope, its reasoning, and what it
  accepts. This is the entry that stops it being read as an oversight.
- `docs/architecture.md`: the module table, and the routes.
- `README.md`: one line, since it is user-facing — and it should say what the
  scope is rather than only that the feature exists.

## Open questions

1. **Should the quick-tunnel case behave differently?** Not decided. The options
   are: nothing (the operator knows), a warning where they will see it, or
   refusing to serve while a quick tunnel is up. This is the axis the scope
   decision did not settle, and it is the one with teeth.
2. ~~Where does the viewer live in the UI?~~ **Decided: its own route**,
   `#/file/:id`, alongside `#/agent/:id` which already exists. It survives a
   reload, the back control returns to the agent, and it can be handed to
   another device. A sheet would keep the transcript underneath, which is worth
   less than surviving a reload on a phone that backgrounds tabs.
