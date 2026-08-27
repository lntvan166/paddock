// FIRST: React reads `document` at import time. See terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { digestOf } from "@shared/screen";
import { AgentTerminal } from "@web/components/AgentTerminal";
import {
  agent, click, fire, render, settle, stubFetch, textsOf, typeInto, unmount,
} from "./support/render";

const realFetch = globalThis.fetch;

afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
  localStorage.removeItem("paddock.term.keypad");
  localStorage.removeItem("paddock.term.keypad.auto");
});

const screenOf = (lines: string[]) => ({ lines, source: "visible", digest: digestOf(lines) });
const UPLOADED = { ok: true, path: "/srv/config/uploads/2026-08-27-a3f9c1e8.png", name: "2026-08-27-a3f9c1e8.png" };

async function mount(routes: Record<string, () => unknown> = {}) {
  const { fn, calls } = stubFetch({
    "/output": () => screenOf(["$ ready"]),
    "/commands": () => ({ ok: true, commands: [] }),
    "/image": () => UPLOADED,
    "/text": () => ({ ok: true, lines: ["$ sent"] }),
    ...routes,
  });
  globalThis.fetch = fn as typeof fetch;
  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();
  return { host, calls };
}

/** A file input cannot be driven by typing; `files` is defined directly. */
async function choose(host: HTMLElement, ...files: File[]) {
  const input = host.querySelector<HTMLInputElement>("#term-attach-input");
  if (!input) throw new Error("no attach input");
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await fire(input, new Event("change", { bubbles: true }));
  await settle();
}

const png = (name: string) =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });

test("the attach control sits before the field, where a thumb expects it", async () => {
  // Messenger, WhatsApp and iMessage all put it left of the input. Asserted on
  // DOM ORDER rather than on a style, because that is what decides both the
  // visual position and the tab order.
  const { host } = await mount();

  const row = host.querySelector(".term-reply");
  const kids = [...(row?.children ?? [])];
  const attachAt = kids.findIndex((k) => k.classList.contains("term-attach"));
  const fieldAt = kids.findIndex((k) => k.querySelector?.("#term-reply-input") || k.id === "term-reply-input");

  expect(attachAt).toBeGreaterThanOrEqual(0);
  expect(attachAt).toBeLessThan(fieldAt);
});

test("choosing an image uploads it and shows its own name", async () => {
  const { host, calls } = await mount();

  await choose(host, png("screenshot.png"));

  expect(calls.filter((c) => c.url.includes("/image"))).toHaveLength(1);
  expect(textsOf(host, ".term-att-name")).toEqual(["screenshot.png"]);
});

test("an unnamed capture is numbered instead", async () => {
  // A camera capture often arrives with no filename; a Photo Library pick
  // usually has one.
  const { host } = await mount();

  await choose(host, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "", { type: "image/png" }));

  expect(textsOf(host, ".term-att-name")).toEqual(["[image 1]"]);
});

test("the path is not in the field — it is composed at send", async () => {
  // The whole reason the attachment is state rather than text: the operator
  // reads a name, the agent receives a path.
  const { host, calls } = await mount();
  await choose(host, png("shot.png"));

  const field = host.querySelector<HTMLInputElement>("#term-reply-input")!;
  expect(field.value, "the field stays the operator's").toBe("");

  await click(host.querySelector(".term-reply button[type=submit]"));

  const sent = calls.find((c) => c.url.includes("/text"))?.body as { text: string };
  expect(sent.text).toBe(UPLOADED.path);
});

test("words are sent after the path, not instead of it", async () => {
  const { host, calls } = await mount();
  await choose(host, png("shot.png"));
  const field = host.querySelector<HTMLInputElement>("#term-reply-input")!;
  await typeInto(field, "the left one");

  await click(host.querySelector(".term-reply button[type=submit]"));

  const sent = calls.find((c) => c.url.includes("/text"))?.body as { text: string };
  expect(sent.text).toBe(`${UPLOADED.path} the left one`);
});

test("an attachment can be removed before sending", async () => {
  const { host } = await mount();
  await choose(host, png("wrong.png"));

  await click(host.querySelector(".term-att-x"));

  expect(host.querySelector(".term-att")).toBeNull();
});

test("a refused upload says what the server said", async () => {
  const { host } = await mount({
    "/image": () => ({ ok: false, detail: "that is not a PNG, JPEG, GIF or WebP" }),
  });

  await choose(host, png("notes.txt"));

  expect(host.textContent).toContain("not a PNG");
  expect(host.querySelector(".term-att"), "and nothing is attached").toBeNull();
});

/** A fetch whose /image response the test resolves by hand. */
function deferredUpload() {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/image")) {
      await gate;
      return json(UPLOADED);
    }
    if (url.includes("/output")) return json(screenOf(["$ ready"]));
    if (url.includes("/commands")) return json({ ok: true, commands: [] });
    if (url.includes("/text")) return json({ ok: true, lines: ["$ sent"] });
    return json({ ok: false }, 500);
  };
  return { fn, release: () => release?.() };
}

test("an upload in flight is visible, and cannot be removed or sent", async () => {
  // Reported from a phone: nothing said anything was happening. A photo over a
  // tunnel is seconds, which is long enough to look broken.
  const { fn, release } = deferredUpload();
  globalThis.fetch = fn as typeof fetch;
  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();

  await choose(host, png("slow.png"));

  expect(textsOf(host, ".term-att-name")).toEqual(["slow.png"]);
  expect(host.querySelector(".term-att-spin"), "says it is working").not.toBeNull();
  expect(host.querySelector(".term-att-x"), "cannot be cancelled mid-flight").toBeNull();
  // The correctness half: composing now would send an empty path for a file
  // that has no path yet.
  expect(
    host.querySelector<HTMLButtonElement>(".term-reply button[type=submit]")?.disabled,
    "Send waits for the upload",
  ).toBe(true);

  release();
  await settle();
  await settle();

  expect(host.querySelector(".term-att-spin"), "the spinner goes").toBeNull();
  expect(host.querySelector(".term-att-x"), "and the ✕ arrives").not.toBeNull();
  expect(
    host.querySelector<HTMLButtonElement>(".term-reply button[type=submit]")?.disabled,
  ).toBe(false);
});

test("a failed upload leaves no chip behind", async () => {
  const { host } = await mount({
    "/image": () => ({ ok: false, detail: "that is not a PNG, JPEG, GIF or WebP" }),
  });

  await choose(host, png("bad.png"));

  expect(host.querySelector(".term-att"), "the pending chip is withdrawn").toBeNull();
});

/** A paste, built by hand: happy-dom has no ClipboardEvent with files. */
function pasteEvent(files: File[], text = ""): Event {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: {
      files,
      items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
      getData: () => text,
    },
  });
  return ev;
}

test("pasting a screenshot attaches it, without touching the picker", async () => {
  // The common case by a wide margin: you screenshot something, copy it, and
  // want the agent to look at it. Going through Photos for an image already on
  // the clipboard is three taps for nothing.
  const { host, calls } = await mount();
  const field = host.querySelector<HTMLInputElement>("#term-reply-input")!;

  const ev = pasteEvent([png("Screenshot.png")]);
  await fire(field, ev);
  await settle();

  expect(calls.filter((c) => c.url.includes("/image"))).toHaveLength(1);
  expect(textsOf(host, ".term-att-name")).toEqual(["Screenshot.png"]);
  expect(ev.defaultPrevented, "the filename must not also be typed into the field").toBe(true);
});

test("pasting text is left entirely alone", async () => {
  // The regression this guards: intercepting every paste would break pasting a
  // command or an error message into the reply, which is ordinary use.
  const { host, calls } = await mount();
  const field = host.querySelector<HTMLInputElement>("#term-reply-input")!;

  const ev = pasteEvent([], "npm run build");
  await fire(field, ev);
  await settle();

  expect(calls.filter((c) => c.url.includes("/image"))).toEqual([]);
  expect(ev.defaultPrevented, "the browser still does the pasting").toBe(false);
});

test("a chip carries a thumbnail of the actual image", async () => {
  // A filename cannot tell two screenshots apart, and picking the wrong one is
  // the likely mistake.
  const { host } = await mount();

  await choose(host, png("shot.png"));

  const img = host.querySelector<HTMLImageElement>(".term-att-thumb");
  expect(img, "there is a thumbnail").not.toBeNull();
  expect(img?.getAttribute("src")).toBeTruthy();
  expect(img?.getAttribute("alt"), "decorative — the name is beside it").toBe("");
});

test("removing an attachment releases its thumbnail", async () => {
  // An object URL pins the whole image in memory until it is revoked, and this
  // is a long-lived page on a phone.
  const revoked: string[] = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:stub-1";
  URL.revokeObjectURL = (u: string) => { revoked.push(u); };
  try {
    const { host } = await mount();
    await choose(host, png("shot.png"));

    await click(host.querySelector(".term-att-x"));

    expect(revoked).toEqual(["blob:stub-1"]);
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
});

test("leaving the agent releases any thumbnail still held", async () => {
  // `AgentDetail` is keyed by agent id, so switching agents unmounts this
  // component — and an object URL with nothing left to revoke it is a leak on
  // a page that stays open for days.
  const revoked: string[] = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:stub-2";
  URL.revokeObjectURL = (u: string) => { revoked.push(u); };
  try {
    const { host } = await mount();
    await choose(host, png("shot.png"));
    expect(revoked, "nothing released while it is on screen").toEqual([]);

    await unmount();

    expect(revoked).toEqual(["blob:stub-2"]);
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
});
