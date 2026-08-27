import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

/**
 * A `//` comment among JSX children is TEXT, not a comment.
 *
 * Found the hard way. Wrapping the dashboard in `<AppShell>` left the
 * explanatory comment between the new opening tag and `<main>`, which put it
 * in child position — so three lines of source commentary rendered as visible
 * text at the top of the app:
 *
 *     // `screen`, not a flowing column: the header carries the counts…
 *
 * `tsc` cannot see this. It is valid JSX text, the types are fine, the build
 * succeeds, and every one of the 1886 tests passed with it on screen. It was
 * caught by reading the rendered DOM in a browser, which is not a thing that
 * happens on every change — hence this guard.
 *
 * Inside JSX the comment form is `{/* … *␘/}`. This test finds the other one.
 */

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(full);
    return e.isFile() && e.name.endsWith(".tsx") ? [full] : [];
  });
}

/**
 * Lines that look like a `//` comment sitting in child position: the previous
 * non-blank line closes a JSX tag, so what follows is rendered.
 *
 * Deliberately narrow. A `//` after `=> {` or `(` is ordinary code and must
 * not be reported, or the guard becomes noise and gets silenced — which is
 * the failure mode of every scanner.
 */
function strayComments(src: string): string[] {
  const lines = src.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim().startsWith("//")) continue;
    let prev = "";
    for (let j = i - 1; j >= 0; j -= 1) {
      if (lines[j]!.trim() !== "") { prev = lines[j]!.trim(); break; }
    }
    // A line ending in `>` that is not itself a comment, and not an arrow
    // function (`=>`), closes a JSX tag.
    if (prev.endsWith(">") && !prev.startsWith("//") && !prev.endsWith("=>")) {
      out.push(`${i + 1}: ${line.trim().slice(0, 70)}`);
    }
  }
  return out;
}

test("no // comment sits in JSX child position", () => {
  const offenders = tsxFiles("src/web")
    .flatMap((f) => strayComments(readFileSync(f, "utf8")).map((l) => `${f}:${l}`));
  expect(offenders, `these would render as visible text:\n${offenders.join("\n")}`).toEqual([]);
});

test("the detector actually detects the shape that shipped", () => {
  // A guard nobody has seen fail is a guard nobody knows works. This is the
  // exact source that put commentary on screen.
  const shipped = [
    '    <AppShell tab="agents" needsYou={needsYou} onSelect={goTab}>',
    "    // `screen`, not a flowing column: the header carries the counts and the",
    '    <main className="screen">',
  ].join("\n");
  expect(strayComments(shipped).length).toBe(1);
});

test("ordinary code comments are not reported", () => {
  // The guard has to stay quiet on the overwhelmingly common case, or it gets
  // silenced — which is how a scanner stops protecting anything.
  const fine = [
    "  const goTab = (key: TabKey) => {",
    "    // Tabs are peers, not a stack.",
    "    location.hash = TAB_HASH[key];",
    "  };",
  ].join("\n");
  expect(strayComments(fine)).toEqual([]);
});
