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
 * view and the response echoes the MERGED result back verbatim, rather than a
 * static fixture that ignores what was sent. `stubFetch` cannot do this — its
 * routes take no arguments — and a static echo would let the bar/toast tests
 * pass whether or not `save()` actually used the response at all. The merge
 * here mirrors the real `SettingsStore.patch()`: a plain spread, no
 * normalisation — `src/server/settings/store.ts` confirms the real server
 * never changes the bytes of a string field either, so an honest stub must
 * not invent normalisation the product doesn't have.
 */
function fakeServerFetch() {
  let stored = view();
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/settings") && !u.includes("/telegram") && init?.method === "PUT") {
      const patch = init.body ? JSON.parse(String(init.body)) : {};
      stored = {
        ...stored,
        telegram: { ...stored.telegram, ...(patch.telegram ?? {}) },
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

test("mute applies immediately and does not go through Save", async () => {
  // The operator taps Mute because they are going to bed, not because they
  // intend to hunt for a Save button.
  const stub = stubFetch({
    "/api/settings/mute": () => ({ ...view(), notify: { ...view().notify, mutedUntil: 1_700_000_000_000 + 3_600_000 } }),
    "/api/settings": () => view(),
  });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  host.querySelector<HTMLButtonElement>('button[name="mute-1h"]')!.click();
  await settle();
  await settle();
  const call = stub.calls.find((c) => c.url.includes("/api/settings/mute"))!;
  expect(call.body).toEqual({ forMs: 3_600_000 });
  // A mute is not an unsaved edit.
  expect(host.querySelector(".settings-save-bar")).toBeNull();
});

test("mute never establishes a baseline the operator never confirmed", async () => {
  // If the initial GET fails, `baseline` stays null, `dirty` stays false, and
  // no Save button renders at all — see settings-view.test.tsx's "a form that
  // never loaded cannot be saved". A `setBaseline` call in the mute handler
  // would go undetected by the previous test (its stub echoes back exactly
  // what was already loaded, so the compared fields never move) — but IS
  // caught here: mute succeeding while the GET has failed would newly arm
  // `dirty`/Save off the mute route's fields, which is exactly the failed-load
  // scenario the guard exists to prevent, just reached by a second door.
  const muteStub = stubFetch({
    "/api/settings/mute": () => ({ ...view(), notify: { ...view().notify, mutedUntil: 1_700_000_000_000 + 3_600_000 } }),
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/api/settings/mute")) return muteStub.fn(input, init);
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  expect(host.textContent).toContain("network down");
  host.querySelector<HTMLButtonElement>('button[name="mute-1h"]')!.click();
  await settle();
  await settle();
  expect(host.querySelector(".settings-save-bar")).toBeNull();
});

test("a muted dashboard says until when, computed from the server's clock", async () => {
  const muted = {
    ...view(),
    notify: { ...view().notify, mutedUntil: 1_700_000_000_000 + 3_600_000 },
  };
  const stub = stubFetch({ "/api/settings": () => muted });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  const el = host.querySelector(".settings-mute")!;
  expect(el.textContent).toContain("Muted until");
  expect(el.querySelector('button[name="unmute"]')).not.toBeNull();
});

test("unmute posts a zero duration", async () => {
  const muted = { ...view(), notify: { ...view().notify, mutedUntil: 1_700_000_000_000 + 3_600_000 } };
  const stub = stubFetch({ "/api/settings/mute": () => view(), "/api/settings": () => muted });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  host.querySelector<HTMLButtonElement>('button[name="unmute"]')!.click();
  await settle();
  await settle();
  expect(stub.calls.find((c) => c.url.includes("/mute"))!.body).toEqual({ forMs: 0 });
});

test("a settle window is edited in seconds and saved in milliseconds", async () => {
  const stub = stubFetch({ "/api/settings": () => view() });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  const done = host.querySelector<HTMLInputElement>('input[name="settle-done"]')!;
  expect(done.value).toBe("10");
  typeInto(done, "30");
  await settle();
  host.querySelector<HTMLButtonElement>(".settings-save-bar button")!.click();
  await settle();
  await settle();
  // The LAST match, not the first: the mount's own GET also hits
  // "/api/settings" and is recorded before the save, with no body. `.find`
  // would silently grab that GET (body undefined) instead of the save's PUT,
  // and the assertion below would fail for the wrong reason.
  const puts = stub.calls.filter((c) => c.url.includes("/api/settings") && !c.url.includes("/mute"));
  const put = puts[puts.length - 1]!;
  expect((put.body as { notify: { settleMs: unknown } }).notify.settleMs)
    .toEqual({ blocked: 5_000, done: 30_000 });
});
