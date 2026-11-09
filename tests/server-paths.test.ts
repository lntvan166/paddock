import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { expandHome as expandBranded, tildeise } from "@server/paths";

const expandHome = (cwd: string, home?: string): string | null => expandBranded(cwd, home);

/**
 * The tilde is paddock's own convention, and BOTH backends' trees apply it —
 * so it lives in a module neither backend owns. It used to sit in
 * `herdr/tree.ts`, which made `herdr-core/tree.ts` import terminal herdr's
 * module to tilde-ise an app pane's folder: the one cross-backend import in
 * the tree, and the shape CLAUDE.md's rule 2 ("`src/server/herdr/` is the only
 * code that knows herdr exists") is there to prevent.
 */

test("tildeise and expandHome are inverses, from the neutral module", () => {
  expect(tildeise("/base/operator/work", "/base/operator")).toBe("~/work");
  expect(tildeise("/base/operator", "/base/operator/")).toBe("~");
  expect(tildeise("/srv/elsewhere", "/base/operator")).toBe("/srv/elsewhere");
  expect(expandHome("~/work", "/base/operator")).toBe("/base/operator/work");
  expect(expandHome("~", "/base/operator")).toBe("/base/operator");
  expect(expandHome("relative", "/base/operator")).toBeNull();
});

test("no herdr-core module imports terminal herdr's tree", () => {
  for (const f of readdirSync("src/server/herdr-core")) {
    const src = readFileSync(`src/server/herdr-core/${f}`, "utf8");
    expect(src, `${f} reaches into herdr/tree`).not.toContain("@server/herdr/tree");
  }
});

test("the path helpers are not defined twice", () => {
  // Moved, not copied: two tilde rules would drift, and the drift is a
  // username on a screen.
  const herdrTree = readFileSync("src/server/herdr/tree.ts", "utf8");
  expect(herdrTree).not.toContain("export function tildeise");
  expect(herdrTree).not.toContain("export function expandHome");
});
