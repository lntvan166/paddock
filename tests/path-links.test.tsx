// FIRST: React reads `document` at import time. See terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { digestOf } from "@shared/screen";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { agent, click, render, settle, stubFetch, unmount } from "./support/render";

const realFetch = globalThis.fetch;

afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
  location.hash = "";
  localStorage.removeItem("paddock.term.keypad");
});

const screenOf = (lines: string[]) => ({ lines, source: "visible", digest: digestOf(lines) });

async function mount(lines: string[], routes: Record<string, () => unknown> = {}) {
  const { fn, calls } = stubFetch({
    "/output": () => screenOf(lines),
    "/commands": () => ({ ok: true, commands: [] }),
    "/api/files": () => ({ ok: true, id: "a".repeat(32), name: "design.html", render: "iframe" }),
    ...routes,
  });
  globalThis.fetch = fn as typeof fetch;
  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();
  return { host, calls };
}

test("a path in the output is tappable, and opening it asks the server", async () => {
  const { host, calls } = await mount(["wrote /srv/project/design.html"]);

  const link = host.querySelector(".term-path");
  expect(link?.textContent).toBe("/srv/project/design.html");

  await click(link);
  await settle();

  const asked = calls.find((c) => c.url.includes("/api/files"));
  expect((asked?.body as { path: string }).path).toBe("/srv/project/design.html");
});

test("a successful open navigates to the file's own route", async () => {
  // `#/file/:id` rather than a sheet: a phone backgrounds tabs, and the route
  // is what survives the reload.
  const { host } = await mount(["wrote /srv/project/design.html"]);

  await click(host.querySelector(".term-path"));
  await settle();

  expect(location.hash).toBe(`#/file/${"a".repeat(32)}`);
});

test("a refused open says what the server said, and does not navigate", async () => {
  const { host } = await mount(["wrote /srv/project/gone.html"], {
    "/api/files": () => ({ ok: false, detail: "no file at /srv/project/gone.html" }),
  });

  await click(host.querySelector(".term-path"));
  await settle();

  expect(location.hash, "still on the terminal").toBe("");
  expect(host.textContent).toContain("no file at");
});

test("ordinary output grows no links", async () => {
  // The regression this guards: a slash inside a word is not an address.
  const { host } = await mount(["reading src/web/api.ts now"]);
  expect(host.querySelector(".term-path")).toBeNull();
});

/**
 * A relative path in the transcript, and the id that gives it a meaning.
 *
 * The route resolves `docs/report.md` against the agent's `cwd`, which it reads
 * from its own store — so the ONE thing the client has to get right is naming
 * the agent. A route test cannot see that: it posts the id itself. Miss it here
 * and every relative tap answers "this pane has no working directory", with the
 * server behaving perfectly.
 */
test("a relative path is tappable, and names the pane it came from", async () => {
  const { host, calls } = await mount(["wrote docs/report.md"]);

  const link = host.querySelector(".term-path");
  expect(link?.textContent, "a relative path is not linked at all").toBe("docs/report.md");

  await click(link);
  await settle();

  const asked = calls.find((c) => c.url.includes("/api/files"));
  const body = asked?.body as { path: string; agentId?: string };
  expect(body.path).toBe("docs/report.md");
  expect(body.agentId, "the server has no agent to resolve against").toBe(agent().agentId);
});

test("an absolute path names the pane too, and is unaffected by it", async () => {
  // Sent either way rather than only for relative paths: the client would
  // otherwise have to decide what "relative" means, and that judgement already
  // lives in one place on the server.
  const { calls, host } = await mount(["wrote /srv/project/design.html"]);
  await click(host.querySelector(".term-path"));
  await settle();
  const body = calls.find((c) => c.url.includes("/api/files"))?.body as { agentId?: string };
  expect(body.agentId).toBe(agent().agentId);
});

test("a relative token the viewer cannot render is not a link", async () => {
  // The gate that keeps `and/or` and a source path out of the transcript's
  // links. Asserted through the component, because this is where a widened
  // regex would show up as prose turning blue.
  const { host } = await mount(["read src/web/api.ts and/or the docs"]);
  expect(host.querySelectorAll(".term-path").length).toBe(0);
});
