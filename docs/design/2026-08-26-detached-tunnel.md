# Detached tunnel — design

**Status:** approved 2026-08-26.
**Supersedes nothing.** `--publish-running` (formerly `--attach`) is a different
axis and stays exactly as it is; see §6 for how the two compose.

## 1. What this is for

`paddock tunnel` holds the terminal. It draws a live display — URL, pairing
code, countdown, QR — and closes when you press `^C`. That is right for
"publish this for the next twenty minutes while I watch", and wrong for the
case paddock is actually built around: a phone, away from the machine, for as
long as the work runs.

`paddock start` already detaches the dashboard. The tunnel has no equivalent,
so the one component you need while away from the terminal is the one that
requires you to keep it open.

This adds `paddock tunnel --detach`, and the command that makes it usable.

## 2. The real problem: the code is minted, not stored

Detaching a process is mechanical — `spawnDetached` in `lifecycle/commands.ts`
already does it, with `setsid()` and a log file. The hard part is that
**everything the operator needs from a tunnel lives only on the display it no
longer has.**

Specifically the pairing code, and it is worse than a value that needs copying
somewhere. `Pairing.current()` (`tunnel/pairing.ts`) **mints lazily**:

```ts
if (this.#now() > this.#code.expiresAt) this.#code = this.#mint();
```

The code advances when something asks for it. In the foreground that is the
redraw loop, several times a second, so the display is always current. A
detached tunnel has no redraw loop, so nothing advances it — and a code copied
out to a file is a snapshot that may already be past `expiresAt` by the time
anyone reads it. A reader cannot mint; only the process holding the `Pairing`
can.

**So the operator must be able to ask the running tunnel, not read its
leftovers.** That single fact decides the rest of this design. It also buys
something better than parity with the foreground: asking mints on demand, so a
code handed over is always at the *start* of its TTL rather than somewhere in
the middle of it.

## 3. Two files, not one

Tunnel facts go in **`paddock.tunnel.json`**, beside `paddock.state.json` and
never inside it.

`recordState` is **first-instance-wins per config dir**, and its own comment
carries the scar: a second instance silently taking over the first's record
made the instance actually holding the port untrackable for the rest of its
life, and the operator's report was "always have this issue". A tunnel run with
`--publish-running` exists *specifically* to run beside a recorded paddock, so
it could never claim that file — and must not try.

```ts
export interface TunnelState {
  pid: number;
  /** `ps` identity, captured exactly as PaddockState.args is. */
  args: string;
  /** The public URL. Not a secret — it is what you send someone. */
  url: string;
  /** Absolute path of the control socket. See §4. */
  control: string;
  /** Upstream port when publishing a running paddock, else null. */
  publishing: number | null;
  startedAt: number;
  /** The `--for` deadline, or null for "until stopped". */
  until: number | null;
}
```

**No pairing code in this file, at any point.** Not because the config dir
cannot hold a secret — it is `0700` and already holds the Telegram bot token
and the push VAPID private key at `0600` — but because a stored code is the
snapshot §2 rules out. The reason is correctness; the reduced exposure is a
bonus, not the argument.

Written with `writeState`'s existing tmp-then-`rename`, so a reader never sees
half a file, and reused rather than re-implemented.

## 4. The control channel is a unix socket

`paddock pair` asks the tunnel for the current code over a unix domain socket
at `~/.config/paddock/tunnel.sock`.

**Why not a route on the gated listener.** This was the first design and it is
unenforceable. `cloudflared` runs on the same box and connects to that listener
over loopback, so a real local client and a request that arrived from the public
internet have the *same peer address*. `x-forwarded-proto` and `x-forwarded-for`
cannot rescue it either — `gate.ts` documents at length that they are
client-influencable and must gate nothing but a cosmetic warning. A
"localhost-only" route there would be a promise, not a control, and the thing it
would leak is the pairing code itself.

**Why not a second TCP port.** It would work — bind `127.0.0.1` only, never
point `cloudflared` at it — but it invents a third port to collide with after
8787 and 8788, and gates access on nothing but "who can reach loopback", which
on a shared box is every uid.

**A unix socket has no exposure path to close.** No port, nothing for
`cloudflared` to be misconfigured toward, and access is filesystem permissions
in a directory that is already `0700`. paddock already speaks to herdr this way,
so the pattern is the codebase's own. Verified on Bun 1.3.14: `Bun.serve({unix})`
and `fetch(url, {unix})` both work.

One request, one answer:

```
GET /code  ->  { code: "H2FK-68CG", expiresAt: 1756..., url: "https://…" }
```

`GET` carries no payload here, so the project's no-payloads-in-query-strings
rule is satisfied; the code is in the response body, and this socket writes no
access log.

## 5. Commands

**`paddock tunnel --detach`** — spawns itself detached, waits for the child to
publish a URL and write `paddock.tunnel.json`, prints the URL, code and QR once,
and returns the shell. Success is reported only once the state file exists and
the socket answers, mirroring `runStart`'s rule that a spawn is not a success
until the thing is actually serving.

**`paddock pair`** — the command for "I need to get a phone on this". Reads
`paddock.tunnel.json`, verifies the pid, asks the socket, and renders URL, code,
expiry and QR. Works identically against a foreground tunnel, which also serves
the socket.

`qrMatrix(text)` and `qrLines(matrix, colour)` are already pure exported
functions and the payload is already `${url}/#${code}`, so rendering the QR here
is two calls and no new drawing code.

**`paddock status`** — one added line when a tunnel is up:

```
✓ paddock 0.8.6 — running
    pid 1234 · port 8787 · up 2h 14m
✓ tunnel — https://<sub>.trycloudflare.com
    pid 1310 · up 2h 12m · `paddock pair` for the code and QR
```

Not the QR itself. `status` is a one-glance command whose exit code is
scriptable; twenty-five lines of QR belongs in the command you run when you
actually want to scan something.

**`paddock stop`** — stops a detached tunnel as well as the dashboard, and
removes the socket and the tunnel state file.

## 6. How `--detach` and `--publish-running` compose

Orthogonal, and the 2×2 is the whole surface:

| | serves the dashboard itself | publishes the paddock already running |
|---|---|---|
| **holds the terminal** | `paddock tunnel` | `paddock tunnel --publish-running` |
| **detached** | `paddock tunnel --detach` | `paddock tunnel --publish-running --detach` |

The bottom-right cell is the one the operator wants most often and the reason
both flags exist: a dashboard already up with its notifier, published from the
background, terminal free.

## 7. Staleness

Reusing `checkState`'s discipline rather than restating it: a tunnel state file
whose pid is gone is **stale**, and one whose pid now belongs to something else
is a **mismatch**. Both are reported and cleared, and neither is reported as
"no tunnel" — `status` distinguishing "nothing is running" from "I could not
tell" is an existing rule in this module and applies unchanged.

The socket gets one extra failure mode: a state file that looks live but a
socket that refuses to connect. That is reported as itself — a tunnel process
that is up but not answering — and never silently as "no tunnel running".

## 8. Not in scope

- **No code delivery by Telegram or push.** It was considered: the rotated code
  arriving on the phone would mean never touching the terminal again. It also
  puts a live credential into a chat log that outlives its TTL by years, on a
  transport whose whole purpose here is to be readable at a glance. If it is
  built later it belongs behind its own decision, not folded into this one.
- **No named tunnels.** `docs/deploy-cloudflare.md` covers those; this is the
  quick-tunnel path only.
- **No changes to `--publish-running`**, the gate, `decide()`, or the proxy.

## 9. Failure table

| Situation | Behaviour |
|---|---|
| `--detach` while a detached tunnel is already recorded | Refuse, naming its pid and URL |
| `--detach` and the child dies before publishing | Report it, with the tail of `paddock.log` |
| `--detach` with an unwritable config dir | Refuse before spawning, as `runStart` does |
| `paddock pair` with no tunnel state file | "no tunnel is running", exit non-zero |
| `paddock pair`, state file live, socket refuses | Say exactly that; do not report "no tunnel" |
| `paddock pair`, pid gone | Report stale, clear the file, exit non-zero |
| `paddock stop` with a tunnel but no dashboard | Stops the tunnel, says so |
