// FIRST: React reads `document` at import time. See terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { FileViewer } from "@web/components/FileViewer";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

const ID = "0123456789abcdef0123456789abcdef";
const view = (over: Partial<Parameters<typeof FileViewer>[0]> = {}) => (
  <FileViewer id={ID} name="design.html" render="iframe" onBack={() => {}} {...over} />
);

test("a page renders in a frame that is sandboxed here too", async () => {
  const host = await render(view());

  const frame = host.querySelector("iframe");
  expect(frame?.getAttribute("src")).toBe(`/api/files/${ID}`);
  // Belt to the response header's braces. The attribute protects THIS page from
  // what it embeds; the header protects against the URL being opened directly.
  // `allow-same-origin` is absent on purpose — with it the frame would be
  // same-origin with paddock again, which is the whole thing being prevented.
  expect(frame?.getAttribute("sandbox")).toBe("");
});

test("an image renders inline, named for the file", async () => {
  const host = await render(view({ name: "shot.png", render: "image" }));

  const img = host.querySelector("img.file-image");
  expect(img?.getAttribute("src")).toBe(`/api/files/${ID}`);
  expect(img?.getAttribute("alt")).toBe("shot.png");
});

test("an unrenderable file says so, and offers itself whole", async () => {
  const host = await render(view({ name: "a.tar.gz", render: "download" }));

  expect(host.querySelector("iframe")).toBeNull();
  expect(host.textContent).toContain("cannot be shown");
});

test("download is offered whatever the type", async () => {
  // The operator's own framing: "open or download it if I want."
  for (const mode of ["iframe", "image", "text", "download"] as const) {
    const host = await render(view({ render: mode }));
    const link = host.querySelector("a.file-download");
    expect(link?.getAttribute("href"), mode).toBe(`/api/files/${ID}/download`);
    expect(link?.getAttribute("download"), mode).toBe("design.html");
    await unmount();
  }
});

test("the file's name is the screen's title", async () => {
  const host = await render(view());
  expect(host.querySelector(".file-title")?.textContent).toBe("design.html");
});

test("back is a real control, named", async () => {
  const host = await render(view());
  expect(host.querySelector("button[aria-label=Back]")).not.toBeNull();
});
