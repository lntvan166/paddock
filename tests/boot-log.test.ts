import { expect, test } from "bun:test";
import { BootLog } from "@server/boot-log";

test("nothing noted means nothing to print — demo mode never touches herdr", () => {
  expect(new BootLog().summary()).toBeNull();
});

test("the three boot facts collapse into one line", () => {
  const b = new BootLog();
  b.noteStream(true);
  b.notePanes(1);
  b.noteShape("ok");
  expect(b.summary()).toBe("herdr: connected · 1 pane · every field paddock reads is present");
});

test("panes are pluralised", () => {
  const b = new BootLog();
  b.noteStream(true);
  b.notePanes(3);
  expect(b.summary()).toBe("herdr: connected · 3 panes");
});

test("zero panes is reported, not omitted — it is why the contract is unverified", () => {
  const b = new BootLog();
  b.noteStream(true);
  b.notePanes(0);
  b.noteShape("unknown");
  expect(b.summary()).toBe("herdr: connected · 0 panes · no panes to inspect, contract unverified");
});

// The loudest failure this project has must not become a clause in a status
// line. `shapeMessage` prints it in full on its own path.
test("a broken shape is NOT folded into the summary", () => {
  const b = new BootLog();
  b.noteStream(true);
  b.notePanes(2);
  b.noteShape("broken");
  const line = b.summary()!;
  expect(line).toBe("herdr: connected · 2 panes");
  expect(line).not.toContain("broken");
});

test("a stream that came up down is reported as such", () => {
  const b = new BootLog();
  b.noteStream(false);
  expect(b.summary()).toBe("herdr: not connected");
});

test("boot ends exactly once and stays ended", () => {
  const b = new BootLog();
  expect(b.inBoot).toBe(true);
  b.end();
  expect(b.inBoot).toBe(false);
  b.end();
  expect(b.inBoot).toBe(false);
});
