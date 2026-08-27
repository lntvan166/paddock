// FIRST: React reads `document` at import time. See terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { digestOf } from "@shared/screen";
import { AgentTerminal } from "@web/components/AgentTerminal";
import {
  agent, click, render, settle, stubFetch, textsOf, typeInto, unmount,
} from "./support/render";

const realFetch = globalThis.fetch;

afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
  localStorage.removeItem("paddock.term.keypad");
  localStorage.removeItem("paddock.term.keypad.auto");
});

const screenOf = (lines: string[]) => ({ lines, source: "visible", digest: digestOf(lines) });

/** Invented, per the fixture rule — never a real project's commands. */
const COMMANDS = [
  { command: "/changelog", description: "Update the changelog from recent commits", source: "command" },
  { command: "/check-migrations", description: "Verify pending migrations", source: "command" },
  { command: "/release-notes", description: "Draft notes for the next tag", source: "skill" },
];

async function mount(commands: unknown[] = COMMANDS) {
  const { fn, calls } = stubFetch({
    "/commands": () => ({ ok: true, commands }),
    "/output": () => screenOf(["$ ready"]),
  });
  globalThis.fetch = fn as typeof fetch;
  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();
  const input = host.querySelector<HTMLInputElement>("#term-reply-input");
  if (!input) throw new Error("no reply input");
  return { host, input, calls };
}

test("a leading slash offers the project's commands", async () => {
  const { host, input } = await mount();

  await typeInto(input, "/");

  expect(textsOf(host, ".term-cmd-name")).toEqual([
    "/changelog",
    "/check-migrations",
    "/release-notes",
  ]);
});

test("typing narrows the list, best match first", async () => {
  const { host, input } = await mount();

  await typeInto(input, "/ch");

  expect(textsOf(host, ".term-cmd-name")).toEqual(["/changelog", "/check-migrations"]);
});

test("an ordinary reply offers nothing", async () => {
  // The regression this guards: a slash inside a path must not open the list.
  const { host, input } = await mount();

  await typeInto(input, "look in src/web");

  expect(host.querySelector(".term-cmds")).toBeNull();
});

test("picking a command fills the field and does not send it", async () => {
  const { host, input, calls } = await mount();
  await typeInto(input, "/ch");

  await click(host.querySelector(".term-cmd"));

  // The trailing space is load-bearing twice over: it is where the argument
  // goes, and it closes the list — because a space means the name is settled.
  expect(input.value).toBe("/changelog ");
  expect(host.querySelector(".term-cmds"), "the list closes itself").toBeNull();
  expect(
    calls.filter((c) => c.url.includes("/text") || c.url.includes("/answer")),
    "picking must never reach the agent — Send stays the operator's",
  ).toEqual([]);
});

test("a project with no commands says so, rather than showing nothing", async () => {
  // Most repositories. An empty list that simply fails to appear is
  // indistinguishable from a broken feature.
  const { host, input } = await mount([]);

  await typeInto(input, "/");

  expect(host.querySelector(".term-cmd-empty")?.textContent).toContain("No commands");
});

test("a term matching nothing says so too", async () => {
  const { host, input } = await mount();

  await typeInto(input, "/zzz");

  expect(host.querySelector(".term-cmd-empty")?.textContent).toContain("No match");
  expect(textsOf(host, ".term-cmd-name"), "and offers nothing").toEqual([]);
});

test("the list is fetched once for the agent, not once per keystroke", async () => {
  const { input, calls } = await mount();

  await typeInto(input, "/");
  await typeInto(input, "/c");
  await typeInto(input, "/ch");

  expect(calls.filter((c) => c.url.includes("/commands"))).toHaveLength(1);
});

test("a failed fetch costs the list and nothing else", async () => {
  // The reply field has to keep working. No error surface for a convenience
  // the operator did not ask for.
  const { fn } = stubFetch({ "/output": () => screenOf(["$ ready"]) });
  globalThis.fetch = fn as typeof fetch;
  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();
  const input = host.querySelector<HTMLInputElement>("#term-reply-input")!;

  await typeInto(input, "/");

  expect(host.querySelector(".term-error")).toBeNull();
  expect(input.value, "the field still holds what was typed").toBe("/");
});

test("a command mid-sentence offers the list, and picking keeps the sentence", async () => {
  // The reported gap: the list only opened when the reply STARTED with a
  // slash, but a command is often the second half of a sentence.
  const { host, input } = await mount();

  await typeInto(input, "please run /ch");

  expect(textsOf(host, ".term-cmd-name")).toEqual(["/changelog", "/check-migrations"]);

  await click(host.querySelector(".term-cmd"));

  expect(input.value).toBe("please run /changelog ");
});

test("a slash inside a path still offers nothing", async () => {
  const { host, input } = await mount();

  await typeInto(input, "check the file at src/web/api.ts");

  expect(host.querySelector(".term-cmds")).toBeNull();
});
