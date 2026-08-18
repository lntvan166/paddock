import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, noUpdateCheckRequested, startUpdateCheck } from "@server/update-check";

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

// --- The check may fail. It may not be fatal. ------------------------------
//
// Measured before this fix, on a compiled binary with PADDOCK_CONFIG_DIR
// pointing at a 0500 directory: the server bound its port, logged
// "paddock listening on ...", served, and then died with
// `EACCES: permission denied, mkdir ...` and exit 1. The mkdir/writeFile that
// persist the cache sat OUTSIDE the fetch's try/catch, and index.ts fired the
// promise with no `.catch`, so the rejection was unhandled and Bun killed the
// process. Under docker-compose's `restart: unless-stopped` that is a
// crash-loop, and it is reachable on the path this repo ships.

test("an unwritable config dir does not kill the check — it still answers, and says why it could not cache", async () => {
  const parent = await dir();
  await chmod(parent, 0o500);
  const unwritable = join(parent, "nested");

  const said: string[] = [];
  const realInfo = console.info;
  console.info = (...a: unknown[]) => { said.push(a.join(" ")); };
  try {
    // Resolves rather than rejects, AND still returns the version it fetched:
    // failing to cache the answer is not a reason to withhold it.
    expect(await checkForUpdate({
      dir: unwritable, current: "0.1.0", now: 1000, fetchImpl: fetchOk,
    })).toBe("9.9.9");
  } finally {
    console.info = realInfo;
    // Restored so the temp dir can be cleaned up by whatever reaps TMPDIR.
    await chmod(parent, 0o700);
  }

  // Never swallowed. The sanctioned exception is that this failure is quiet in
  // the UI, not that it is invisible.
  expect(said.join("\n")).toContain("update check not cached");
});

test("the cache file is written 0600, like the settings.json beside it", async () => {
  const d = await dir();
  await checkForUpdate({ dir: d, current: "0.1.0", now: 1000, fetchImpl: fetchOk });
  const mode = (await stat(join(d, "update-check.json"))).mode & 0o777;
  expect(mode.toString(8)).toBe("600");
});

test("a rejecting check does not become an unhandled rejection at the call site", async () => {
  // Bun terminates the process on an unhandled rejection, so if the `.catch`
  // inside startUpdateCheck were missing this test file would not merely fail
  // — the runner would die. The injected `check` is the only way to produce a
  // rejection now that checkForUpdate itself catches everything.
  const said: string[] = [];
  const realInfo = console.info;
  console.info = (...a: unknown[]) => { said.push(a.join(" ")); };
  let result: string | null | undefined;
  try {
    startUpdateCheck(
      { dir: await dir(), current: "0.1.0", now: 1000 },
      (v) => { result = v; },
      () => Promise.reject(new Error("something inside the check threw")),
    );
    // Two turns: one for the rejection to settle, one for the catch to run.
    await Bun.sleep(10);
  } finally {
    console.info = realInfo;
  }
  expect(result, "onResult must not run when the check failed").toBeUndefined();
  expect(said.join("\n")).toContain("update check failed");
  expect(said.join("\n")).toContain("something inside the check threw");
});

test("a successful check reaches the call site's callback", async () => {
  // The other half of the above: the `.catch` must not have swallowed the
  // happy path too.
  let result: string | null | undefined;
  startUpdateCheck(
    { dir: await dir(), current: "0.1.0", now: 1000, fetchImpl: fetchOk },
    (v) => { result = v; },
  );
  await Bun.sleep(10);
  expect(result).toBe("9.9.9");
});

test("a dev build never checks at all, so `make dev` cannot nag forever", async () => {
  // isNewer(anythingPublished, "0.0.0-dev") is always true, so without this a
  // dev loop renders "paddock X available — run: paddock update" permanently,
  // and running that command answers "this is a dev build". Returning early
  // also means the dev loop makes no request to GitHub and writes no cache.
  const d = await dir();
  let called = false;
  const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  expect(await checkForUpdate({ dir: d, current: "0.0.0-dev", now: 1000, fetchImpl: spy }))
    .toBeNull();
  expect(called).toBe(false);
  expect(await Bun.file(join(d, "update-check.json")).exists()).toBe(false);
});
