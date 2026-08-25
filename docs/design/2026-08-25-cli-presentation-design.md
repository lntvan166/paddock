# CLI presentation — design

Four fixes to what `paddock` prints, and one defect found behind the fourth.
None of them changes what any command *does*; all of them change whether an
operator can tell what it did.

This is **Group A** of a three-part UX pass. Groups B and C are named at the
bottom under "Sequencing and the release gate", which is load-bearing: nothing
here is released on its own.

---

## The four complaints, and what is actually wrong

**`paddock update` is silent for the length of an 83 MB download.** `runUpdate`
prints `0.1.0 -> 0.2.0`, then awaits `binRes.arrayBuffer()` — one await that
buffers the entire release asset into memory with no output — and then prints
`updated to 0.2.0`. Between those two lines there is nothing, for as long as
the operator's link takes. A stalled download and a working one are
indistinguishable.

**`paddock tunnel` prints `100h 30m`.** `human()` in `tunnel/display.ts` stops
at hours. So does `uptime()` in `lifecycle/commands.ts` — the same bug, written
twice, which is why fixing it once is not enough. Behind it sits a third
symptom: `parseDuration()` in `cli.ts` matches `^(\d+)([smh])$`, so `--for 2d`
is *refused*. The duration that cannot be read also cannot be requested.

**The pairing input does not format itself.** The field at `tunnel/gate.ts`
advertises `placeholder="XXXX-XXXX"` and then accepts eight ungrouped
characters, so what the operator types never resembles what the terminal
showed them.

**`paddock status` and `paddock doctor` flatten distinctions they have already
made.** `runStatus` has five outcomes and its own comment insists that
`unreadable` — "I could not read the state" — is a different fact from `none`,
"nothing is running". Both print as identical grey text. `doctorReport`
returns three exit codes that `install.sh` branches on; all three read the
same on screen.

---

## Where the presentation code lives

`term.ts` is deliberately a **leaf that imports nothing**, so every layer from
`herdr/socket.ts` outward may use it without inverting the dependency direction
in `docs/architecture.md`. Its value is that its functions are pure and
assertable with no tty. A stateful, carriage-returning progress renderer is the
exact opposite of that, and putting one there would make `herdr/socket.ts`
transitively depend on a progress bar.

So the split is **pure formatters in `term.ts`, one stateful sink beside it**.

### `term.ts` gains three pure functions

`duration(ms)` — largest two units, day-aware:

```
100h 30m  ->  4d 4h
3h 12m    ->  3h 12m
45m 20s   ->  45m 20s
30s       ->  30s
-5s       ->  0s
```

`4d 4h` and not `4 days 4h`: it matches the existing `3h 12m` idiom, and
`display.ts` redraws this string once a second in a live block, where a unit
that changes width makes the block jitter.

For the same reason the **second unit is always printed, even at zero** —
`96h` is `4d 0h`, not `4d`. This is what `human()` already does (`1h 0m`), and
a unit that vanishes at zero is a width change once an hour.

Two behaviour changes follow from having one function where there were two.
`uptime()` prints `0m` for anything under a minute and will now print `30s`.
`human()`'s five pinned values in `tunnel-display.test.ts` move to the new
name. Both are intended; both are asserted.

`bar(fraction, width)` returns a plain string. Pure, so `0`, `1`, an overshoot
and a `width` too small to draw are all assertable without a terminal. A
`fraction` outside `0..1` is clamped rather than rejected — a server that
overshoots its own `content-length` must not crash an update. Below a
`width` of 8 there is no room for a bar that means anything, so it returns
the empty string and the caller prints the percentage alone.

`glyph(kind)` returns `✓`, `✗` or `⚠`. **This is what makes the colour pass
legal.** `term.ts` and `display.ts` both carry an asserted rule — stripping
every escape from a painted line must return the plain line — so colour may
decorate and may never inform. A glyph survives stripping. `NO_COLOR`, a pipe,
a CI log, a screenshot in an issue and a colourblind reader all keep the
distinction; the colour is left doing only what it is allowed to do.

### `src/server/progress.ts`, new

The only file in the codebase that knows how to redraw a line: tty detection,
`process.stdout.columns`, the `\r` redraw, throttling, and the terminating
newline.

```ts
export interface Progress {
  start(label: string, total: number | null): void;
  advance(bytes: number): void;
  done(): void;
}
```

Two implementations. A bar when stdout is a tty and `NO_COLOR` is unset;
milestone lines otherwise.

The bar redraws **at most ten times a second**, and only when the rendered
string has actually changed. Both halves matter: an 83 MB download arrives in
far more chunks than that, and a redraw per chunk is a write syscall per chunk
for output no eye can follow. Width comes from `process.stdout.columns` read
per redraw, not captured once, so a resized terminal mid-download does not
leave a trailing tail of the previous, wider line. It is **injected into `runUpdate` the way `log`
already is**, so every test drives it headlessly and no test needs a pty.

`NO_COLOR` suppressing the bar as well as the colour is a deliberate reading,
not an oversight. Strictly the variable governs colour, and an uncoloured bar
would be defensible — but a redrawn line is motion, the environments that set
`NO_COLOR` are overwhelmingly the ones capturing output to a file, and one
switch covering both is one thing to reason about instead of two.

---

## `paddock update`, streamed

```
tty:
  paddock: 0.1.0 -> 0.2.0
  [==============>            ]  54%  45/83 MB  6.1 MB/s
  paddock: updated to 0.2.0

pipe / NO_COLOR / CI:
  paddock: 0.1.0 -> 0.2.0
  paddock: downloading paddock-linux-x86_64 (83 MB)
  paddock: updated to 0.2.0
```

**`SHA256SUMS` is fetched first, sequentially, and never mentioned on the
happy path.** Two separate rulings, and they must not be confused with each
other:

*Fetched first* because it is a few hundred bytes. A release published without
a listed checksum should fail before an 83 MB download, not after it. The cost
is that the combined `download failed (HTTP … for …, HTTP … for SHA256SUMS)`
message splits into two, which `build-update.test.ts` asserts today.

*Unmentioned* because a passing integrity check is not news to the operator.
**The failing one still is.** `CHECKSUM MISMATCH — keeping the current binary`
prints with both hashes exactly as it does now, and a non-ok HTTP on
`SHA256SUMS` prints exactly as it does now. Hiding a passing check is
presentation; hiding a failing one would be the "never swallow errors" rule in
`CLAUDE.md`, and this design does not do that.

**The body streams to `.paddock.new`**, hashing each chunk into
`Bun.CryptoHasher` as it passes and reporting `advance(chunk.length)`. This
drops the 83 MB in-memory buffer that `arrayBuffer()` holds today.

**The "nothing is written" guarantee is preserved unchanged.** The real binary
is untouched until after verification — only the temp file exists during the
download — and the mismatch branch removes that temp file on the same path the
write-failure branch already uses. The `chmod(0o755)` → `rename()` sequence
and the comment explaining that the chmod is the only thing making the
replacement executable both stay exactly as written.

`total` comes from `content-length`. When the header is absent the sink
degrades to a byte counter rather than inventing a denominator — the bar
becomes `45 MB · 6.1 MB/s` with no percentage, and the milestone line drops
its parenthetical to `downloading paddock-linux-x86_64`. `--check`
downloads nothing and never touches the sink at all.

---

## Durations everywhere

`human()` and `uptime()` are deleted. Their four call sites — status uptime,
tunnel elapsed, code expiry, `closes in` — point at `duration()`.

`parseDuration()` gains `d`, so `--for 2d` is accepted. `USAGE`'s `--for D`
line names the units. **No cap is introduced**: `--for 400h` is uncapped today,
and adding a limit now would be an unrelated policy change smuggled in behind a
formatting fix. Null stays a refusal for typos, which is the reason the
function returns null at all.

---

## The pairing input, and the defect behind it

### Auto-grouping

In the inline script in `gate.ts`: uppercase on input, keep only alphabet
characters, insert `-` after the fourth, cap at eight. The three cases where a
naive implementation breaks, and which the tests therefore cover: backspacing
*through* the dash must not re-insert it and trap the cursor; a pasted
`xxxx-xxxx` must not become `xxxx-xxxx-`; and iOS autofill via
`autocomplete="one-time-code"` sets the value without an ordinary keystroke.

### `normalise()` silently eats a character

The Crockford alphabet omits `I`, `L`, `O` and `U` precisely so that a code
read off a terminal and typed on a phone cannot be lost to `1`/`I` or `0`/`O`.
`normalise()` handles those four by **dropping** them:

```
normalise("O123-4567")  ->  "1234567"     // seven characters, not eight
```

`sameCode` then finds a length mismatch, compares the input against itself to
avoid leaking the length through a thrown exception, and returns false. The
operator is told `wrong code, 4 attempts remaining`. A character was eaten and
an attempt was spent, on exactly the confusion the alphabet was chosen to
prevent — and after five of them the code is reissued and the one on screen
stops working.

Crockford's specification says to decode `I` and `L` as `1` and `O` as `0`.
That mapping belongs in `normalise()`, server-side, where it is authoritative;
the client mirrors it only for what is displayed as the operator types.

**`U` stays dropped.** It is excluded from the alphabet to avoid an accidental
obscenity, not for visual confusion, and there is no digit it means.

---

## Colour on `status` and `doctor`

One rule across both surfaces:

| glyph | meaning |
|-------|---------|
| `✓` | decided yes |
| `✗` | decided no |
| `⚠` | could not decide |

```
✓ paddock 0.2.0 — running
    pid 4821 · port 8788 · up 3h 12m
✗ paddock — not running
✗ paddock — not running  (stale state for pid 4821, cleared)
✗ paddock — not running  (pid 4821 is now: sshd)
⚠ paddock — could not read state (EACCES)
```

`⚠` is the whole point. It marks `status`'s `unreadable` and `doctor`'s exit
code 2, which are the same fact — *undetermined* — reached by two different
routes, and which today are typeset identically to the outcomes they are not.

Colour decorates the glyph and dims the detail line; it carries nothing of its
own. **Exit codes are untouched** — `status` stays 0 running / 1 everything
else, `doctor` stays 0/1/2 — so anything scripting on them is unaffected.
`install.sh` branches on `doctor`'s exit code and never reads its text, so the
wording is free to change.

---

## Files

| file | change |
|------|--------|
| `src/server/term.ts` | + `duration`, `bar`, `glyph` |
| `src/server/progress.ts` | new — the only redrawing code |
| `src/server/update.ts` | streamed download, sequential sums, injected sink |
| `src/server/tunnel/display.ts` | `human()` deleted, calls `duration()` |
| `src/server/lifecycle/commands.ts` | `uptime()` deleted; `runStatus` glyphs |
| `src/server/cli.ts` | `d` in `parseDuration`, `USAGE` units |
| `src/server/doctor.ts` | glyph per outcome |
| `src/server/tunnel/gate.ts` | auto-grouping in the inline script |
| `src/server/tunnel/pairing.ts` | `normalise()` maps `I`/`L` → `1`, `O` → `0` |

## Tests

TDD, red first.

New: `term-duration.test.ts` (day rollover, the two-unit cap, negatives, and
`human()`'s five pinned values carried over); `progress.test.ts` (headless
sink, bar edges, absent `content-length`); `update-stream.test.ts` (a chunked
body hashes identically to the buffered path; a mismatch leaves the real binary
untouched and removes the temp file; `--check` never touches the sink);
pairing cases for `O`/`I`/`L` mapping and `U` still dropped; gate cases for
backspace, paste and autofill.

Updated: `tunnel-display.test.ts`, `lifecycle-status.test.ts`,
`doctor.test.ts`, `build-update.test.ts`, `cli.test.ts`.

`term.test.ts`'s strip-equals-plain assertions extend to cover every newly
painted line. That test is the reason the glyphs exist rather than colour
alone, and it must keep failing for anyone who tries to invert that.

## Documentation

`docs/gotchas.md` gains the `normalise()` character-eating entry — it is
exactly the shape that table exists for: a silent wrong answer, not a crash.
`README.md`'s `--for` mention gains the `d` unit.

---

## Sequencing and the release gate

**Nothing is released until all three groups are done.** This is a project
constraint, not a preference.

- **Group A** — this document.
- **Group B** — a QR code for `paddock tunnel`. Deferred because embedding the
  pairing code in the link collides with two written rules: `CLAUDE.md`'s "never
  put a payload in a GET query string — query strings land in edge access logs",
  and `display.ts`'s own on-screen warning that the code is "the only thing
  between this URL and keystroke access to every agent here". A QR carrying the
  code makes the URL the credential, and a photograph of the terminal a pairing.
  The QR image is trivial; the ruling is not, and it gets its own design.
- **Group C** — Web Push. `docs/roadmap.md` retired it in favour of Telegram;
  building it means reopening that entry rather than leaving the roadmap
  contradicting the plan. The argument on push's side is recorded there already:
  it is the only mechanism that lands a tap *inside* the installed iOS PWA,
  where a Telegram tap always lands in Safari. Needs a service worker (paddock
  ships none), a VAPID keypair, a permission prompt, a subscription store, and
  an answer to the `docs/gotchas.md` note that an expired Access session turns a
  service-worker fetch into an HTML login page rather than an error.
