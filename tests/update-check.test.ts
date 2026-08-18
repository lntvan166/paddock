import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, noUpdateCheckRequested } from "@server/update-check";

const dir = async () => mkdtemp(join(tmpdir(), "paddock-uc-"));

const fetchOk = (async () =>
  new Response(JSON.stringify({ tag_name: "v9.9.9" }))) as unknown as typeof fetch;

test("a fresh check reports the newer version and caches it", async () => {
  const d = await dir();
  expect(await checkForUpdate({ dir: d, current: "0.1.0", now: 1000, fetchImpl: fetchOk }))
    .toBe("9.9.9");
  expect(JSON.parse(await readFile(join(d, "update-check.json"), "utf8")).latest).toBe("9.9.9");
});

test("a second check inside 24h does NOT hit the network", async () => {
  const d = await dir();
  await checkForUpdate({ dir: d, current: "0.1.0", now: 1000, fetchImpl: fetchOk });
  let called = false;
  const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  await checkForUpdate({ dir: d, current: "0.1.0", now: 1000 + 60_000, fetchImpl: spy });
  expect(called).toBe(false);
});

test("PADDOCK_NO_UPDATE_CHECK disables it entirely", async () => {
  const d = await dir();
  let called = false;
  const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  const r = await checkForUpdate({
    dir: d, current: "0.1.0", now: 1000, fetchImpl: spy, disabled: true,
  });
  expect(r).toBeNull();
  expect(called).toBe(false);
});

test("a network failure is silent to the operator, not an error about a working dashboard", async () => {
  const d = await dir();
  const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect(await checkForUpdate({ dir: d, current: "0.1.0", now: 1000, fetchImpl: boom }))
    .toBeNull();
});

test("a corrupt cache file does not crash the check", async () => {
  const d = await dir();
  await writeFile(join(d, "update-check.json"), "{ not json");
  expect(await checkForUpdate({ dir: d, current: "0.1.0", now: 1000, fetchImpl: fetchOk }))
    .toBe("9.9.9");
});

test("noUpdateCheckRequested reads PADDOCK_NO_UPDATE_CHECK=1, and only that value", () => {
  // Fix round 1: this mapping used to live inline at the index.ts call site,
  // covered only by checkForUpdate's library-level `disabled: true` — which
  // would still pass even if index.ts read the wrong variable, or compared
  // it with `!==` instead of `===`. Testing the mapping itself closes that.
  expect(noUpdateCheckRequested({ PADDOCK_NO_UPDATE_CHECK: "1" })).toBe(true);
  expect(noUpdateCheckRequested({})).toBe(false);
  expect(noUpdateCheckRequested({ PADDOCK_NO_UPDATE_CHECK: "0" })).toBe(false);
  expect(noUpdateCheckRequested({ PADDOCK_NO_UPDATE_CHECK: "true" })).toBe(false);
  expect(noUpdateCheckRequested({ PADDOCK_NO_UPDATE_CHECK: "" })).toBe(false);
});
