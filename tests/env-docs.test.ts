import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `PADDOCK_NO_UPDATE_CHECK` shipped documented nowhere an operator would look
 * — not in `.env.example`, not in `README.md`, not in `docs/architecture.md`.
 * It is the only control over whether a dashboard bound to loopback ever talks
 * to github.com, and for a project this careful about not leaking usage timing
 * an undiscoverable off switch is not really an off switch.
 *
 * The general rule is the useful one, so that is what is asserted: every
 * environment variable the server actually reads has to be documented.
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts") && !p.endsWith("embedded.ts")) out.push(p);
  }
  return out;
}

const architecture = readFileSync("docs/architecture.md", "utf8");
const envExample = readFileSync(".env.example", "utf8");
const readme = readFileSync("README.md", "utf8");

const referenced = new Set<string>();
for (const file of sourceFiles("src/server")) {
  for (const m of readFileSync(file, "utf8").matchAll(/\bPADDOCK_[A-Z0-9_]+\b/g)) {
    referenced.add(m[0]);
  }
}

test("the server reads the environment variables this suite thinks it does", () => {
  // A sanity check on the scan itself: if this ever comes back empty the
  // assertions below would pass vacuously.
  expect(referenced.size).toBeGreaterThan(5);
  expect(referenced.has("PADDOCK_NO_UPDATE_CHECK")).toBe(true);
});

test("every environment variable the server reads is documented in docs/architecture.md", () => {
  const undocumented = [...referenced].filter((v) => !architecture.includes(v)).sort();
  expect(undocumented, "add these to the Environment table").toEqual([]);
});

test("the update check's off switch and its cache file are documented where an operator looks", () => {
  // Three places, because they answer three different questions: .env.example
  // is what gets copied and edited, README.md is what someone reads before
  // installing, and architecture.md is where the reasoning lives.
  for (const [name, text] of [
    [".env.example", envExample],
    ["README.md", readme],
    ["docs/architecture.md", architecture],
  ] as const) {
    expect(text, `${name} must name PADDOCK_NO_UPDATE_CHECK`).toContain("PADDOCK_NO_UPDATE_CHECK");
    expect(text, `${name} must name the cache file`).toContain("update-check.json");
  }
});
