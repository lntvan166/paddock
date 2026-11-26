import { expect, test } from "bun:test";
import { latestRelease } from "@server/latest-release";

/*
 * `paddock update` on a network that spent GitHub's 60-an-hour API allowance
 * got "HTTP 403" while the release was there. github.com's own redirect, the
 * path install.sh downloads through, is the fallback.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

test("the API's tag when it answers, with no second request", async () => {
  const asked: string[] = [];
  const v = await latestRelease("example/paddock", async (u) => { asked.push(u); return json({ tag_name: "v1.2.3" }); });
  expect(v).toBe("1.2.3");
  expect(asked.length).toBe(1);
});

test("a rate-limited API falls back to github.com's releases/latest redirect", async () => {
  const asked: { url: string; init?: RequestInit }[] = [];
  const v = await latestRelease("example/paddock", async (u, init) => {
    asked.push({ url: u, init });
    return u.startsWith("https://api.github.com/")
      ? json({ message: "API rate limit exceeded" }, 403)
      : redirect("https://github.com/example/paddock/releases/tag/v0.17.0");
  });
  expect(v).toBe("0.17.0");
  expect(asked[1]!.url).toBe("https://github.com/example/paddock/releases/latest");
  // Manual, or fetch would follow it to the HTML page and lose the tag.
  expect(asked[1]!.init?.redirect).toBe("manual");
});

test("when neither answers, the error names both, and the rate limit", async () => {
  const p = latestRelease("example/paddock", async (u) =>
    u.startsWith("https://api.github.com/") ? json({}, 403) : new Response("", { status: 500 }));
  await expect(p).rejects.toThrow(/HTTP 403 \(GitHub's rate limit for this network\); github\.com answered HTTP 500/);
});
