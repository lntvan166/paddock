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
