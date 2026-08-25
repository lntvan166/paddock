import "./support/dom";
import { expect, test } from "bun:test";
import { pairingPage } from "@server/tunnel/gate";
import { ALPHABET } from "@server/tunnel/pairing";

/**
 * Mounts the REAL page — its markup and its own inline script — rather than a
 * reimplementation of them. The page is self-contained by necessity (every
 * real asset stays behind the gate), so the script cannot be imported; running
 * the shipped string is the only way to test what actually reaches a phone.
 */
function mount(): HTMLInputElement {
  const page = pairingPage({ insecure: false });
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1];
  if (script === undefined) throw new Error("the pairing page has no inline script");
  const body = page.slice(page.indexOf("<body>") + "<body>".length, page.indexOf("</body>"));
  document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/, "");
  new Function(script)();
  const input = document.getElementById("c");
  if (input === null) throw new Error("the pairing page has no code input");
  return input as HTMLInputElement;
}

const type = (input: HTMLInputElement, value: string): string => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input.value;
};

test("a dash appears once the fifth character is typed", () => {
  const c = mount();
  expect(type(c, "4")).toBe("4");
  expect(type(c, "4F7K")).toBe("4F7K");
  expect(type(c, "4F7KQ")).toBe("4F7K-Q");
  expect(type(c, "4F7KQP2M")).toBe("4F7K-QP2M");
});

test("the input is upper-cased as it is typed", () => {
  const c = mount();
  expect(type(c, "4f7kqp2m")).toBe("4F7K-QP2M");
});

// Backspacing THROUGH the dash must not re-insert it and trap the cursor,
// which is how a naive formatter makes a field impossible to clear.
test("backspacing through the dash does not re-insert it", () => {
  const c = mount();
  expect(type(c, "4F7K-Q")).toBe("4F7K-Q");
  expect(type(c, "4F7K-")).toBe("4F7K");
  expect(type(c, "4F7K")).toBe("4F7K");
  expect(type(c, "4F7")).toBe("4F7");
  expect(type(c, "")).toBe("");
});

test("a pasted code is accepted in either shape, and not double-dashed", () => {
  const c = mount();
  expect(type(c, "4F7K-QP2M")).toBe("4F7K-QP2M");
  expect(type(c, "4F7KQP2M")).toBe("4F7K-QP2M");
  expect(type(c, "4f7k qp2m")).toBe("4F7K-QP2M");
});

// iOS autofill via autocomplete="one-time-code" sets the value and fires
// input without an ordinary keystroke.
test("an autofilled value is formatted like a typed one", () => {
  const c = mount();
  expect(type(c, "4F7KQP2M")).toBe("4F7K-QP2M");
});

test("nothing past eight characters is kept", () => {
  const c = mount();
  expect(type(c, "4F7KQP2MZZZZ")).toBe("4F7K-QP2M");
});

// Mirrors normalise() exactly. If these disagree, the field displays one code
// and the server compares another.
test("confusables are decoded as you type, matching the server", () => {
  const c = mount();
  expect(type(c, "O123456I")).toBe("0123-4561");
  expect(type(c, "L2345678")).toBe("1234-5678");
});

test("U is dropped as you type, exactly as the server drops it", () => {
  const c = mount();
  expect(type(c, "U1234567")).toBe("1234-567");
});

// One source for the alphabet. A hand-copied second list is how the page and
// the server come to disagree about what a code may contain.
test("the page carries the server's alphabet, not a copy of it", () => {
  expect(pairingPage({ insecure: false })).toContain(ALPHABET);
});

/**
 * Give the document a fragment for the script to read at mount.
 *
 * happy-dom starts at `about:blank`, where `history.replaceState` silently
 * does NOTHING — `location.hash` stays `""` and `pathname` reads `"blank"`.
 * That failure is invisible: the tests below would report "nothing was
 * submitted" and look like an implementation bug rather than a harness one.
 * So the document gets a real URL first, and only then can a fragment exist.
 */
const withFragment = (frag: string): void => {
  const win = globalThis.window as unknown as {
    happyDOM?: { setURL?: (u: string) => void };
  };
  win.happyDOM?.setURL?.("https://paddock.example.com/");
  history.replaceState(null, "", `/${frag}`);
};

const stubFetch = (): { calls: unknown[]; restore: () => void } => {
  const calls: unknown[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
};

test("a code in the fragment is filled in and submitted", async () => {
  const f = stubFetch();
  try {
    withFragment("#4F7KQP2M");
    const c = mount();
    await Promise.resolve();
    expect(c.value).toBe("4F7K-QP2M");
    expect(f.calls).toHaveLength(1);
  } finally {
    f.restore();
  }
});

// THE hazard. An attempt is a guess and spends one of five; five wrong ones
// reissue the code and invalidate the QR still on the operator's screen.
test("the fragment is submitted exactly once, never twice", async () => {
  const f = stubFetch();
  try {
    withFragment("#4F7KQP2M");
    mount();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.calls).toHaveLength(1);
  } finally {
    f.restore();
  }
});

test("the fragment is cleared, so a reload replays nothing", async () => {
  const f = stubFetch();
  try {
    withFragment("#4F7KQP2M");
    mount();
    await Promise.resolve();
    expect(location.hash).toBe("");
    // Mounting again is a reload: with the hash gone there is nothing to send.
    const before = f.calls.length;
    mount();
    await Promise.resolve();
    expect(f.calls).toHaveLength(before);
  } finally {
    f.restore();
  }
});

test("no fragment means no automatic attempt at all", async () => {
  const f = stubFetch();
  try {
    withFragment("");
    mount();
    await Promise.resolve();
    expect(f.calls).toHaveLength(0);
  } finally {
    f.restore();
  }
});

test("a rejected code stops and shows the error rather than retrying", async () => {
  const calls: unknown[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: false, detail: "that code is not right — 4 attempts left" }), { status: 400 }),
    );
  }) as unknown as typeof fetch;
  try {
    withFragment("#4F7KQP2M");
    mount();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    const err = document.getElementById("e");
    expect(err?.textContent ?? "").toContain("not right");
    expect((err as HTMLElement).hidden).toBe(false);
  } finally {
    globalThis.fetch = real;
  }
});

// Garbage in the fragment must not spend an attempt either.
test("a fragment with no code characters submits nothing", async () => {
  const f = stubFetch();
  try {
    withFragment("#!!!!");
    mount();
    await Promise.resolve();
    expect(f.calls).toHaveLength(0);
  } finally {
    f.restore();
  }
});
