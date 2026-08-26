import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushStore } from "@server/push/store";
import { hashEndpoint } from "@shared/device-key";

const dir = () => mkdtemp(join(tmpdir(), "paddock-push-"));
const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};

test("a keypair is generated on first use and written 0600", async () => {
  const d = await dir();
  const s = await PushStore.load(d);
  expect(s.error).toBeNull();
  expect(s.publicKey()).not.toBeNull();
  const mode = (await stat(join(d, "push.json"))).mode & 0o777;
  // A VAPID private key is a credential. Group-readable is not acceptable.
  expect(mode).toBe(0o600);
});

test("the keypair is STABLE across reloads", async () => {
  // Every existing subscription dies the moment this key changes, so this is
  // the property the whole store exists to protect.
  const d = await dir();
  const first = (await PushStore.load(d)).publicKey();
  const second = (await PushStore.load(d)).publicKey();
  expect(second).toBe(first);
});

// THE test this design is built around.
test("an unreadable push.json disables push and does NOT mint a new keypair", async () => {
  const d = await dir();
  const before = (await PushStore.load(d)).publicKey();
  const raw = await readFile(join(d, "push.json"), "utf8");

  await writeFile(join(d, "push.json"), "{ not json");
  const broken = await PushStore.load(d);
  expect(broken.error).not.toBeNull();
  expect(broken.error).toContain("push.json");
  // Disabled, not silently re-keyed. A replacement keypair invalidates every
  // subscription in existence with no symptom whatsoever — every phone simply
  // stops buzzing and nothing on any screen explains it.
  expect(broken.publicKey()).toBeNull();
  expect(broken.keys()).toBeNull();
  expect(broken.list()).toEqual([]);

  // And it did not overwrite the file, so the original is recoverable.
  await writeFile(join(d, "push.json"), raw);
  expect((await PushStore.load(d)).publicKey()).toBe(before);
});

test("an unwritable directory is reported, not thrown", async () => {
  const d = await dir();
  await chmod(d, 0o500);
  try {
    const s = await PushStore.load(d);
    expect(s.error).not.toBeNull();
    expect(s.publicKey()).toBeNull();
  } finally {
    await chmod(d, 0o700);
  }
});

test("subscriptions add, list and remove", async () => {
  const d = await dir();
  const s = await PushStore.load(d);
  await s.add(SUB);
  expect(s.list()).toEqual([{ ...SUB, deviceKey: await hashEndpoint(SUB.endpoint) }]);
  await s.remove(SUB.endpoint);
  expect(s.list()).toEqual([]);
});

test("re-subscribing the same endpoint replaces rather than duplicates", async () => {
  // A browser re-subscribes with the same endpoint and fresh keys after a
  // permission reset. Two records would send every notification twice.
  const d = await dir();
  const s = await PushStore.load(d);
  await s.add(SUB);
  await s.add({ ...SUB, auth: "AAAAAAAAAAAAAAAAAAAAAA" });
  expect(s.list()).toHaveLength(1);
  expect(s.list()[0]!.auth).toBe("AAAAAAAAAAAAAAAAAAAAAA");
});

test("subscriptions survive a reload", async () => {
  const d = await dir();
  await (await PushStore.load(d)).add(SUB);
  expect((await PushStore.load(d)).list()).toEqual([{ ...SUB, deviceKey: await hashEndpoint(SUB.endpoint) }]);
});

test("removing an endpoint that is not there is not an error", async () => {
  const d = await dir();
  const s = await PushStore.load(d);
  await s.remove("https://fcm.googleapis.com/fcm/send/never-existed");
  expect(s.list()).toEqual([]);
});

test("a subscription is stored with its device key, and an old file is backfilled", async () => {
  // The key is persisted rather than derived per notification so the
  // notifier's roster getter can be synchronous: an await between reading the
  // cooldown and stamping it would open an interleaving window `#fire` does
  // not have today.
  const d = await mkdtemp(join(tmpdir(), "paddock-push-"));
  await writeFile(join(d, "push.json"), JSON.stringify({
    keys: { publicKey: "BP4z", privateKey: { kty: "EC", crv: "P-256", d: "x" } },
    subscriptions: [{ endpoint: "https://push.example.com/send/legacy", p256dh: "p", auth: "a" }],
  }));
  const s = await PushStore.load(d);
  const stored = s.list()[0]!;
  expect(stored.deviceKey).toBe(await hashEndpoint("https://push.example.com/send/legacy"));
  expect(s.deviceKeys()).toEqual(new Set([stored.deviceKey]));
});
