// FIRST: React reads `document` at import time.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Settings } from "@web/components/Settings";
import { render, settle, stubFetch, typeInto, unmount } from "./support/render";

const realFetch = globalThis.fetch;
afterEach(async () => { await unmount(); globalThis.fetch = realFetch; });

const view = () => ({
  telegram: { configured: true, hint: "7f21", chatId: "555" },
  notify: {
    enabled: true, triggers: ["blocked"],
    settleMs: { blocked: 5_000, done: 10_000 }, mutedUntil: null, cooldownMs: 60_000,
  },
  publicUrl: null, serverNow: 1_700_000_000_000, error: null,
});

/**
 * `stubFetch` matches by `url.includes(key)` and takes the FIRST key that
 * matches, in object order — and "/api/settings/mute" contains
 * "/api/settings". So wherever both appear, the more specific key MUST come
 * first, or a mute POST is answered with the settings view and the test
 * passes for the wrong reason.
 */
async function mounted() {
  const stub = stubFetch({ "/api/settings": () => view() });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  return { host, stub };
}

/**
 * A stub that behaves like the real server: a PUT persists into the stored
 * view and the response echoes the MERGED result back, rather than a static
 * fixture that ignores what was sent. `stubFetch` cannot do this — its routes
 * take no arguments — and a static echo is exactly what let a real bug slip
 * past once already: `Settings.tsx`'s `save()` re-syncs every field from the
 * PUT response, not just `baseline`, because the server is the source of
 * truth for what actually got persisted and may not return exactly what was
 * sent. A stub that always answers with the same fixture can't exercise that
 * at all. `chatId` is trimmed here on the way in to stand in for that kind of
 * server-side normalisation (see the test below for why `chatId`, not
 * `publicUrl`, is what actually exercises it).
 */
function fakeServerFetch() {
  let stored = view();
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/settings") && !u.includes("/telegram") && init?.method === "PUT") {
      const patch = init.body ? JSON.parse(String(init.body)) : {};
      const chatIdIn = patch.telegram?.chatId as string | null | undefined;
      stored = {
        ...stored,
        telegram: {
          ...stored.telegram,
          chatId: typeof chatIdIn === "string" ? chatIdIn.trim() : (chatIdIn ?? stored.telegram.chatId),
        },
        notify: { ...stored.notify, ...(patch.notify ?? {}) },
        publicUrl: "publicUrl" in patch ? patch.publicUrl : stored.publicUrl,
      };
    }
    return new Response(JSON.stringify(stored), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("the save bar is absent until something is dirty", async () => {
  // It costs no screen space while the operator is only reading.
  const { host } = await mounted();
  expect(host.querySelector(".settings-save-bar")).toBeNull();
});

test("editing a field raises the save bar", async () => {
  // The reported problem: Save sat at the bottom of a long form, the operator
  // changed a field near the top, never scrolled, and left believing it took.
  const { host } = await mounted();
  const chatId = host.querySelector<HTMLInputElement>('input[name="chatId"]')!;
  // `typeInto`, never `chatId.value = …`: React installs its own value
  // accessor, and under happy-dom its change plugin ignores a bare `input`
  // event — both failures are SILENT, so the test would assert against the
  // component's original state and read as coverage while providing none.
  // tests/support/render.tsx documents the measurement.
  typeInto(chatId, "999");
  await settle();
  const bar = host.querySelector(".settings-save-bar");
  expect(bar).not.toBeNull();
  expect(bar!.textContent).toContain("Unsaved changes");
});

test("typing a token counts as dirty even though the field starts empty", async () => {
  // The token is write-only, so there is no baseline to compare against —
  // anything typed IS a change.
  const { host } = await mounted();
  const token = host.querySelector<HTMLInputElement>('input[name="token"]')!;
  typeInto(token, "999:BBtyped");
  await settle();
  expect(host.querySelector(".settings-save-bar")).not.toBeNull();
});

test("a successful save clears the bar and announces itself in a live region", async () => {
  globalThis.fetch = fakeServerFetch();
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  const chatId = host.querySelector<HTMLInputElement>('input[name="chatId"]')!;
  typeInto(chatId, "999");
  await settle();
  host.querySelector<HTMLButtonElement>(".settings-save-bar button")!.click();
  await settle();
  await settle();
  const toast = host.querySelector(".settings-toast");
  expect(toast).not.toBeNull();
  expect(toast!.getAttribute("role")).toBe("status");
  expect(toast!.textContent).toContain("saved");
  expect(host.querySelector(".settings-save-bar")).toBeNull();
});

test("a save whose persisted value differs from what was typed still clears the bar", async () => {
  // The motivating case is `save()`'s `publicUrl: publicUrl.trim() || null` —
  // if the PUT response were re-synced only into `baseline` and not into the
  // visible fields, `dirty` would keep comparing an untrimmed field against a
  // trimmed baseline forever, and the bar would sit there after a perfectly
  // successful save.
  //
  // That EXACT scenario cannot be driven through this test, though: `publicUrl`
  // is rendered as `<input type="url">`, and the HTML value-sanitization
  // algorithm for that input type strips leading/trailing whitespace at the
  // DOM level, before React's `onChange` ever sees it — confirmed empirically
  // against happy-dom, which implements the same algorithm real browsers do.
  // A padded string typed into that field never reaches component state at
  // all, so a whitespace test against `publicUrl` specifically would pass
  // whether or not the re-sync exists — decorative coverage.
  //
  // `chatId` is a plain `type="text"` input with no such sanitization, so it
  // is used here as a reachable stand-in for the same mechanism: `save()`
  // does not trim `chatId`, but `fakeServerFetch` above does (representing
  // the general case the resync defends — ANY field the server normalises on
  // the way in, not only the one line that happens to trim client-side).
  // Removing the field re-sync in `save()` (keeping only `setBaseline`) turns
  // this red.
  globalThis.fetch = fakeServerFetch();
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  const chatId = host.querySelector<HTMLInputElement>('input[name="chatId"]')!;
  typeInto(chatId, "  999  ");
  await settle();
  expect(host.querySelector(".settings-save-bar")).not.toBeNull();
  host.querySelector<HTMLButtonElement>(".settings-save-bar button")!.click();
  await settle();
  await settle();
  expect(host.querySelector(".settings-save-bar")).toBeNull();
});

test("a failed save keeps the bar and uses the persistent banner, not the toast", async () => {
  // An error the operator must catch within three seconds is a swallowed
  // error.
  // Hand-rolled rather than stubFetch, because this needs the GET to succeed
  // and the PUT to the SAME path to fail.
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("/api/settings") && init?.method === "PUT") {
      return new Response(JSON.stringify({ detail: "chat id must be numeric" }),
        { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(view()), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  const chatId = host.querySelector<HTMLInputElement>('input[name="chatId"]')!;
  typeInto(chatId, "nope");
  await settle();
  host.querySelector<HTMLButtonElement>(".settings-save-bar button")!.click();
  await settle();
  await settle();
  expect(host.querySelector(".settings-toast")).toBeNull();
  expect(host.querySelector(".settings-banner")!.textContent).toContain("chat id must be numeric");
  expect(host.querySelector(".settings-save-bar")).not.toBeNull();
});

test("the test button posts the on-screen token, not an empty body", async () => {
  const stub = stubFetch({
    "/api/settings/telegram/test": () => ({ ok: true, detail: null }),
    "/api/settings": () => view(),
  });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  const token = host.querySelector<HTMLInputElement>('input[name="token"]')!;
  typeInto(token, "999:BBtyped");
  await settle();
  const buttons = [...host.querySelectorAll("button")];
  buttons.find((b) => (b.textContent ?? "").includes("test"))!.click();
  await settle();
  await settle();
  const call = stub.calls.find((c) => c.url.includes("/telegram/test"))!;
  expect(call.body).toEqual({ token: "999:BBtyped", chatId: "555" });
});
