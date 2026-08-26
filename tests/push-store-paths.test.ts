import { expect, test } from "bun:test";
import { mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errnoReason, PushStore } from "@server/push/store";

test("an fs failure's reason carries no path", () => {
  // Node's message is `EACCES: permission denied, open '/home/<user>/…'`.
  // The warning built from it is rendered in Settings, so a path here becomes
  // the operator's home directory on screen — and in any screenshot of it.
  const e = Object.assign(
    new Error("EACCES: permission denied, open '/base/operator/.config/paddock/push.json'"),
    { code: "EACCES" },
  );
  const reason = errnoReason(e);
  expect(reason).toBe("EACCES");
  expect(reason).not.toContain("/");
  expect(reason).not.toContain("push.json");
});

test("a failure with no errno keeps its words and loses its path", () => {
  // Not replaced with something vaguer than the truth — the description is
  // what an operator acts on. Only the quoted path goes.
  const reason = errnoReason(new Error("disk quota exceeded, open '/base/operator/push.json'"));
  expect(reason).toContain("disk quota exceeded");
  expect(reason).not.toContain("/base/operator");
  expect(reason).not.toContain("'");
});

test("a non-Error is still reported as something", () => {
  expect(errnoReason("weird").length).toBeGreaterThan(0);
  expect(errnoReason(null).length).toBeGreaterThan(0);
});

test("the warning an unwritable config dir produces names no path", async () => {
  // End to end through PushStore, because the guard has to hold on the string
  // the UI actually receives — not merely on the helper in isolation.
  const dir = await mkdtemp(join(tmpdir(), "paddock-push-ro-"));
  await chmod(dir, 0o500); // readable, not writable: the create will fail
  try {
    const store = await PushStore.load(dir);
    const warning = store.error;
    expect(warning, "an unwritable dir must produce an error string").not.toBeNull();
    expect(warning!).not.toContain(dir);
    expect(warning!).not.toContain("push.json could not be created:");
    // Still says what happened and what it cost.
    expect(warning!).toContain("push is off");
  } finally {
    await chmod(dir, 0o700);
  }
});
