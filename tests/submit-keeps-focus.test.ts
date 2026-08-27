import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

/**
 * A submit button next to a text field must not blur it on pointerdown.
 *
 * Reported from a phone: "type something but cannot send, i must click enter
 * then send."
 *
 * A tap begins with a pointerdown. That moves focus off the input, iOS
 * dismisses the soft keyboard, the layout reflows upward by the keyboard's
 * height, and the button is no longer under the finger when the tap
 * completes — so no click ever arrives. Pressing return first puts the
 * keyboard away, after which the layout is still and one tap works. That is
 * exactly the "enter, then send" workaround, and it is the signature of this
 * bug rather than of a broken button.
 *
 * Cancelling the default on pointerdown does not stop the click. It only stops
 * the focus change that moves the target out from under it.
 *
 * This is a whole-directory rule because the app has four of these — two
 * terminals' Send, the create sheet's submit, and the rename Save — and every
 * one of them sits above a keyboard with a focused field. Fixing them one bug
 * report at a time is how three of them stayed broken while the fourth was
 * found.
 */

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(full);
    return e.isFile() && e.name.endsWith(".tsx") ? [full] : [];
  });
}

/**
 * The source of each element that opens with `type="submit"`, up to its `>`.
 *
 * Crude on purpose: a real parse would be better, but this only has to see
 * whether two attributes sit on the same element, and staying simple keeps the
 * rule readable by the person it fails on.
 */
function submitElements(src: string): string[] {
  const out: string[] = [];
  const re = /<(?:button|Button)\b/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const end = src.indexOf(">", m.index);
    if (end === -1) continue;
    const el = src.slice(m.index, end + 1);
    if (el.includes('type="submit"')) out.push(el);
  }
  return out;
}

test("every submit button keeps focus in the field it submits", () => {
  const offenders: string[] = [];
  for (const f of tsxFiles("src/web/components")) {
    for (const el of submitElements(readFileSync(f, "utf8"))) {
      if (!el.includes("onPointerDown")) {
        offenders.push(`${f}: ${el.replace(/\s+/g, " ").slice(0, 70)}`);
      }
    }
  }
  expect(
    offenders,
    `these drop the first tap on a phone:\n${offenders.join("\n")}`,
  ).toEqual([]);
});

test("the detector sees a bare submit button", () => {
  // A guard nobody has watched fail is a guard nobody knows works.
  const bare = '<Button type="submit" disabled={busy}>Send</Button>';
  expect(submitElements(bare).length).toBe(1);
  expect(submitElements(bare)[0]!.includes("onPointerDown")).toBe(false);
});

test("the detector is quiet on a fixed one, and on non-submit buttons", () => {
  const fixed = '<Button type="submit" onPointerDown={(e) => { e.preventDefault(); }}>Send</Button>';
  expect(submitElements(fixed)[0]!.includes("onPointerDown")).toBe(true);
  // A button that submits nothing has no field to keep focus in.
  expect(submitElements('<Button type="button" onClick={go}>Back</Button>')).toEqual([]);
});
