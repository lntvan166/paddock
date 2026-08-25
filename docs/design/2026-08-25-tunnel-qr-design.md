# A QR code for `paddock tunnel` — design

`paddock tunnel` prints a public URL and an eight-character pairing code. Both
have to reach a phone, and today both are typed by hand. This adds a QR that
carries the URL **and** the code, so scanning it opens the dashboard already
paired.

This is **Group B** of a three-part UX pass. Group A (CLI presentation) is on
`improve-ux`. Group C (Web Push) is unbuilt. **Nothing releases until all three
are done** — see "Sequencing" at the end.

---

## What the QR carries, and why that needed a ruling

The obvious payload is the URL with the code in a query string. It is also the
one payload this project has already forbidden, twice over:

- `CLAUDE.md`: *"Never put a payload in a GET query string. Query strings land
  in edge access logs."* A quick tunnel's every request passes Cloudflare's
  edge.
- `docs/decisions.md` decision 13, which established this gate, ends: *"Not a
  token, and not a precedent for one."* A code in a URL is a token in a URL.

### The argument that does NOT hold

It is tempting to say a QR carrying the code makes a photograph of the terminal
into a pairing. That reasoning is weak, and it should not be the reason for
anything: **the code is already on that screen**, one line from where the QR
goes. Anyone who can photograph the QR can photograph `4F7K-QP2M` and type it.

The real delta is narrower. A QR bundles the URL and the code into one
scannable artifact, so a shoulder-surfer gets both in a single camera motion at
a distance rather than one scan plus reading eight characters. Real, and modest.

### The argument that does hold, and the payload it selects

The log exposure is the durable one — a record in someone else's system rather
than a moment in a room. So the code goes in the **fragment**:

```
https://quiet-harbor-8f31.trycloudflare.com/#4F7KQP2M
```

A fragment is never sent in the HTTP request. It does not reach Cloudflare, it
does not reach paddock, and it appears in no access log anywhere. This
satisfies the query-string rule on the merits and not on a technicality — there
is no query string and no transmitted secret.

The raw eight characters, not the dashed form: it is shorter, and `normalise()`
accepts both.

What the fragment does cost: the code lands in the phone's browser history.
`CODE_TTL_MS` is ten minutes and five wrong guesses reissue early, so a history
entry is worthless almost immediately — but it is a real, small cost and it is
why this needs a decisions entry rather than a shrug.

### No new route

`decide()` in `gate.ts` already serves the pairing page for any path carrying
`Accept: text/html` when unpaired. `https://host/#CODE` requests `/`, gets the
pairing page, and the page's own script reads the fragment the server never saw.

---

## The hazard this introduces, and the two lines that contain it

An auto-submitting fragment is a **guess**, and a guess spends the attempt
budget. `routes.ts` already states the principle for the adjacent case:

> A malformed body is NOT a guess and must not spend the budget — otherwise
> anyone can burn codes without ever sending one.

Scan a stale QR, reload twice, and five wrong attempts reissue the live code —
invalidating the QR on the operator's screen by way of the feature meant to
help them. That is a self-inflicted denial of service on pairing.

Two mitigations, both in the inline script:

1. **Auto-submit at most once per page load**, and `history.replaceState` the
   fragment away the moment it is read. A reload then retries nothing, and the
   code stops sitting in the address bar.
2. **A rejected code stops.** Show the error with the field still filled, so the
   operator sees what was tried rather than watching invisible retries spend a
   budget of five.

What this does NOT defend, stated so nobody mistakes it for a claim: an attacker
who photographed the QR can burn the code deliberately. They could already POST
five wrong codes. Auto-pair adds no capability an attacker lacks — only an
accidental path for the operator to burn their own code.

---

## Where the code lives

### `src/server/qr.ts`, new

Owns the encoder and nothing else: text in, a boolean module matrix out, plus
the version and error-correction choices. It is the only file that knows a QR
library exists.

**Error correction level L, not the usual default of M.** Error correction
exists for smudged print and damaged labels; a terminal render is pixel-perfect.
L takes this payload from version 4 (33×33) to version 3 (29×29), and a smaller
matrix means physically larger modules on screen, which scan faster. Most tools
default to M and make terminal QRs needlessly large.

**Byte mode, unavoidably.** QR's compact alphanumeric mode would suit an
uppercase URL, but its character set has no `#`, so a fragment URL cannot use
it. Worth recording only because it looks like free savings until you check.

**Memoised on the payload string.** `render()` runs once a second and the
payload changes only when the code rotates, so a one-entry cache turns ~3,600
encodes an hour into six.

### The encoder is a dependency, and that is not a reversal

paddock hand-writes its eight icon glyphs and takes radix for focus traps. QR
encoding is the second kind of problem: Reed–Solomon over GF(256), BCH format
bits, and penalty scoring across eight mask candidates — roughly 400 lines of
bit-twiddling where a subtle error is invisible on reading.

The rule this looks like it violates does not apply. The `@fontsource-variable/geist`
refusal was about **76 KB of woff2 on a phone's slow link**, and
`tests/tokens.test.ts` guards the web bundle specifically. This encoder runs
server-side, renders to a terminal, and never reaches a browser; it is compiled
into a binary that already carries the Bun runtime.

Requirements on the choice: no transitive dependencies, a permissive licence, a
**pinned exact version** (no `^`, no `~`), and a golden-matrix test so an
upstream change cannot silently alter what scans. The implementation plan's
first task selects the package against those four requirements and records which
one it chose and why in its commit message — this design deliberately does not
name one, because naming a package whose current licence and dependency tree
have not been checked would be a claim, not a decision. A mis-encoded QR fails Reed–Solomon and simply does
not scan — it does not decode to a wrong URL — so the failure mode is visible
rather than dangerous.

### `display.ts` renders the matrix and never encodes

`DisplayState` gains `qr: QrMatrix | null`, where `QrMatrix` is
`{ size: number; isDark(row: number, col: number): boolean }` — the quiet zone
is the RENDERER's business, so `size` is the bare module count (29) and the
four-module margin is added here, not baked into the matrix. When non-null,
`render` turns it into half-block glyphs with the same `c()` helper it already
uses.

**One block order, both layouts**, so the QR does not move when the terminal is
resized:

```
  ✓ tunnel up · 23m 0s elapsed
    https://quiet-harbor-8f31.trycloudflare.com
                                                 ← blank
    [ QR, 19 rows ]
                                                 ← blank
    code 4F7K-QP2M · expires in 6m 12s
    paired: 1 device
    closes in 1h 4m                              ← only with --for
    ·········· below here is dropped when tight ··········
                                                 ← blank
  ⚠ a quick tunnel is public. …  (4 lines)
                                                 ← blank
  ^C to close
```

**Half-blocks, not full blocks.** A QR module is square; a terminal cell is
roughly 1:2. One module per cell gives a QR stretched 2× vertically, which
often will not scan. Two spaces per module fixes the aspect and doubles the
width to ~74 columns. Half-blocks (`█ ▀ ▄` and space) pack two vertical modules
into one cell via foreground and background: square modules, 37 columns, 19
rows. The final row of an odd-height matrix pairs against a blank row rather
than reading off the end.

**The quiet zone is four modules and is not negotiable.** It is the most common
reason a hand-made terminal QR fails to scan — it looks like wasted space, so
it gets trimmed, and scanners stop finding the finder patterns.

**Colours are forced, not inherited.** QR means dark-on-light. On a dark
terminal the light modules render dark and the QR is inverted; not every scanner
recovers from that. So the renderer sets an explicit black-on-white pair rather
than trusting the theme.

### `run.ts` decides whether there is a QR at all

Suppression lives in the caller, which passes `qr: null` when the terminal is
not a tty, `NO_COLOR` is set, or the terminal is under 37 columns.

`src/server/term.ts` is untouched and stays a dependency-free leaf.

---

## The invariant this structure exists to preserve

`tunnel-display.test.ts` asserts that stripping every escape from the coloured
render returns the plain one — colour decorates, never informs.

A QR is the one thing on screen whose colour is not decoration: forced
black-on-white is what stops it rendering inverted. Had `render(s, colour)`
drawn the QR only when `colour` were true, that assertion would break at once.

It does not, because **presence and polarity are separate inputs**. The matrix
arrives in `DisplayState`, identical in both calls; `colour` only decides
whether escapes are emitted around the glyphs. The glyphs themselves carry the
QR's information and survive stripping, so `strip(render(s, true)) ===
render(s, false)` holds exactly as before. `NO_COLOR` suppresses the QR by
making `run.ts` pass `null`, never by making `render` behave differently under
its colour flag.

---

## Layout

The block in `display.ts` is 13 lines, 14 when `--for` supplied a deadline. The
QR is 19 rows. Three regimes, chosen in `run.ts`:

| terminal | what renders |
|---|---|
| ≥ 34 rows, ≥ 37 cols | QR + the full block, unchanged |
| 26–33 rows, ≥ 37 cols | QR + state only, per the order above |
| smaller, or `NO_COLOR`, or not a tty | no QR; the block exactly as today |

The two thresholds, shown rather than asserted, both counting the deadline line
that `--for` adds:

```
full     6 state lines + 7 prose lines + 19 QR + 1 blank + 1 trailing = 34
trimmed  6 state lines +                 19 QR + 1 blank + 1 trailing = 26
```

The trailing row is the `\n` the draw appends; without it the block scrolls and
the once-a-second `\x1b[H\x1b[J` repaint tears.

The middle regime drops **prose, not state**. Out go the four-line
public-tunnel warning and the `^C to close` hint with their blank lines; the
warning survives in `paddock help` and `README.md`, and it is read once.
`paired:` and `closes in` stay, because they are the two things that change
while an operator watches.

**A default 24×80 terminal gets no QR.** Stated plainly rather than glossed:
even the trimmed layout needs about 26 rows. The alternative is cutting the
quiet zone to two modules to save two rows, and this design refuses that — a QR
that fits and does not scan is worse than no QR. Discoverability therefore lives
in the docs, not in a hint line there is no room for.

---

## Files

| file | change |
|------|--------|
| `src/server/qr.ts` | new — the only file that knows a QR library exists |
| `src/server/tunnel/display.ts` | `DisplayState.qr`; half-block rendering; the trimmed layout |
| `src/server/tunnel/run.ts` | decides QR presence from tty, `NO_COLOR`, and terminal size |
| `src/server/tunnel/gate.ts` | the fragment read, the single submit, the hash clear |
| `package.json` | one pinned QR encoder |
| `docs/decisions.md` | decision 22 |
| `README.md` | the QR, and that it needs ~26 rows |

## Tests

A QR's output is verifiable but not readable, so the tests split by what can
actually be pinned.

**`qr.ts`** — a golden matrix for one known URL, so a pinned library version
cannot silently change what scans; the expected version and ECC level asserted
directly; and a memoisation test proving one payload encodes once across
repeated calls.

**The half-block mapping is the real unit test** — a hand-built 4×4 matrix with
known dark cells, asserted against exact expected glyph lines. This is where an
inverted or transposed render is caught, and it needs no library at all. With
it, the odd-height case pairing its last row against a blank one.

**`display.ts`** — the existing strip-equals-plain assertion extended to a state
that HAS a QR, because that is the invariant this structure was designed
around. Plus layout selection at each threshold: full, trimmed, absent.

**`run.ts`** — `qr` is `null` for each suppression reason independently: not a
tty, `NO_COLOR`, too narrow.

**The pairing page**, reusing the happy-dom harness from Group A that mounts the
genuinely shipped inline script. Four cases: a fragment fills and submits; it
submits **exactly once** (this is the burn hazard, so it is asserted as a POST
count); the hash is cleared afterwards so a reload retries nothing; a rejected
code stops with the error visible rather than retrying.

## Documentation

`docs/decisions.md` gains **decision 22**, amending 13. Decision 13 says "not a
token, and not a precedent for one"; 22 records that a fragment-borne code is
now allowed, that it is allowed because a fragment is never transmitted and
therefore reaches no log, that it remains a credential with a ten-minute life,
and that the attempt budget is protected by submitting at most once per page
load. Decision 13 gains a pointer to it so the two are not read apart.

`README.md` documents the QR and its ~26-row requirement, so an operator on a
short terminal knows the feature exists and why they cannot see it.

---

## Sequencing

**Nothing releases until Group C is also done.** Group A is complete on
`improve-ux` (13 commits). This is Group B. Group C — Web Push — reopens
`docs/roadmap.md`'s retired entry; the argument on its side is recorded there
already, that push is the only mechanism landing a tap *inside* the installed
iOS PWA, where a Telegram tap always opens Safari.
