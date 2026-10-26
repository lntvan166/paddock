import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readTailscaleConfig, removeTailscaleConfig, tailscaleConfigFile, writeTailscaleConfig,
} from "@server/tailscale/config";

const dir = () => mkdtemp(join(tmpdir(), "paddock-tailscale-"));
const good = { enabled: true, login: "operator@github", host: "dev-box.example-tailnet.ts.net" };

async function readWith(d: string, body: string) {
  await writeFile(tailscaleConfigFile(d), body);
  const logs: string[] = [];
  const c = await readTailscaleConfig(d, (m) => logs.push(m));
  return { c, logs };
}

describe("tailscale.json", () => {
  test("absent file -> null, no log", async () => {
    const logs: string[] = [];
    expect(await readTailscaleConfig(await dir(), (m) => logs.push(m))).toBeNull();
    expect(logs).toEqual([]);
  });
  test("round trip", async () => {
    const d = await dir();
    await writeTailscaleConfig(d, good);
    expect(await readTailscaleConfig(d)).toEqual(good);
  });
  test("login is lowercased on write", async () => {
    const d = await dir();
    await writeTailscaleConfig(d, { ...good, login: "Operator@GitHub" });
    expect((await readTailscaleConfig(d))?.login).toBe("operator@github");
  });
  test("invalid JSON -> null and one log line naming the file", async () => {
    const d = await dir();
    const { c, logs } = await readWith(d, "{nope");
    expect(c).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("tailscale.json");
  });
  test("empty login or host -> null and a log line", async () => {
    for (const bad of [{ ...good, login: "" }, { ...good, host: "" }]) {
      const { c, logs } = await readWith(await dir(), JSON.stringify(bad));
      expect(c).toBeNull();
      expect(logs).toHaveLength(1);
    }
  });
  test("unknown key -> null", async () => {
    const { c, logs } = await readWith(await dir(), JSON.stringify({ ...good, extra: 1 }));
    expect(c).toBeNull();
    expect(logs).toHaveLength(1);
  });
  test("enabled:false -> null", async () => {
    const { c } = await readWith(await dir(), JSON.stringify({ ...good, enabled: false }));
    expect(c).toBeNull();
  });
  test("file mode is 0600", async () => {
    const d = await dir();
    await writeTailscaleConfig(d, good);
    expect((await stat(tailscaleConfigFile(d))).mode & 0o777).toBe(0o600);
  });
  test("remove deletes the file and tolerates absence", async () => {
    const d = await dir();
    await writeTailscaleConfig(d, good);
    await removeTailscaleConfig(d);
    expect(await readTailscaleConfig(d)).toBeNull();
    await removeTailscaleConfig(d);
  });
});
