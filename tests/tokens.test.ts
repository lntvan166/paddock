import { expect, test } from "bun:test";

const TOKENS = ["--bg", "--surface", "--border", "--fg", "--fg-dim", "--accent", "--warn", "--ok"];

async function css(): Promise<string> {
  return await Bun.file("src/web/styles.css").text();
}

test("every token is defined on bare :root", async () => {
  const text = await css();
  const root = text.slice(text.indexOf(":root {"), text.indexOf("}", text.indexOf(":root {")));
  for (const t of TOKENS) expect(root).toContain(t);
});

test("dark overrides are guarded so a manual light toggle wins", async () => {
  expect(await css()).toContain(':root:not([data-theme="light"])');
});

test("an explicit dark toggle is honoured", async () => {
  expect(await css()).toContain(':root[data-theme="dark"]');
});

test("body has an explicit background token", async () => {
  expect(await css()).toMatch(/body\s*\{[^}]*background:\s*var\(--bg\)/);
});

test("no webfont is loaded", async () => {
  const text = await css();
  expect(text).not.toContain("@font-face");
  expect(text).not.toContain("fonts.googleapis");
});
