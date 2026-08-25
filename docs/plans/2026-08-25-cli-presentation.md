# CLI presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `paddock update`, `tunnel`, `status`, `doctor` and the pairing form report what they are actually doing, and fix a live character-eating bug in the pairing code path.

**Architecture:** Pure formatters (`duration`, `bar`, `glyph`) go into `src/server/term.ts`, which must stay a dependency-free leaf. The one stateful, carriage-returning renderer lives alone in a new `src/server/progress.ts` and is injected into `runUpdate` the way `log` already is. Colour continues to be applied at the print boundary by `paint()`, never inside message builders, so every builder stays pure and assertable with no tty.

**Tech Stack:** Bun, TypeScript, `bun:test`, happy-dom (for the one DOM test), Hono (untouched here).

**Spec:** `docs/design/2026-08-25-cli-presentation-design.md` (committed at `4f20436`)

## Global Constraints

- **TDD, red first.** Every task writes a failing test, runs it to see it fail, then implements.
- **`make test`, never bare `bun test`.** The suite builds the UI and regenerates embedded assets first.
- **`make check-clean` before EVERY commit.** Public-repo scanner; if it fails, fix the content, never the denylist.
- **`make check` (`tsc --noEmit`) must pass.** There is no linter.
- **`src/server/term.ts` imports nothing.** It is a leaf so every layer from `herdr/socket.ts` outward may use it without inverting `docs/architecture.md`'s dependency direction. Do not add an import to it in any task.
- **Colour decorates, never informs.** `tests/term.test.ts` asserts that stripping every escape from a painted line returns the plain line. Extend that assertion to every newly painted line; never make a distinction that exists only in colour.
- **Never swallow errors.** No empty catch blocks, no `2>/dev/null`. A cleanup failure is announced.
- **Exit codes are contracts.** `status` stays 0 running / 1 everything else. `doctor` stays 0 compatible / 1 incompatible / 2 undetermined — `install.sh` branches on it.
- **Invented names only** in fixtures and examples. No real hostnames, home paths, usernames.
- **Every commit message ends with the standard `Co-Authored-By:` trailer.** It is
  deliberately NOT written out in this file: `check-clean` treats any email
  address in a tracked file as a leak, and it is right to — see the commit
  blocks below, which stop short of it for that reason.

## File Structure

| file | responsibility | task |
|---|---|---|
| `src/server/tunnel/pairing.ts` | pairing codes; `normalise` is the authoritative input mapping | 1 |
| `src/server/term.ts` | pure presentation formatters + the print boundary | 2, 4, 5 |
| `src/server/tunnel/display.ts` | the tunnel block; consumes `duration` | 2 |
| `src/server/lifecycle/commands.ts` | lifecycle verbs; `runStatus` consumes `duration` + `glyph` | 2, 4 |
| `src/server/cli.ts` | argument parsing and `USAGE` | 3 |
| `src/server/doctor.ts` | the compatibility report; consumes `glyph` | 4 |
| `src/server/progress.ts` | **new** — the only code in the repo that redraws a line | 5 |
| `src/server/update.ts` | the updater; consumes an injected `Progress` | 6 |
| `src/server/tunnel/gate.ts` | the self-contained pairing page and its inline script | 7 |

---

## Task 1: `normalise()` stops eating characters

The Crockford alphabet omits `I`, `L`, `O` and `U` so a code read off a terminal cannot be lost to `1`/`I` or `0`/`O` — but `normalise()` handles them by **dropping** them, so `O123-4567` becomes seven characters, fails the length check, and is reported as a wrong code while spending an attempt. Five of those reissue the code on screen. This is a live bug on `main`; it is sequenced first so it is ready if the release gate moves.

**Files:**
- Modify: `src/server/tunnel/pairing.ts:33-38`
- Modify: `docs/gotchas.md` (append one row to the first table)
- Test: `tests/tunnel-pairing-codes.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `normalise(input: string): string` — unchanged signature, changed behaviour. Task 7 mirrors this exact mapping client-side and must not diverge from it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tunnel-pairing-codes.test.ts`:

```ts
// The alphabet omits I, L, O and U precisely so a code read off a terminal
// cannot be lost to 1/I or 0/O. Dropping them instead of decoding them ate a
// character, failed the length check, and spent one of five attempts — on
// exactly the confusion the alphabet was chosen to prevent.
test("a confusable character is decoded, not dropped", () => {
  expect(normalise("O123-4567")).toBe("01234567");
  expect(normalise("I234-5678")).toBe("12345678");
  expect(normalise("L234-5678")).toBe("12345678");
  expect(normalise("o123-4567")).toBe("01234567");
});

// U is excluded to avoid an accidental obscenity, not for visual confusion.
// There is no digit it means, so it stays dropped.
test("U stays dropped — it is not a confusable, it is an exclusion", () => {
  expect(normalise("U123-4567")).toBe("1234567");
});

test("the dash and the case are still presentation, and still dropped", () => {
  expect(normalise("4f7k-qp2m")).toBe("4F7KQP2M");
  expect(normalise(" 4F7K QP2M ")).toBe("4F7KQP2M");
});

// The mapping must be reachable through the real entry point, not only the
// helper: a code typed with an O on a phone must actually pair.
test("a code typed with O for 0 pairs", () => {
  const p = new Pairing({ bytes: () => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]) });
  const live = p.current().code; // "01234567"
  expect(live[0]).toBe("0");
  expect(p.attempt(`O${live.slice(1, 4)}-${live.slice(4)}`).kind).toBe("paired");
});
```

Ensure the file's import line includes `normalise` and `Pairing`:

```ts
import { ALPHABET, normalise, Pairing } from "@server/tunnel/pairing";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `make test 2>&1 | grep -A5 "confusable"`
Expected: FAIL — `expect("1234567").toBe("01234567")`, because the `O` is dropped.

- [ ] **Step 3: Implement the mapping**

Replace `normalise` in `src/server/tunnel/pairing.ts`:

```ts
/**
 * Crockford's own specification decodes `I` and `L` as `1` and `O` as `0`.
 * This used to DROP them, which is worse than either accepting or refusing
 * them: the input silently lost a character, failed the length check inside
 * `sameCode`, and came back as `wrong code, 4 attempts remaining` — spending
 * an attempt on the one confusion the alphabet was chosen to prevent, and
 * reissuing the code on screen after five.
 *
 * `U` is NOT here. It is excluded from the alphabet to avoid an accidental
 * obscenity, not for visual confusion, and there is no digit it means — so it
 * stays dropped, along with every other character that is not a code.
 */
const CONFUSABLE: Record<string, string | undefined> = { I: "1", L: "1", O: "0" };

/** The dash and the case are presentation. Anything else is dropped. */
export function normalise(input: string): string {
  let out = "";
  for (const ch of input.toUpperCase()) {
    const mapped = CONFUSABLE[ch] ?? ch;
    if (ALPHABET.includes(mapped)) out += mapped;
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `make test 2>&1 | tail -20`
Expected: PASS, whole suite green.

- [ ] **Step 5: Record it in `docs/gotchas.md`**

Append one row to the end of the first table (the one that starts `| Failure | Cause | Design response |`):

```markdown
| A pairing code typed correctly is reported as wrong, and five tries rotate it | `normalise()` DROPPED `I`, `L`, `O` and `U` rather than decoding them, so an `O` typed for `0` produced a seven-character input; `sameCode` found a length mismatch and reported `wrong code`, spending one of five attempts — on exactly the confusion the Crockford alphabet was chosen to prevent | `normalise()` decodes `I`/`L` → `1` and `O` → `0` per Crockford. `U` stays dropped: it is excluded to avoid an accidental obscenity, not for visual confusion, and means no digit. The mapping is server-side and authoritative; the pairing page mirrors it only for what it displays as you type |
```

- [ ] **Step 6: Commit**

```bash
make check && make check-clean
git add src/server/tunnel/pairing.ts tests/tunnel-pairing-codes.test.ts docs/gotchas.md
git commit -m "$(cat <<'MSG'
fix: a pairing code typed with O for 0 is decoded, not eaten

normalise() dropped I, L, O and U rather than decoding them, so an O typed
for 0 produced a seven-character input, failed sameCode's length check and
came back as "wrong code, 4 attempts remaining" — spending an attempt on the
one confusion the Crockford alphabet exists to prevent, and rotating the code
on screen after five. U stays dropped: it means no digit.
MSG
)"
```

---

## Task 2: one day-aware `duration()` where there were two hours-capped formatters

`human()` in `tunnel/display.ts` and `uptime()` in `lifecycle/commands.ts` are the same function written twice, and both stop at hours — which is why a tunnel up for four days reads `100h 30m`.

**Files:**
- Modify: `src/server/term.ts` (add `duration`)
- Modify: `src/server/tunnel/display.ts:19-25` (delete `human`, call `duration`)
- Modify: `src/server/lifecycle/commands.ts:83-88` (delete `uptime`, call `duration`)
- Test: `tests/term-duration.test.ts` (create), `tests/tunnel-display.test.ts` (update), `tests/lifecycle-status.test.ts` (update)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `duration(ms: number): string` exported from `@server/term`. Tasks 4 and 5 import from the same module but not this function.

- [ ] **Step 1: Write the failing test**

Create `tests/term-duration.test.ts`:

```ts
import { expect, test } from "bun:test";
import { duration } from "@server/term";

// The complaint this exists to fix: a tunnel up for four days read "100h 30m".
test("days roll over instead of accumulating as hours", () => {
  expect(duration(361_800_000)).toBe("4d 4h");   // 100h 30m
  expect(duration(86_400_000)).toBe("1d 0h");
  expect(duration(604_800_000)).toBe("7d 0h");
});

// Carried over verbatim from human()'s five pinned values in
// tunnel-display.test.ts, which this function replaces.
test("the cases human() pinned still read the same", () => {
  expect(duration(0)).toBe("0s");
  expect(duration(42_000)).toBe("42s");
  expect(duration(372_000)).toBe("6m 12s");
  expect(duration(4_320_000)).toBe("1h 12m");
  expect(duration(-5_000)).toBe("0s");
});

// At most two units, largest first. A third unit would make the tunnel block
// — redrawn once a second — change width as it counts down.
test("at most two units, largest first", () => {
  expect(duration(361_845_000)).toBe("4d 4h");   // the 45s is not shown
  expect(duration(4_332_000)).toBe("1h 12m");    // the 12s is not shown
});

// The second unit is printed even at zero, for the same reason: a unit that
// vanishes at zero is a width change once an hour. human() already did this.
test("the second unit is printed at zero", () => {
  expect(duration(345_600_000)).toBe("4d 0h");
  expect(duration(3_600_000)).toBe("1h 0m");
  expect(duration(60_000)).toBe("1m 0s");
});

// A clock that has passed its deadline says 0s, never a negative.
test("negatives clamp to zero", () => {
  expect(duration(-1)).toBe("0s");
  expect(duration(-86_400_000)).toBe("0s");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `make test 2>&1 | grep -B2 -A5 "term-duration"`
Expected: FAIL — `duration` is not exported from `@server/term`.

- [ ] **Step 3: Implement `duration` in `term.ts`**

Add to `src/server/term.ts` (no new imports — this file is a leaf):

```ts
/**
 * A span of milliseconds as a person would say it: at most TWO units, largest
 * first, day-aware.
 *
 *   100h 30m  ->  4d 4h
 *   3h 12m    ->  3h 12m
 *   45m 20s   ->  45m 20s
 *   30s       ->  30s
 *
 * There were two of these — `human()` in `tunnel/display.ts` and `uptime()` in
 * `lifecycle/commands.ts` — and BOTH stopped at hours, which is how a tunnel
 * up for four days came to report `100h 30m`. One bug written twice is why
 * this lives here rather than being fixed in place.
 *
 * Two units and not three: `display.ts` redraws this string once a second in a
 * live block, and a unit appearing or disappearing changes the block's width.
 * The second unit is printed even at zero (`4d 0h`, `1h 0m`) for exactly the
 * same reason — `human()` already behaved this way and it was right to.
 *
 * Negative input clamps to `0s`. A clock that has passed its deadline is at
 * zero, not in the past.
 */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/term-duration.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Delete `human()` and point `display.ts` at `duration`**

In `src/server/tunnel/display.ts`, delete the `human` function entirely and add it to the existing re-export line, so importers of this module keep working through one name:

```ts
import { formatCode } from "@server/tunnel/pairing";
// Re-exported: `useColour` moved to the `term.ts` leaf when hint output needed
// it too, and this module's importers already had it from here. `duration`
// replaces this module's own `human()`, which stopped at hours — see term.ts.
export { duration, useColour } from "@server/term";
```

Then add the import and replace all four uses inside `render`:

```ts
import { duration } from "@server/term";
```

```ts
    `  ${c("32", "✓")} tunnel up · ${duration(s.now - s.startedAt)} elapsed`,
```
```ts
    `    code ${formatCode(s.code)} · expires in ${duration(s.codeExpiresAt - s.now)}`,
```
```ts
  if (s.deadline !== null) lines.push(`    closes in ${duration(s.deadline - s.now)}`);
```

- [ ] **Step 6: Update `tests/tunnel-display.test.ts`**

Change the import to drop `human`:

```ts
import { render, useColour, type DisplayState } from "@server/tunnel/display";
```

Delete the whole `test("durations read as a human would say them", …)` block — its five values now live in `tests/term-duration.test.ts`. Leave every other test in the file untouched.

- [ ] **Step 7: Delete `uptime()` and point `commands.ts` at `duration`**

In `src/server/lifecycle/commands.ts`, delete the `uptime` function (lines 83-88) and add `duration` to the existing `@server/term` import:

```ts
import { duration, say } from "@server/term";
```

Replace its one use in `runStatus`:

```ts
          `(pid ${got.state.pid}, port ${got.state.port}, up ${duration(now - got.state.startedAt)})`,
```

- [ ] **Step 8: Add the behaviour-change test to `tests/lifecycle-status.test.ts`**

`uptime()` printed `0m` for anything under a minute; `duration` prints `30s`. That is intended, so it is asserted rather than left to drift:

```ts
test("an uptime under a minute reads in seconds, not as 0m", async () => {
  // uptime() capped at minutes and printed "0m" for a server 30 seconds old,
  // which reads as "no uptime recorded" rather than "just started".
  const d = await dir();
  const now = Date.now();
  await writeState(d, { ...s, startedAt: now - 30_000 });
  const out: string[] = [];
  await runStatus({ dir: d, probe: probe(true, "paddock"), log: (l) => out.push(l), now: () => now });
  expect(out.join(" ")).toContain("30s");
});

test("an uptime over a day rolls into days", async () => {
  const d = await dir();
  const now = Date.now();
  await writeState(d, { ...s, startedAt: now - 361_800_000 });
  const out: string[] = [];
  await runStatus({ dir: d, probe: probe(true, "paddock"), log: (l) => out.push(l), now: () => now });
  expect(out.join(" ")).toContain("4d 4h");
});
```

- [ ] **Step 9: Run the full suite**

Run: `make test 2>&1 | tail -20`
Expected: PASS. If any other file imported `human` or referenced `0m`, fix it now — `grep -rn "human(" src tests` must return nothing.

- [ ] **Step 10: Commit**

```bash
make check && make check-clean
git add src/server/term.ts src/server/tunnel/display.ts src/server/lifecycle/commands.ts \
        tests/term-duration.test.ts tests/tunnel-display.test.ts tests/lifecycle-status.test.ts
git commit -m "$(cat <<'MSG'
fix: four days is 4d 4h, not 100h 30m — in both formatters

human() and uptime() were the same function written twice and both stopped at
hours, so the bug had to be fixed twice or not at all. One day-aware
duration() in the term.ts leaf replaces both. At most two units, largest
first, and the second printed even at zero, because the tunnel block redraws
once a second and a unit that appears or vanishes changes its width.
MSG
)"
```

---

## Task 3: `--for 2d` is accepted

The duration that could not be read also could not be requested: `parseDuration` matches `^(\d+)([smh])$`, and `tests/cli.test.ts:108` currently asserts `"2d"` is **null**.

**Files:**
- Modify: `src/server/cli.ts` (`parseDuration`, `USAGE`)
- Modify: `README.md:110`, `README.md:154`
- Test: `tests/cli.test.ts:99-113`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseDuration(input: string): number | null` — unchanged signature, `d` added to the accepted units.

- [ ] **Step 1: Move `"2d"` out of the malformed list and assert it parses**

In `tests/cli.test.ts`, edit the two existing tests:

```ts
test("durations parse in seconds, minutes, hours and days", () => {
  expect(parseDuration("45s")).toBe(45_000);
  expect(parseDuration("90m")).toBe(5_400_000);
  expect(parseDuration("2h")).toBe(7_200_000);
  // Added with the day-aware formatter: a tunnel whose remaining time reads
  // "4d 4h" must also be requestable as `--for 4d`.
  expect(parseDuration("2d")).toBe(172_800_000);
  expect(parseDuration("14d")).toBe(1_209_600_000);
});

test("a malformed duration is null, never a default", () => {
  // A mistyped deadline that silently becomes "no deadline" defeats the flag.
  for (const bad of ["", "2", "h", "d", "-2h", "2.5h", "0h", "0d", "two hours", "2h30m", "2D"]) {
    expect(parseDuration(bad)).toBe(null);
  }
});

test("USAGE names the units --for accepts", () => {
  expect(USAGE).toContain("paddock tunnel");
  expect(USAGE).toContain("30m");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/cli.test.ts`
Expected: FAIL — `expect(null).toBe(172800000)`.

- [ ] **Step 3: Add `d` to the regex and name the units in `USAGE`**

In `src/server/cli.ts`, update the doc comment and the regex:

```ts
/**
 * `45s`, `90m`, `2h`, `2d`. Returns null for anything else — including `2`,
 * `2.5h` and `2h30m`.
 *
 * Null is a REFUSAL, not a default. `--for` exists to bound how long a public
 * URL lives; a typo that quietly became "no deadline" would defeat the only
 * reason to type the flag.
 *
 * `d` was added alongside the day-aware `duration()` formatter: a tunnel whose
 * remaining time reads `4d 4h` must be requestable in the same units it is
 * reported in. There is deliberately still no cap — `--for 400h` was uncapped
 * before this change, and introducing a limit here would be an unrelated
 * policy decision smuggled in behind a formatting fix.
 */
export function parseDuration(input: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(input);
  if (m === null) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return n * unit;
}
```

And the `USAGE` line:

```ts
  "       paddock tunnel [--for D]  publish it on a quick tunnel, gated by a code",
  "                                 D is 30m, 2h or 7d",
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the two README mentions**

`README.md:110` — change:

```markdown
`--for 2h` bounds how long it lives (`30m`, `2h`, `7d`); `ctrl+c` ends it.
```

`README.md:154` — change:

```markdown
does. `--for 2h` bounds how long it lives — `30m`, `2h` and `7d` all parse.
```

- [ ] **Step 6: Run the full suite and commit**

```bash
make test && make check && make check-clean
git add src/server/cli.ts tests/cli.test.ts README.md
git commit -m "$(cat <<'MSG'
feat: --for takes days, since the countdown now reports them

The duration that could not be read also could not be requested: the regex
accepted s, m and h only, and a test pinned "2d" as malformed. A tunnel whose
remaining time reads "4d 4h" should be requestable in the same units.

Still uncapped, deliberately: --for 400h parsed before this change, and adding
a limit now would be an unrelated policy change behind a formatting fix.
MSG
)"
```

---

## Task 4: a glyph per outcome on `status` and `doctor`

`runStatus` has five outcomes and its own comment insists `unreadable` — "I could not read the state" — is a different fact from `none`, "nothing is running". Both print as identical grey text. `doctorReport` has the same problem with its three exit codes.

The glyph, not the colour, is what carries this: it survives escape-stripping, so `NO_COLOR`, a pipe, a CI log and a colourblind reader all keep the distinction. Colour is added at the print boundary in `paint()`, never in the builders, exactly as `term.ts`'s header comment requires.

**Note — one deliberate deviation from the spec.** The spec's colour section says colour "dims the detail line". That is dropped: dimming would need `paint()` to guess which lines are details from their indentation, and `doctor`'s own two-space-indented body would be caught by any such rule. The glyph carries the distinction; the detail line stays plain. Nothing else in the spec changes.

**Files:**
- Modify: `src/server/term.ts` (add `glyph`, extend `paint`)
- Modify: `src/server/lifecycle/commands.ts` (`runStatus`)
- Modify: `src/server/doctor.ts` (`doctorReport`)
- Test: `tests/term.test.ts`, `tests/lifecycle-status.test.ts`, `tests/doctor.test.ts`

**Interfaces:**
- Consumes: `duration` from Task 2 (already wired into `runStatus`).
- Produces: `type Outcome = "yes" | "no" | "unknown"` and `glyph(o: Outcome): string` from `@server/term`. `paint(line, colour)` keeps its signature and gains glyph colouring.

- [ ] **Step 1: Write the failing tests for `glyph` and `paint`**

Append to `tests/term.test.ts`:

```ts
test("one glyph per outcome, and the third is 'could not decide'", () => {
  expect(glyph("yes")).toBe("✓");
  expect(glyph("no")).toBe("✗");
  expect(glyph("unknown")).toBe("⚠");
});

// The whole reason the glyph exists rather than colour alone: a pipe, a CI
// log, NO_COLOR and a colourblind reader all keep the distinction.
test("stripping every escape from a painted glyph line returns the plain one", () => {
  const line = "✓ paddock 0.2.0 — running";
  expect(strip(paint(line, true))).toBe(paint(line, false));
});

test("a leading glyph is coloured, and keeps its indentation", () => {
  const out = paint("  ⚠ paddock — could not read state (EACCES)", true);
  expect(out.startsWith("  \x1b[")).toBe(true);
  expect(strip(out)).toBe("  ⚠ paddock — could not read state (EACCES)");
});

test("each outcome gets its own colour, and only the glyph is painted", () => {
  expect(paint("✓ ok", true)).toContain("\x1b[32m✓");
  expect(paint("✗ no", true)).toContain("\x1b[31m✗");
  expect(paint("⚠ hm", true)).toContain("\x1b[33m⚠");
  // The text after the glyph carries no escapes of its own.
  expect(paint("✓ ok", true).endsWith(" ok")).toBe(true);
});

// Every line of a multi-line block, because doctor's report is one string.
test("a glyph is painted on every line of a block, not only the first", () => {
  const out = paint("✓ first\n⚠ second", true);
  expect(strip(out)).toBe("✓ first\n⚠ second");
  expect(out).toContain("\x1b[32m✓");
  expect(out).toContain("\x1b[33m⚠");
});

// A glyph mid-sentence is prose, not an outcome marker.
test("a glyph that is not leading is left alone", () => {
  expect(paint("the ✓ means compatible", true)).toBe("the ✓ means compatible");
});
```

Update that file's import line:

```ts
import { glyph, paint, useColour } from "@server/term";
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/term.test.ts`
Expected: FAIL — `glyph` is not exported.

- [ ] **Step 3: Implement `glyph` and extend `paint`**

Add to `src/server/term.ts`:

```ts
/**
 * The three answers any diagnostic command can give. `unknown` is the one that
 * earns its place: `runStatus`'s `unreadable` and `doctorReport`'s exit code 2
 * both mean "could not decide", and both used to be typeset identically to the
 * outcomes they are NOT.
 */
export type Outcome = "yes" | "no" | "unknown";

/**
 * The glyph, not the colour, is what carries the distinction.
 *
 * This file's rule is that colour decorates and never informs — a piped log
 * must read identically to a terminal. A glyph survives escape-stripping, so
 * `NO_COLOR`, a pipe, a CI log, a screenshot in an issue and a colourblind
 * reader all keep the three-way distinction that `paint` merely decorates.
 */
export function glyph(o: Outcome): string {
  return o === "yes" ? "✓" : o === "no" ? "✗" : "⚠";
}

const GLYPH_COLOUR: Record<string, string | undefined> = {
  "✓": "32",
  "✗": "31",
  "⚠": "33",
};
```

Then extend `paint`, keeping its existing backtick behaviour and its header comment intact:

```ts
export function paint(line: string, colour: boolean): string {
  if (!colour) return line;
  const spans = line.replace(/`[^`\n]+`/g, (span) => `\x1b[1;36m${span}\x1b[0m`);
  // A LEADING glyph only, per line — `m` for doctor's multi-line report. A
  // glyph mid-sentence is prose ("the ✓ means compatible") and colouring it
  // would be colour informing rather than decorating.
  return spans.replace(
    /^([ \t]*)([✓✗⚠])/gm,
    (_m, pad: string, g: string) => `${pad}\x1b[${GLYPH_COLOUR[g]}m${g}\x1b[0m`,
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/term.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for `runStatus`**

Append to `tests/lifecycle-status.test.ts`:

```ts
// Five outcomes that used to be five identical greys. The glyph is the part
// that survives a pipe, so it is what is asserted.
test("each status outcome carries its own glyph", async () => {
  const running = await dir();
  await writeState(running, s);
  const out: string[] = [];
  await runStatus({ dir: running, probe: probe(true, "paddock"), log: (l) => out.push(l) });
  expect(out[0]).toStartWith("✓");

  const nothing: string[] = [];
  await runStatus({ dir: await dir(), probe: probe(false, null), log: (l) => nothing.push(l) });
  expect(nothing[0]).toStartWith("✗");
});

// The distinction runStatus's own comment insists on: "could not read the
// state" is not "nothing is running", and must not be typeset as if it were.
test("an unreadable state is ⚠, not ✗ — it is undetermined, not absent", async () => {
  const d = await dir();
  await writeFile(join(d, "paddock.state.json"), "{ not json");
  const out: string[] = [];
  const code = await runStatus({ dir: d, probe: probe(false, null), log: (l) => out.push(l) });
  expect(code).toBe(1);
  expect(out[0]).toStartWith("⚠");
});
```

- [ ] **Step 6: Run to verify it fails, then implement `runStatus`**

Run: `bun test tests/lifecycle-status.test.ts` — Expected: FAIL, lines start with `paddock`.

Rewrite the `switch` in `runStatus`, adding `glyph` to the `@server/term` import (`import { duration, glyph, say } from "@server/term";`). Exit codes are unchanged:

```ts
  switch (got.kind) {
    case "none":
      if (o.port !== undefined &&
          await reportUntracked(o.port, o.listener ?? httpListener, log)) return 1;
      log(`${glyph("no")} paddock — not running`);
      return 1;
    case "unreadable":
      // ⚠ and not ✗, deliberately. "I could not read the state" and "nothing
      // is running" are different facts, and reporting the first as the second
      // is the guess this module refuses to make. The file is left in place —
      // we could not even read it, so deleting it would destroy the one clue
      // an operator has. Exit non-zero: this is "don't know", which must not
      // look like success to a caller scripting on the exit code.
      log(`${glyph("unknown")} paddock — could not read state (${got.error})`);
      return 1;
    case "stale":
      // Say it once. A crash left this behind and silently tidying it up hides
      // that anything happened.
      log(`${glyph("no")} paddock — not running (stale state for pid ${got.state.pid}, cleared)`);
      await clearState(o.dir, log);
      return 1;
    case "mismatch":
      log(`${glyph("no")} paddock — not running (pid ${got.state.pid} is now: ${got.actual ?? "unknown"})`);
      await clearState(o.dir, log);
      return 1;
    case "running":
      log(`${glyph("yes")} paddock ${got.state.version} — running`);
      log(`    pid ${got.state.pid} · port ${got.state.port} · up ${duration(now - got.state.startedAt)}`);
      return 0;
  }
```

Run: `bun test tests/lifecycle-status.test.ts` — Expected: PASS. The existing tests join `out` with a space before asserting, so the split into two lines does not break them.

- [ ] **Step 7: Write the failing tests for `doctor`, then implement**

Append to `tests/doctor.test.ts`:

```ts
// The exit code already said which of three answers this was; the text did
// not. install.sh branches on the code and never reads the text, so the
// wording is free — but an operator reading the terminal gets the same
// three-way distinction the installer has always had.
test("the report's glyph matches its exit code", () => {
  expect(doctorReport(19, { kind: "answered", protocol: 19 }).text).toStartWith("✓");
  expect(doctorReport(19, { kind: "answered", protocol: 16 }).text).toStartWith("✗");
  expect(doctorReport(19, { kind: "unreachable", message: "no herdr socket at /nope" }).text)
    .toStartWith("⚠");
});

test("a newer herdr is ✓, matching its exit code of 0", () => {
  const r = doctorReport(19, { kind: "answered", protocol: 20 });
  expect(r.code).toBe(0);
  expect(r.text).toStartWith("✓");
});
```

Run: `bun test tests/doctor.test.ts` — Expected: FAIL.

In `src/server/doctor.ts`, import `glyph` (`import { glyph, say } from "@server/term";`) and prefix each of the three returns. The incompatible and unreachable branches wrap the message they already use rather than writing a second wording of it:

```ts
  if (probe.kind === "unreachable") {
    return { code: 2, text: `${glyph("unknown")} ${probe.message}` };
  }
```
```ts
  if (typeof probe.protocol !== "number" || !Number.isFinite(probe.protocol)) {
    return {
      code: 1,
      text: `${glyph("no")} ${new ProtocolMismatchError(expected, probe.protocol).message}`,
    };
  }

  if (probe.protocol < expected) {
    // Deliberately the server's own message rather than a second wording of it.
    return {
      code: 1,
      text: `${glyph("no")} ${new ProtocolMismatchError(expected, probe.protocol).message}`,
    };
  }
```

And the compatible branch's first line:

```ts
  const lines = [
    `${glyph("yes")} paddock: herdr looks compatible`,
```

Run: `bun test tests/doctor.test.ts` — Expected: PASS. If `tests/startup-errors.test.ts` asserts a `ProtocolMismatchError` message it is unaffected: the error's own text is unchanged and only prefixed here.

- [ ] **Step 8: Run the full suite and commit**

```bash
make test && make check && make check-clean
git add src/server/term.ts src/server/lifecycle/commands.ts src/server/doctor.ts \
        tests/term.test.ts tests/lifecycle-status.test.ts tests/doctor.test.ts
git commit -m "$(cat <<'MSG'
feat: a glyph per outcome, so ✗ and ⚠ stop reading alike

status had five outcomes and doctor three exit codes, all typeset as the same
grey text — including the two that mean "could not decide", which runStatus's
own comment insists is a different fact from "nothing is running".

The glyph carries it, not the colour: it survives escape-stripping, so a pipe,
NO_COLOR, a CI log and a colourblind reader keep the distinction that paint()
merely decorates. Colour is still applied at the print boundary, never in the
builders. Exit codes are untouched — install.sh reads them.
MSG
)"
```

---

## Task 5: `bar()` and the one file that redraws a line

`term.ts` must stay a dependency-free leaf whose functions are assertable with no tty, so the pure `bar()` goes there and every stateful thing — tty detection, terminal width, `\r`, throttling — goes into a new module that nothing but `update.ts` depends on.

**Files:**
- Modify: `src/server/term.ts` (add `bar`)
- Create: `src/server/progress.ts`
- Test: `tests/progress.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks (`term.ts` only).
- Produces, all imported by Task 6:
  - `bar(fraction: number, width: number): string` from `@server/term`
  - `interface Progress { start(label: string, total: number | null): void; advance(bytes: number): void; done(): void }`
  - `lineProgress(log: (s: string) => void): Progress`
  - `barProgress(o: { write: (s: string) => void; columns: () => number; now: () => number }): Progress`
  - `makeProgress(o: { log: (s: string) => void; env: Record<string, string | undefined>; stream: { isTTY?: boolean; columns?: number; write: (s: string) => void }; now?: () => number }): Progress`

- [ ] **Step 1: Write the failing test for `bar`**

Create `tests/progress.test.ts`:

```ts
import { expect, test } from "bun:test";
import { bar } from "@server/term";
import { barProgress, lineProgress, makeProgress } from "@server/progress";

test("the bar is exactly the width it was asked for", () => {
  for (const f of [0, 0.25, 0.5, 0.99, 1]) {
    expect(bar(f, 20)).toHaveLength(20);
  }
});

test("empty, half and full read as they should", () => {
  expect(bar(0, 10)).toBe("[        ]");
  expect(bar(0.5, 10)).toBe("[===>    ]");
  expect(bar(1, 10)).toBe("[========]");
});

// A server that overshoots its own content-length must not crash an update.
test("a fraction outside 0..1 is clamped, not rejected", () => {
  expect(bar(1.5, 10)).toBe("[========]");
  expect(bar(-1, 10)).toBe("[        ]");
  expect(bar(Number.NaN, 10)).toBe("[        ]");
  expect(bar(Number.POSITIVE_INFINITY, 10)).toBe("[========]");
});

// Below eight columns there is no bar that means anything; the caller prints
// the percentage alone rather than drawing two brackets and calling it a bar.
test("too narrow to mean anything returns empty", () => {
  expect(bar(0.5, 7)).toBe("");
  expect(bar(0.5, 0)).toBe("");
  expect(bar(0.5, -10)).toBe("");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/progress.test.ts`
Expected: FAIL — `bar` is not exported, `@server/progress` does not resolve.

- [ ] **Step 3: Implement `bar` in `term.ts`**

```ts
/**
 * A fixed-width progress bar as a plain string. Pure, so its edges are
 * assertable with no terminal — which is the whole reason it lives in this
 * leaf rather than beside the code that redraws it.
 *
 * A `fraction` outside `0..1` is CLAMPED rather than refused: a server that
 * sends more bytes than its own `content-length` promised must not crash an
 * update over a cosmetic bar. `NaN` clamps to empty for the same reason.
 *
 * Below a `width` of 8 there is no bar that means anything — two brackets and
 * a couple of cells is a decoration, not a measurement — so it returns the
 * empty string and the caller prints the percentage alone.
 */
export function bar(fraction: number, width: number): string {
  if (width < 8) return "";
  const f = Number.isNaN(fraction) ? 0 : Math.min(1, Math.max(0, fraction));
  const inner = width - 2;
  const filled = Math.round(inner * f);
  const head =
    filled === 0 ? "" : filled >= inner ? "=".repeat(inner) : `${"=".repeat(filled - 1)}>`;
  return `[${head}${" ".repeat(inner - filled)}]`;
}
```

- [ ] **Step 4: Run to verify `bar` passes**

Run: `bun test tests/progress.test.ts 2>&1 | grep -c "pass"`
Expected: the four `bar` tests pass; the file still fails to import `@server/progress`.

- [ ] **Step 5: Write the failing tests for the sinks**

Append to `tests/progress.test.ts`:

```ts
const clock = (start = 0) => {
  let t = start;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
};

test("the line sink says the size once and nothing after", () => {
  const said: string[] = [];
  const p = lineProgress((s) => said.push(s));
  p.start("paddock-linux-x86_64", 87_031_808);
  p.advance(1_000_000);
  p.advance(1_000_000);
  p.done();
  expect(said).toEqual(["paddock: downloading paddock-linux-x86_64 (83 MB)"]);
});

// No content-length means no denominator to invent.
test("the line sink drops the size when it was never sent", () => {
  const said: string[] = [];
  const p = lineProgress((s) => said.push(s));
  p.start("paddock-linux-x86_64", null);
  expect(said).toEqual(["paddock: downloading paddock-linux-x86_64"]);
});

test("the bar sink draws percent, counts and rate", () => {
  const out: string[] = [];
  const c = clock();
  const p = barProgress({ write: (s) => out.push(s), columns: () => 80, now: c.now });
  p.start("asset", 10 * 1_048_576);
  c.tick(1000);
  p.advance(5 * 1_048_576);
  const last = out[out.length - 1] ?? "";
  expect(last).toContain("50%");
  expect(last).toContain("5/10 MB");
  expect(last).toContain("MB/s");
  expect(last).toContain("[");
});

// An 83 MB download arrives in far more chunks than an eye can follow, and a
// redraw per chunk is a write syscall per chunk.
test("the bar redraws at most ten times a second", () => {
  const out: string[] = [];
  const c = clock();
  const p = barProgress({ write: (s) => out.push(s), columns: () => 80, now: c.now });
  p.start("asset", 100 * 1_048_576);
  out.length = 0;
  for (let i = 0; i < 50; i++) { c.tick(10); p.advance(1_048_576); }
  // 500ms of ticks at 10ms each: five redraws, not fifty.
  expect(out.length).toBeLessThanOrEqual(6);
});

test("done erases the bar so the next line lands clean", () => {
  const out: string[] = [];
  const c = clock();
  const p = barProgress({ write: (s) => out.push(s), columns: () => 80, now: c.now });
  p.start("asset", 1_048_576);
  c.tick(1000); p.advance(1_048_576);
  p.done();
  expect(out[out.length - 1]).toBe("\r\x1b[2K");
});

// Width is read per redraw, not captured once: a terminal resized mid-download
// must not leave a tail of the previous, wider line.
test("width is re-read on every redraw", () => {
  const out: string[] = [];
  const c = clock();
  let cols = 80;
  const p = barProgress({ write: (s) => out.push(s), columns: () => cols, now: c.now });
  p.start("asset", 100 * 1_048_576);
  c.tick(1000); p.advance(50 * 1_048_576);
  const wide = (out[out.length - 1] ?? "").length;
  cols = 30;
  c.tick(1000); p.advance(1_048_576);
  expect((out[out.length - 1] ?? "").length).toBeLessThan(wide);
});

test("no content-length means a byte counter, not a fabricated percentage", () => {
  const out: string[] = [];
  const c = clock();
  const p = barProgress({ write: (s) => out.push(s), columns: () => 80, now: c.now });
  p.start("asset", null);
  c.tick(1000); p.advance(45 * 1_048_576);
  const last = out[out.length - 1] ?? "";
  expect(last).toContain("45 MB");
  expect(last).not.toContain("%");
});

test("a pipe gets lines and a tty gets a bar", () => {
  const said: string[] = [];
  const written: string[] = [];
  const stream = { isTTY: false, columns: 80, write: (s: string) => { written.push(s); } };
  makeProgress({ log: (s) => said.push(s), env: {}, stream }).start("asset", 1_048_576);
  expect(said).toHaveLength(1);
  expect(written).toHaveLength(0);

  said.length = 0; written.length = 0;
  makeProgress({
    log: (s) => said.push(s), env: {},
    stream: { ...stream, isTTY: true }, now: () => 0,
  }).start("asset", 1_048_576);
  expect(written.length).toBeGreaterThan(0);
});

// Strictly NO_COLOR governs colour, and an uncoloured bar would be defensible
// — but a redrawn line is motion, and the environments that set it are
// overwhelmingly the ones capturing output to a file.
test("NO_COLOR on a tty still gets lines, not a bar", () => {
  const said: string[] = [];
  const written: string[] = [];
  makeProgress({
    log: (s) => said.push(s),
    env: { NO_COLOR: "" },
    stream: { isTTY: true, columns: 80, write: (s: string) => { written.push(s); } },
  }).start("asset", 1_048_576);
  expect(said).toHaveLength(1);
  expect(written).toHaveLength(0);
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `bun test tests/progress.test.ts`
Expected: FAIL — cannot resolve `@server/progress`.

- [ ] **Step 7: Implement `src/server/progress.ts`**

```ts
import { bar } from "@server/term";

/**
 * The ONLY code in this repository that redraws a line.
 *
 * It is a separate file rather than part of `term.ts` because `term.ts` is a
 * dependency-free LEAF whose whole value is that its functions are pure and
 * assertable with no tty — see its header comment and the dependency direction
 * in docs/architecture.md. Terminal width, `\r`, throttling and tty detection
 * are the opposite of that, and putting them there would make
 * `herdr/socket.ts` transitively depend on a progress bar.
 *
 * The interface is injected into `runUpdate` the way `log` already is, so no
 * test needs a pty to drive an update.
 */
export interface Progress {
  /** `total` is null when the server sent no `content-length`. */
  start(label: string, total: number | null): void;
  advance(bytes: number): void;
  /** Leaves the cursor at the start of a clean line. */
  done(): void;
}

const MB = 1_048_576;
const mb = (n: number) => Math.round(n / MB);

/**
 * Ten redraws a second, no more. An 83 MB download arrives in far more chunks
 * than that, and a redraw per chunk is a write syscall per chunk for motion no
 * eye can follow.
 */
const REDRAW_MS = 100;

/** The widest bar worth drawing, however wide the terminal is. */
const MAX_BAR = 40;

/**
 * A pipe, a CI log, a file. One line when the download starts and nothing
 * after — the same information the bar carries, minus the motion a log cannot
 * show.
 */
export function lineProgress(log: (s: string) => void): Progress {
  return {
    start(label, total) {
      log(
        total === null
          ? `paddock: downloading ${label}`
          : `paddock: downloading ${label} (${mb(total)} MB)`,
      );
    },
    advance() {},
    done() {},
  };
}

export interface BarOpts {
  write: (s: string) => void;
  /** Read PER REDRAW, never captured: a terminal can be resized mid-download. */
  columns: () => number;
  now: () => number;
}

export function barProgress(o: BarOpts): Progress {
  let total: number | null = null;
  let seen = 0;
  let startedAt = 0;
  let lastDraw = 0;
  let last = "";
  let live = false;

  const frame = (): string => {
    const secs = Math.max(0.001, (o.now() - startedAt) / 1000);
    const rate = `${(seen / MB / secs).toFixed(1)} MB/s`;
    if (total === null) return `  ${mb(seen)} MB  ${rate}`;
    const pct = `${Math.floor((seen / total) * 100)}%`.padStart(4);
    const counts = `${mb(seen)}/${mb(total)} MB`;
    // Whatever is left after the text, capped. `bar` returns "" when that is
    // too narrow to mean anything, and the percentage stands on its own.
    const room = o.columns() - (pct.length + counts.length + rate.length + 8);
    const b = bar(seen / total, Math.min(MAX_BAR, room));
    return `  ${b}${b === "" ? "" : "  "}${pct}  ${counts}  ${rate}`;
  };

  const draw = (force: boolean): void => {
    const t = o.now();
    if (!force && t - lastDraw < REDRAW_MS) return;
    const s = frame();
    if (s === last) return;
    lastDraw = t;
    // A cheap guard, not a load-bearing one: the rate moves with the clock, so
    // two frames are rarely byte-identical in practice. It costs one string
    // compare and saves a write on the occasions they are.
    last = s;
    live = true;
    // `\r` then erase-to-end-of-line: a shorter frame after a longer one must
    // not leave the tail of the longer one behind.
    o.write(`\r\x1b[2K${s}`);
  };

  return {
    start(_label, t) {
      total = t;
      seen = 0;
      startedAt = o.now();
      lastDraw = 0;
      last = "";
      draw(true);
    },
    advance(n) {
      seen += n;
      draw(false);
    },
    done() {
      // Erase, do NOT newline. The caller's next `log` line is the one the
      // operator keeps; the bar was scaffolding.
      if (live) {
        o.write("\r\x1b[2K");
        live = false;
      }
    },
  };
}

export interface MakeProgressOpts {
  log: (s: string) => void;
  env: Record<string, string | undefined>;
  stream: { isTTY?: boolean; columns?: number; write: (s: string) => void };
  now?: () => number;
}

/**
 * Bar on a tty, lines everywhere else.
 *
 * `NO_COLOR` suppresses the bar as well as the colour. Strictly the variable
 * governs colour and an uncoloured bar would be defensible — but a redrawn
 * line is motion, the environments that set `NO_COLOR` are overwhelmingly the
 * ones capturing output to a file, and one switch covering both is one thing
 * to reason about rather than two.
 */
export function makeProgress(o: MakeProgressOpts): Progress {
  if (o.stream.isTTY !== true || "NO_COLOR" in o.env) return lineProgress(o.log);
  return barProgress({
    write: (s) => o.stream.write(s),
    columns: () => o.stream.columns ?? 80,
    now: o.now ?? Date.now,
  });
}
```

- [ ] **Step 8: Run to verify they pass**

Run: `bun test tests/progress.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 9: Confirm `term.ts` is still a leaf, then commit**

Run: `grep -n "^import" src/server/term.ts`
Expected: no output. If there is any, the leaf rule was broken — move the offending code into `progress.ts`.

```bash
make test && make check && make check-clean
git add src/server/term.ts src/server/progress.ts tests/progress.test.ts
git commit -m "$(cat <<'MSG'
feat: a progress sink, in the one file allowed to redraw a line

bar() is pure and lives in the term.ts leaf so its edges are assertable with
no terminal. Everything stateful — tty detection, width, \r, throttling — is
in progress.ts, which nothing but the updater will depend on, because term.ts
imports nothing and herdr/socket.ts must not transitively depend on a bar.

Ten redraws a second and only on a changed frame: an 83 MB download arrives in
more chunks than an eye can follow. Width is re-read per redraw so a resize
mid-download leaves no tail of the wider line.
MSG
)"
```

---

## Task 6: `paddock update` streams, and says so

Today `runUpdate` prints `0.1.0 -> 0.2.0`, awaits `binRes.arrayBuffer()` — one await that buffers the whole release asset in memory with no output — and then prints `updated to 0.2.0`. A stalled download and a working one look identical.

The spec names a new `update-stream.test.ts`; these tests go in the existing
`tests/update.test.ts` instead, because that is where the `harness()` fixture
and the untouched dev-build, brew and `--check` tests already live, and
splitting them would put two halves of one command's contract in two files.

**Files:**
- Modify: `src/server/update.ts:112-260` (the `UpdateOpts` interface and the download half of `runUpdate`)
- Test: `tests/update.test.ts`

**Interfaces:**
- Consumes: `Progress`, `makeProgress` from `@server/progress` (Task 5).
- Produces: `UpdateOpts` gains `progress?: Progress`. Signature of `runUpdate(o: UpdateOpts): Promise<number>` is unchanged.

- [ ] **Step 1: Rewrite the two-halves failure test and add the streaming tests**

In `tests/update.test.ts`, **replace** the existing `test("a failed download names the HTTP status for each half, not just 'download failed'", …)` — SHA256SUMS is now fetched first and short-circuits, so one message can no longer name both — with two tests:

```ts
// SHA256SUMS is fetched FIRST and is a few hundred bytes: a release published
// without a listed checksum must fail before an 83 MB download, not after it.
test("a missing SHA256SUMS fails before the asset is ever requested", async () => {
  const asked: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "paddock-up-"));
  const self = join(dir, "paddock");
  await writeFile(self, "OLD BINARY");
  const fetchImpl = (async (url: string) => {
    asked.push(String(url));
    if (String(url).includes("releases/latest")) {
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }));
    }
    if (String(url).endsWith("SHA256SUMS")) return new Response("nope", { status: 403 });
    return new Response("BODY");
  }) as unknown as typeof fetch;

  const said: string[] = [];
  const code = await runUpdate({
    selfPath: self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl, log: (s) => said.push(s), progress: silent(),
  });
  expect(code).toBe(1);
  expect(said.join("\n")).toContain("403");
  expect(said.join("\n")).toContain("SHA256SUMS");
  expect(asked.some((u) => u.endsWith("paddock-linux-x86_64"))).toBe(false);
  expect(await readFile(self, "utf8")).toBe("OLD BINARY");
});

test("a failed asset download names its own HTTP status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paddock-up-"));
  const self = join(dir, "paddock");
  await writeFile(self, "OLD BINARY");
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("releases/latest")) {
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }));
    }
    if (String(url).endsWith("SHA256SUMS")) {
      return new Response("abc  paddock-linux-x86_64\n");
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;

  const said: string[] = [];
  const code = await runUpdate({
    selfPath: self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl, log: (s) => said.push(s), progress: silent(),
  });
  expect(code).toBe(1);
  expect(said.join("\n")).toContain("404");
  expect(said.join("\n")).toContain("paddock-linux-x86_64");
});
```

Add the `silent()` helper near `harness()` at the top of the file:

```ts
import type { Progress } from "@server/progress";

/** A Progress that records nothing — the default for tests that assert text. */
const silent = (): Progress => ({ start() {}, advance() {}, done() {} });
```

Then add the streaming tests:

```ts
test("a chunked body hashes to the same digest as one buffered read", async () => {
  // The whole risk of streaming: if the hasher were fed anything other than
  // the exact bytes, in order, the checksum gate would start rejecting good
  // releases — or worse, accepting bad ones.
  const body = "PADDOCK".repeat(5000);
  const sum = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const dir = await mkdtemp(join(tmpdir(), "paddock-up-"));
  const self = join(dir, "paddock");
  await writeFile(self, "OLD BINARY");
  await chmod(self, 0o755);
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("releases/latest")) {
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }));
    }
    if (String(url).endsWith("SHA256SUMS")) {
      return new Response(`${sum}  paddock-linux-x86_64\n`);
    }
    // A body delivered in many small chunks, as a real download is.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(body);
        for (let i = 0; i < bytes.length; i += 997) {
          controller.enqueue(bytes.slice(i, i + 997));
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-length": String(body.length) } });
  }) as unknown as typeof fetch;

  const code = await runUpdate({
    selfPath: self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl, log: () => {}, progress: silent(),
  });
  expect(code).toBe(0);
  expect(await readFile(self, "utf8")).toBe(body);
  expect((await stat(self)).mode & 0o111).toBeGreaterThan(0);
});

test("progress is told the size, advanced, and finished exactly once", async () => {
  const body = "x".repeat(4096);
  const sum = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const h = await harness(body, sum);
  const events: string[] = [];
  let advanced = 0;
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl: h.fetchImpl, log: () => {},
    progress: {
      start: (label, total) => events.push(`start:${label}:${total}`),
      advance: (n) => { advanced += n; },
      done: () => events.push("done"),
    },
  });
  expect(code).toBe(0);
  expect(events[0]).toBe(`start:paddock-linux-x86_64:${body.length}`);
  expect(events.filter((e) => e === "done")).toHaveLength(1);
  expect(advanced).toBe(body.length);
});

test("a passing checksum is not announced, but a failing one still is", async () => {
  const good = await harness("NEW BINARY", new Bun.CryptoHasher("sha256").update("NEW BINARY").digest("hex"));
  const quiet: string[] = [];
  await runUpdate({
    selfPath: good.self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl: good.fetchImpl, log: (s) => quiet.push(s), progress: silent(),
  });
  // Presentation: a passing integrity check is not news.
  expect(quiet.join("\n")).not.toContain("sha256");
  expect(quiet.join("\n")).toContain("updated to 9.9.9");

  // Never swallowed: a FAILING one is the whole point of the check.
  const bad = await harness("NEW BINARY", "0".repeat(64));
  const loud: string[] = [];
  const code = await runUpdate({
    selfPath: bad.self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl: bad.fetchImpl, log: (s) => loud.push(s), progress: silent(),
  });
  expect(code).toBe(1);
  expect(loud.join("\n")).toContain("CHECKSUM MISMATCH");
  expect(await readFile(bad.self, "utf8")).toBe("OLD BINARY");
});

test("a checksum mismatch leaves no temp file behind", async () => {
  // The half-finished write this command must never leave: a full-size
  // .paddock.new sitting next to the binary with nothing mentioning it.
  const h = await harness("NEW BINARY", "0".repeat(64));
  await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl: h.fetchImpl, log: () => {}, progress: silent(),
  });
  expect(await readdir(h.dir)).not.toContain(".paddock.new");
});

test("--check downloads nothing and never touches the sink", async () => {
  const h = await harness("NEW BINARY", "unused");
  const events: string[] = [];
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl: h.fetchImpl, log: () => {}, checkOnly: true,
    progress: { start: () => events.push("start"), advance: () => {}, done: () => events.push("done") },
  });
  expect(code).toBe(0);
  expect(events).toEqual([]);
});

test("a body that ends mid-stream is reported, and the binary survives", async () => {
  const h = await harness("unused", "unused");
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("releases/latest")) {
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }));
    }
    if (String(url).endsWith("SHA256SUMS")) {
      return new Response(`${"a".repeat(64)}  paddock-linux-x86_64\n`);
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("half"));
        controller.error(new Error("connection reset"));
      },
    });
    return new Response(stream);
  }) as unknown as typeof fetch;

  const said: string[] = [];
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl, log: (s) => said.push(s), progress: silent(),
  });
  expect(code).toBe(1);
  expect(said.join("\n")).toContain("download failed");
  expect(await readFile(h.self, "utf8")).toBe("OLD BINARY");
  expect(await readdir(h.dir)).not.toContain(".paddock.new");
});
```

Delete the older mid-stream test that asserted the same thing through `arrayBuffer()` (around `tests/update.test.ts:195-218`) — this one replaces it.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/update.test.ts`
Expected: FAIL — `progress` is not a known property of `UpdateOpts`.

- [ ] **Step 3: Add `progress` to `UpdateOpts`**

In `src/server/update.ts`, add the import and the option:

```ts
import { makeProgress, type Progress } from "@server/progress";
```

```ts
  /**
   * How the download reports itself. Injected like `log` so no test needs a
   * pty; defaults to a bar on a tty and one line under a pipe.
   */
  progress?: Progress;
```

- [ ] **Step 4: Replace the download block**

Replace everything in `runUpdate` from `const base = …` down to the end of the `rename` try/catch with this. Everything above it — the dev-build refusal, the release-API fetch, the `isNewer` short-circuit, the `realpath` resolution, the `--check` branch and the Homebrew refusal — is unchanged, and so is the "still serving the old version" hint below it.

```ts
  const progress = o.progress ?? makeProgress({ log, env: process.env, stream: process.stdout });
  const base = `https://github.com/${REPO}/releases/download/v${latest}`;
  const tmp = join(dirname(o.selfPath), ".paddock.new");

  /**
   * Announced, never swallowed. A leftover full-size temp file beside the
   * binary with nothing mentioning it is the half-update this command exists
   * to refuse to leave behind.
   */
  const removeTemp = async (): Promise<void> => {
    try {
      await rm(tmp, { force: true });
    } catch (e) {
      log(`paddock: also failed to remove the leftover temp file ${tmp}: ${(e as Error).message}`);
    }
  };

  // SHA256SUMS FIRST, and on its own. It is a few hundred bytes, so a release
  // published without a listed checksum fails here rather than after an 83MB
  // download. This used to be a Promise.all with the asset, which is why the
  // failure message named both halves at once.
  let expected: string | undefined;
  try {
    const sumRes = await f(`${base}/SHA256SUMS`);
    if (!sumRes.ok) {
      log(`paddock: download failed (HTTP ${sumRes.status} for SHA256SUMS)`);
      return 1;
    }
    expected = (await sumRes.text())
      .split("\n").find((l) => l.trim().endsWith(asset))?.trim().split(/\s+/)[0];
  } catch (e) {
    log(`paddock: download failed: ${(e as Error).message}`);
    return 1;
  }
  if (!expected) { log(`paddock: ${asset} is not listed in SHA256SUMS`); return 1; }

  // Streamed to disk and hashed as it passes, rather than buffered whole by
  // arrayBuffer(). The operator sees it move, and 83MB stays out of memory.
  //
  // The "nothing is written" guarantee is UNCHANGED: only the temp file exists
  // during the download, the real binary is untouched until after the digest
  // is compared, and every failure path below removes the temp file.
  const hasher = new Bun.CryptoHasher("sha256");
  let actual: string;
  try {
    const binRes = await f(`${base}/${asset}`);
    if (!binRes.ok) {
      log(`paddock: download failed (HTTP ${binRes.status} for ${asset})`);
      return 1;
    }
    if (binRes.body === null) {
      log(`paddock: download failed: ${asset} arrived with no body`);
      return 1;
    }
    // Absent or unparseable content-length means no denominator; the sink
    // shows a byte counter rather than inventing a percentage.
    const declared = Number(binRes.headers.get("content-length"));
    const total = Number.isFinite(declared) && declared > 0 ? declared : null;
    progress.start(asset, total);
    const sink = Bun.file(tmp).writer();
    try {
      for await (const chunk of binRes.body as ReadableStream<Uint8Array>) {
        hasher.update(chunk);
        sink.write(chunk);
        progress.advance(chunk.length);
      }
    } finally {
      await sink.end();
      progress.done();
    }
    actual = hasher.digest("hex");
  } catch (e) {
    // A body that ends mid-stream — a declared content-length the connection
    // never delivers — throws here rather than resolving short.
    progress.done();
    log(`paddock: download failed: ${(e as Error).message}`);
    await removeTemp();
    return 1;
  }

  if (actual !== expected) {
    // The real binary was never touched. Replacing a working install with a
    // broken one is a worse outcome than not updating.
    log("paddock: CHECKSUM MISMATCH — keeping the current binary");
    log(`  expected ${expected}`);
    log(`  actual   ${actual}`);
    await removeTemp();
    return 1;
  }

  try {
    // The writer above created the file at the umask's default (typically
    // 0644). This chmod is the ONLY thing that makes the replacement
    // executable — dropping it would ship a `paddock` that no longer runs,
    // silently, by way of the update path meant to keep it running.
    await chmod(tmp, 0o755);
    // rename(2) over a running executable is safe on Linux and macOS: the
    // running process keeps its inode and the next invocation gets the new
    // file. This is why dropping Windows simplified the design.
    await rename(tmp, o.selfPath);
  } catch (e) {
    log(`paddock: could not replace ${o.selfPath}: ${(e as Error).message}`);
    log("paddock: if it was installed by a package manager, update it there instead");
    await removeTemp();
    return 1;
  }
  log(`paddock: updated to ${latest}`);
```

Remove the now-unused `writeFile` from the `node:fs/promises` import if nothing else in the file uses it (`grep -n "writeFile" src/server/update.ts`).

- [ ] **Step 5: Run to verify they pass**

Run: `bun test tests/update.test.ts`
Expected: PASS. The pre-existing tests for the dev-build refusal, the brew refusal, `--check`, the unwritable path and the unreachable release API are untouched and must still pass.

- [ ] **Step 6: Verify it by hand against a real tty**

Run: `bun run src/server/index.ts update --check`
Expected: reports current-or-newer and exits 0 without drawing a bar. (A source checkout is `0.0.0-dev`, so the dev-build refusal fires first — that is the correct behaviour and confirms the guard still runs before anything else.)

- [ ] **Step 7: Commit**

```bash
make test && make check && make check-clean
git add src/server/update.ts tests/update.test.ts
git commit -m "$(cat <<'MSG'
feat: update streams its download, and shows it moving

arrayBuffer() buffered the whole 83MB release in one await with no output
between "0.1.0 -> 0.2.0" and "updated", so a stalled download and a working
one looked identical. The body now streams to .paddock.new, hashing per chunk
and reporting through an injected sink.

SHA256SUMS is fetched first and alone: it is a few hundred bytes, so a release
published without a listed checksum fails before the download rather than
after. The passing check is no longer announced — a passing integrity check is
not news. The FAILING one is unchanged and still loud, and the real binary is
still untouched until after the digest is compared.
MSG
)"
```

---

## Task 7: the pairing input groups itself as you type

The field advertises `placeholder="XXXX-XXXX"` and then accepts eight ungrouped characters, so what the operator types never resembles what the terminal showed them. The same script mirrors Task 1's confusable mapping so the displayed value matches what the server will actually compare.

**Files:**
- Modify: `src/server/tunnel/gate.ts` (`pairingPage`'s inline script)
- Test: `tests/tunnel-pair-input.test.ts` (create)

**Interfaces:**
- Consumes: `ALPHABET` from `@server/tunnel/pairing` (Task 1's module; the constant itself is unchanged) and Task 1's `I`/`L` → `1`, `O` → `0` mapping, mirrored.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing test**

Create `tests/tunnel-pair-input.test.ts`. The DOM import must come first — `tests/support/dom.ts` registers happy-dom and its own header explains why order is load-bearing:

```ts
import "./support/dom";
import { expect, test } from "bun:test";
import { pairingPage } from "@server/tunnel/gate";
import { ALPHABET } from "@server/tunnel/pairing";

/**
 * Mounts the REAL page — its markup and its own inline script — rather than a
 * reimplementation of them. The page is self-contained by necessity (every
 * real asset stays behind the gate), so the script cannot be imported; running
 * the shipped string is the only way to test what actually reaches a phone.
 */
function mount(): HTMLInputElement {
  const page = pairingPage({ insecure: false });
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1];
  if (script === undefined) throw new Error("the pairing page has no inline script");
  const body = page.slice(page.indexOf("<body>") + "<body>".length, page.indexOf("</body>"));
  document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/, "");
  new Function(script)();
  const input = document.getElementById("c");
  if (input === null) throw new Error("the pairing page has no code input");
  return input as HTMLInputElement;
}

const type = (input: HTMLInputElement, value: string): string => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input.value;
};

test("a dash appears once the fifth character is typed", () => {
  const c = mount();
  expect(type(c, "4")).toBe("4");
  expect(type(c, "4F7K")).toBe("4F7K");
  expect(type(c, "4F7KQ")).toBe("4F7K-Q");
  expect(type(c, "4F7KQP2M")).toBe("4F7K-QP2M");
});

test("the input is upper-cased as it is typed", () => {
  const c = mount();
  expect(type(c, "4f7kqp2m")).toBe("4F7K-QP2M");
});

// Backspacing THROUGH the dash must not re-insert it and trap the cursor,
// which is how a naive formatter makes a field impossible to clear.
test("backspacing through the dash does not re-insert it", () => {
  const c = mount();
  expect(type(c, "4F7K-Q")).toBe("4F7K-Q");
  expect(type(c, "4F7K-")).toBe("4F7K");
  expect(type(c, "4F7K")).toBe("4F7K");
  expect(type(c, "4F7")).toBe("4F7");
  expect(type(c, "")).toBe("");
});

test("a pasted code is accepted in either shape, and not double-dashed", () => {
  const c = mount();
  expect(type(c, "4F7K-QP2M")).toBe("4F7K-QP2M");
  expect(type(c, "4F7KQP2M")).toBe("4F7K-QP2M");
  expect(type(c, "4f7k qp2m")).toBe("4F7K-QP2M");
});

// iOS autofill via autocomplete="one-time-code" sets the value and fires
// input without an ordinary keystroke.
test("an autofilled value is formatted like a typed one", () => {
  const c = mount();
  expect(type(c, "4F7KQP2M")).toBe("4F7K-QP2M");
});

test("nothing past eight characters is kept", () => {
  const c = mount();
  expect(type(c, "4F7KQP2MZZZZ")).toBe("4F7K-QP2M");
});

// Mirrors normalise() exactly. If these disagree, the field displays one code
// and the server compares another.
test("confusables are decoded as you type, matching the server", () => {
  const c = mount();
  expect(type(c, "O123456I")).toBe("0123-4561");
  expect(type(c, "L2345678")).toBe("1234-5678");
});

test("U is dropped as you type, exactly as the server drops it", () => {
  const c = mount();
  expect(type(c, "U1234567")).toBe("1234-567");
});

// One source for the alphabet. A hand-copied second list is how the page and
// the server come to disagree about what a code may contain.
test("the page carries the server's alphabet, not a copy of it", () => {
  expect(pairingPage({ insecure: false })).toContain(ALPHABET);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/tunnel-pair-input.test.ts`
Expected: FAIL — `expect("4F7KQ").toBe("4F7K-Q")`; there is no handler.

- [ ] **Step 3: Implement the grouping in the inline script**

In `src/server/tunnel/gate.ts`, add `ALPHABET` to the existing import:

```ts
import { ALPHABET, COOKIE_NAME, SESSION_MAX_AGE_S } from "@server/tunnel/pairing";
```

Then, inside `pairingPage`'s `<script>`, insert this immediately after the `var f = …, c = …, e = …` line and before the `submit` listener. Note the template interpolation of `ALPHABET` — the page must not carry a hand-copied second alphabet:

```js
  // Groups as you type, so the field looks like the XXXX-XXXX the terminal
  // showed. The whole value is reformatted on every input event, which is what
  // makes paste and iOS one-time-code autofill work without a second path.
  //
  // The I/L/O mapping MIRRORS normalise() in pairing.ts, which is
  // authoritative — it is duplicated here only so the field displays what the
  // server will actually compare. The alphabet is interpolated from the same
  // constant rather than copied, because a second list is how the two come to
  // disagree.
  var A = "${ALPHABET}";
  function fmt(v) {
    var up = String(v).toUpperCase(), out = "", ch;
    for (var i = 0; i < up.length && out.length < 8; i++) {
      ch = up.charAt(i);
      if (ch === "I" || ch === "L") ch = "1";
      else if (ch === "O") ch = "0";
      if (A.indexOf(ch) !== -1) out += ch;
    }
    return out.length > 4 ? out.slice(0, 4) + "-" + out.slice(4) : out;
  }
  c.addEventListener("input", function () {
    // Only when it actually changed: assigning `value` moves the caret to the
    // end, and doing that on every keystroke fights the operator. A four-
    // character value formats to itself, so backspacing through the dash
    // leaves the field alone rather than re-inserting it.
    var next = fmt(c.value);
    if (next !== c.value) {
      c.value = next;
      if (c.setSelectionRange) c.setSelectionRange(next.length, next.length);
    }
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/tunnel-pair-input.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Run the full suite**

Run: `make test 2>&1 | tail -20`
Expected: PASS. `tests/tunnel-gate.test.ts` asserts the page's markup and warning and is unaffected. If `tests/test-hygiene.test.ts` has a rule about new test files, satisfy it rather than exempting the file.

- [ ] **Step 6: Verify it in a browser by hand**

Run: `bun run src/server/index.ts tunnel` in one terminal, open the printed URL, and type the code with no dash. Expected: the dash appears after the fourth character, backspace clears the field cleanly, and the code pairs.

If `cloudflared` is not installed, exercise the same page locally instead: `PADDOCK_PORT=8788 bun run src/server/index.ts tunnel` still renders `pairingPage` for an unpaired navigation.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean
git add src/server/tunnel/gate.ts tests/tunnel-pair-input.test.ts
git commit -m "$(cat <<'MSG'
feat: the pairing field groups itself, like the placeholder promised

The input advertised XXXX-XXXX and then took eight ungrouped characters, so
what an operator typed never resembled what the terminal showed. The whole
value is reformatted on every input event, which is what makes paste and iOS
one-time-code autofill work without a second path, and the reassignment is
skipped when nothing changed so backspacing through the dash does not
re-insert it and trap the caret.

The I/L/O mapping mirrors normalise(), which stays authoritative; the alphabet
is interpolated from the same constant rather than copied.
MSG
)"
```

---

## Done

After Task 7:

```bash
make build          # check, check-clean, test, then compile
git log --oneline -7
```

**Do not tag or release.** The spec's release gate stands: Group B (the QR ruling) and Group C (Web Push) must also be done. Group A sits on `improve-ux` until then.
