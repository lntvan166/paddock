import { expect, test } from "bun:test";
import { tunnelHint } from "@server/tunnel/preflight";

test("a paddock with no public URL is told about the tunnel", () => {
  expect(tunnelHint(null, false)).toContain("paddock tunnel");
});

test("a configured publicUrl silences the hint entirely", () => {
  // An operator on the named-tunnel path has solved this, and must not be
  // nudged toward the weaker option.
  expect(tunnelHint("https://paddock.example.com", false)).toBe(null);
  expect(tunnelHint("https://paddock.example.com", true)).toBe(null);
});

test("an empty string counts as unconfigured, like everywhere else", () => {
  // `isConfigured` treats "" as absent; a second opinion here would be a bug.
  expect(tunnelHint("", false)).toContain("paddock tunnel");
});

test("a SAVED quick-tunnel URL does not count as configured", () => {
  // A *.trycloudflare.com value in settings is not a deployment — it is a dead
  // link pasted in from an earlier run, because the hostname changes on every
  // start. Treating it as configured would silence the hint for exactly the
  // operator who needs it.
  expect(tunnelHint("https://quiet-harbor-8f31.trycloudflare.com", false))
    .toContain("paddock tunnel");
  expect(tunnelHint("https://quiet-harbor-8f31.trycloudflare.com", true))
    .toContain("paddock tunnel");
});

test("a lookalike host is still a real deployment", () => {
  // One regex, anchored — see @shared/quick-tunnel. This must not be silenced
  // by accident and must not be flagged as stale either.
  expect(tunnelHint("https://a.trycloudflare.com.example.net", false)).toBe(null);
});

test("the detached hint admits the stop, because the two are exclusive", () => {
  expect(tunnelHint(null, true)).toContain("stop");
  expect(tunnelHint(null, false)).not.toContain("stop");
});
