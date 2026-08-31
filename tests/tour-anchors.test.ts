import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { TOUR_ANCHORS } from "@shared/tour-anchors";

/**
 * The tour points at controls it does not own. Without this test a renamed
 * class or a restructured component leaves an arrow pointing at empty space —
 * on the one page people look at paddock without running it, and with nothing
 * in the suite able to notice.
 *
 * Static, deliberately: the alternative is booting the app in happy-dom and
 * navigating to six screens, which tests the harness more than the contract.
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = sources("src/web");
const web = files.map((p) => readFileSync(p, "utf8")).join("\n");

/**
 * The anchor names actually rendered.
 *
 * `[^"]*` between the attribute and the value because one of these is a
 * ternary — `data-tour={key === "needs-you" ? ...}` — and a literal
 * `data-tour="` match would silently miss it, which is exactly the undercount
 * this file exists to prevent.
 */
const rendered = new Set([...web.matchAll(/data-tour[^"]*"([a-z-]+)"/g)].map((m) => m[1]!));

test("every anchor the tour names exists in the app", () => {
  for (const a of TOUR_ANCHORS) {
    expect([...rendered], `no component renders data-tour="${a}"`).toContain(a);
  }
});

test("every data-tour in the app is one the tour knows about", () => {
  // The other direction. An orphan attribute is dead weight in the operator's
  // bundle and a hint that a step was deleted without its anchor.
  expect(rendered.size, "the anchor scan found nothing to check").toBeGreaterThan(0);
  for (const f of rendered) {
    expect(TOUR_ANCHORS as readonly string[], `data-tour="${f}" matches no step`).toContain(f);
  }
});

test("the anchors are unconditional, not branched on the demo flag", () => {
  // demo.yml states the property that keeps the demo honest: "there are no demo
  // branches in any component." An attribute behind import.meta.env would be
  // exactly such a branch, and would also mean the anchors are absent from the
  // build anyone could ever debug.
  for (const p of files) {
    const s = readFileSync(p, "utf8");
    if (!s.includes("data-tour")) continue;
    for (const line of s.split("\n")) {
      if (!line.includes("data-tour")) continue;
      expect(line, `${p}: data-tour is conditional on the demo flag`).not.toContain(
        "VITE_PADDOCK_DEMO",
      );
    }
  }
});
