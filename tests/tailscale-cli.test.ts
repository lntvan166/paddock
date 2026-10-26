import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  findTailscale,
  ownsServe,
  readNode,
  serveOff,
  serveOn,
  servedTarget,
} from "@server/tailscale/cli";
import type { Run } from "@server/lifecycle/service/types";

const status = readFileSync("tests/fixtures/tailscale-status.json", "utf8");
const serve = readFileSync("tests/fixtures/tailscale-serve-status.json", "utf8");
const MAC = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

function fake(r: { code?: number; out?: string; err?: string }) {
  const calls: string[][] = [];
  const run: Run = async (argv) => {
    calls.push(argv);
    return { code: r.code ?? 0, out: r.out ?? "", err: r.err ?? "" };
  };
  return { run, calls };
}

describe("findTailscale", () => {
  test("PATH hit", () => {
    expect(findTailscale({ which: () => "/usr/bin/tailscale", platform: "linux" })).toBe(
      "/usr/bin/tailscale",
    );
  });
  test("darwin app bundle fallback", () => {
    expect(
      findTailscale({ which: () => null, platform: "darwin", exists: (p) => p === MAC }),
    ).toBe(MAC);
  });
  test("linux miss", () => {
    expect(findTailscale({ which: () => null, platform: "linux", exists: () => true })).toBeNull();
  });
});

describe("readNode", () => {
  test("parses the fixture", async () => {
    const { run, calls } = fake({ out: status });
    const r = await readNode(run, "ts");
    expect(calls).toEqual([["ts", "status", "--json"]]);
    expect(r).toEqual({
      ok: true,
      node: {
        running: true,
        host: "dev-box.example-tailnet.ts.net",
        login: "operator@github",
        certs: true,
      },
    });
  });
  test("no CertDomains -> certs false; NeedsLogin -> not running", async () => {
    const j = { ...JSON.parse(status), BackendState: "NeedsLogin", CertDomains: null };
    const r = await readNode(fake({ out: JSON.stringify(j) }).run, "ts");
    expect(r.ok && r.node.certs).toBe(false);
    expect(r.ok && r.node.running).toBe(false);
  });
  test("non-zero exit reports the first stderr line", async () => {
    const r = await readNode(fake({ code: 1, err: "boom\nmore" }).run, "ts");
    expect(r).toEqual({ ok: false, error: "boom" });
  });
  test("unparseable output is an error, not a throw", async () => {
    const r = await readNode(fake({ out: "not json" }).run, "ts");
    expect(r.ok).toBe(false);
  });
});

describe("servedTarget", () => {
  test("reads 443's proxy", async () => {
    const { run, calls } = fake({ out: serve });
    expect(await servedTarget(run, "ts")).toBe("http://127.0.0.1:8789");
    expect(calls).toEqual([["ts", "serve", "status", "--json"]]);
  });
  test("null when nothing is served", async () => {
    expect(await servedTarget(fake({ out: "{}" }).run, "ts")).toBeNull();
    expect(await servedTarget(fake({ out: "" }).run, "ts")).toBeNull();
    const other = JSON.stringify({ Web: { "dev-box.example-tailnet.ts.net:8443": {} } });
    expect(await servedTarget(fake({ out: other }).run, "ts")).toBeNull();
  });
  test("a failing command throws rather than reading as unserved", async () => {
    await expect(servedTarget(fake({ code: 1, err: "nope" }).run, "ts")).rejects.toThrow("nope");
  });
});

test("serveOn argv is exact", async () => {
  const { run, calls } = fake({});
  await serveOn(run, "ts", 8789);
  expect(calls).toEqual([["ts", "serve", "--bg", "--https=443", "http://127.0.0.1:8789"]]);
});

test("serveOff argv is exact", async () => {
  const { run, calls } = fake({});
  await serveOff(run, "ts");
  expect(calls).toEqual([["ts", "serve", "--https=443", "off"]]);
});

test("ownsServe accepts only our port", () => {
  expect(ownsServe("http://127.0.0.1:8789", 8789)).toBe(true);
  expect(ownsServe("http://localhost:8789", 8789)).toBe(true);
  expect(ownsServe("http://127.0.0.1:9000", 8789)).toBe(false);
  expect(ownsServe("http://127.0.0.1:87890", 8789)).toBe(false);
  expect(ownsServe(null, 8789)).toBe(false);
});

test("never funnel", () => {
  const dir = "src/server/tailscale";
  for (const f of readdirSync(dir)) {
    expect(readFileSync(`${dir}/${f}`, "utf8")).not.toContain('"funnel"');
  }
});

describe("Access denied on Linux names the operator fix", () => {
  const denied = { code: 1, err: "Access denied: serve config denied\nmore detail" };
  const HINT = "sudo tailscale set --operator=$USER";

  test("serveOn on linux adds the hint", async () => {
    await expect(serveOn(fake(denied).run, "ts", 8789, "linux")).rejects.toThrow(HINT);
    await expect(serveOn(fake(denied).run, "ts", 8789, "linux")).rejects.toThrow("Access denied: serve config denied");
  });
  test("serveOff and servedTarget on linux add the hint too", async () => {
    await expect(serveOff(fake(denied).run, "ts", "linux")).rejects.toThrow(HINT);
    await expect(servedTarget(fake(denied).run, "ts", "linux")).rejects.toThrow(HINT);
  });
  test("not on darwin, and not for another failure", async () => {
    let e = await serveOn(fake(denied).run, "ts", 8789, "darwin").catch((x: Error) => x);
    expect(String(e)).toContain("Access denied");
    expect(String(e)).not.toContain(HINT);
    e = await serveOn(fake({ code: 1, err: "boom" }).run, "ts", 8789, "linux").catch((x: Error) => x);
    expect(String(e)).toContain("boom");
    expect(String(e)).not.toContain(HINT);
  });
});
