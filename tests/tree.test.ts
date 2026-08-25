import { expect, test } from "bun:test";
import { expandHome, toSpaceTree } from "@server/herdr/tree";
import type { HerdrSessionSnapshot } from "@shared/herdr-api";
import snapshot from "./fixtures/session-snapshot.json";

const NOW = 1_700_000_000_000;
const tree = () => toSpaceTree(snapshot as unknown as HerdrSessionSnapshot, NOW);

test("every space in the snapshot reaches the tree", () => {
  expect(tree().spaces.map((s) => s.spaceId)).toEqual(["w1", "w2", "w3"]);
});

test("a pane with no agent survives, with a null harness and a null state", () => {
  const shell = tree().spaces.find((s) => s.spaceId === "w3")!.tabs[0]!.panes[0]!;
  expect(shell.paneId).toBe("w3:p1");
  expect(shell.harness).toBeNull();
  expect(shell.state).toBeNull();
  expect(shell.name).toBeNull();
  // Its only label is the terminal title.
  expect(shell.title).toBe("bash");
});

test("an agent pane carries agent.list's name, never the pane's title", () => {
  const pane = tree().spaces.find((s) => s.spaceId === "w1")!.tabs[0]!.panes[0]!;
  expect(pane.name).toBe("api-refactor");
  expect(pane.harness).toBe("claude");
  expect(pane.state).toBe("working");
});

test("an unnamed tab reports a null label, not its number as a string", () => {
  const t = tree().spaces.find((s) => s.spaceId === "w1")!.tabs[0]!;
  expect(t.label).toBeNull();
});

test("a named tab keeps its label", () => {
  const t = tree().spaces.find((s) => s.spaceId === "w2")!.tabs.find((x) => x.tabId === "w2:t1")!;
  expect(t.label).toBe("migrate-up");
});

test("counts come from herdr rather than being recomputed", () => {
  const w2 = tree().spaces.find((s) => s.spaceId === "w2")!;
  expect(w2.tabCount).toBe(2);
  expect(w2.paneCount).toBe(2);
});

test("readAt is the clock passed in, so the UI can say how stale it is", () => {
  expect(tree().readAt).toBe(NOW);
});

test("a home-directory cwd is tilde-ised, so no username crosses the wire", () => {
  const snap = { ...(snapshot as any), panes: (snapshot as any).panes.map((p: any) =>
    p.pane_id === "w3:p1" ? { ...p, cwd: "/base/operator/work" } : p) };
  const t = toSpaceTree(snap as HerdrSessionSnapshot, NOW, { home: "/base/operator" });
  const pane = t.spaces.find((s) => s.spaceId === "w3")!.tabs[0]!.panes[0]!;
  expect(pane.cwd).toBe("~/work");
  expect(pane.cwd).not.toContain("operator");
});

test("a cwd outside home is untouched", () => {
  const t = toSpaceTree(snapshot as unknown as HerdrSessionSnapshot, NOW, { home: "/base/operator" });
  const pane = t.spaces.find((s) => s.spaceId === "w1")!.tabs[0]!.panes[0]!;
  expect(pane.cwd).toBe("/srv/project");
});

test("a pane whose tab is missing from the snapshot is dropped, not orphaned", () => {
  const broken = {
    ...(snapshot as any),
    panes: [...(snapshot as any).panes, { pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1", agent_status: "idle", cwd: "/srv/project", focused: false, revision: 1 }],
  };
  const spaces = toSpaceTree(broken as HerdrSessionSnapshot, NOW).spaces;
  expect(spaces.map((s) => s.spaceId)).not.toContain("w9");
});

/**
 * `expandHome` widened back to a plain string.
 *
 * Its return type is the `HostPath` BRAND — the mechanism that stops a future
 * cwd-accepting route reaching herdr without expanding first — and a branded
 * value cannot be compared to a string literal. Widening here rather than
 * casting each assertion: the brand is a compile-time guarantee about who may
 * mint a value, and these tests are about what the value IS.
 */
const expanded = (cwd: string, home?: string): string | null => expandHome(cwd, home);

test("expandHome is the exact inverse of the tilde-ising the tree does", () => {
  // The tilde only exists because paddock put it there, and it comes back:
  // the create sheet offers the tree's own cwds as quick picks. Measured live,
  // herdr neither expands nor refuses one — the pane came up in the home
  // directory with nothing saying the chosen folder was ignored.
  const home = "/base/operator";
  expect(expanded("~/work", home)).toBe("/base/operator/work");
  expect(expanded("~", home)).toBe("/base/operator");
  // A trailing slash on HOME must not double up.
  expect(expanded("~/work", "/base/operator/")).toBe("/base/operator/work");
  // Round trip, through the real tilde-ising: whatever the tree renders is
  // what a quick pick sends back, so this has to arrive as what herdr said.
  const snap = { ...(snapshot as any), panes: (snapshot as any).panes.map((p: any) =>
    p.pane_id === "w3:p1" ? { ...p, cwd: "/base/operator/work" } : p) };
  const t = toSpaceTree(snap as HerdrSessionSnapshot, NOW, { home });
  const rendered = t.spaces.find((s) => s.spaceId === "w3")!.tabs[0]!.panes[0]!.cwd;
  expect(rendered).toBe("~/work");
  expect(expanded(rendered, home)).toBe("/base/operator/work");
});

test("expandHome leaves an already-absolute path alone", () => {
  const home = "/base/operator";
  expect(expanded("/srv/project", home)).toBe("/srv/project");
  // A prefix that is not a path boundary must not be shortened either — the
  // tilde-ising side has the same rule, and this is its inverse.
  expect(expanded("/base/operatorX/y", home)).toBe("/base/operatorX/y");
});

test("expandHome REFUSES anything that is not absolute after expansion", () => {
  // FLIPPED. This test used to assert `./relative` and `""` came back
  // unchanged, under the heading "leaves alone everything that is not
  // paddock's own tilde" — and the route above it forwarded both with a 200
  // while refusing `~work` with a 400. Same class of value: a path whose
  // meaning depends on a working directory paddock cannot see. Whether herdr
  // resolves `./relative` against its OWN process cwd — silently, in the wrong
  // folder — is unmeasured, and the whole reason the tilde is refused is that
  // the measured answer for that shape was "silently, in the wrong folder".
  //
  // The rule, sharpened: refuse an unmeasured value when a measured
  // alternative already expresses the same intent, and relay when there is
  // none. An absolute path IS that alternative here, and every cwd the UI can
  // produce is already one (`~/…` quick picks, or free text the operator
  // typed) — so nothing the operator can do regresses, and `HostPath`'s
  // promise of "absolute" becomes true rather than aspirational.
  const home = "/base/operator";
  expect(expanded("./relative", home)).toBeNull();
  expect(expanded("relative", home)).toBeNull();
  expect(expanded("../up", home)).toBeNull();
  // The empty string too. It cannot be absolute, so the brand cannot honestly
  // be minted for it; the create routes treat a blank cwd as ABSENT and never
  // call this with one, so refusing it costs no caller anything.
  expect(expanded("", home)).toBeNull();
});

test("expandHome REFUSES a tilde it cannot resolve, rather than forwarding it", () => {
  // The first version of this returned both of these unchanged, which handed
  // herdr exactly the value the function exists to stop it seeing: measured
  // live, herdr neither expands nor refuses a `~`, it silently starts the pane
  // in the home directory. Null is the refusal the route turns into a 400.
  const home = "/base/operator";
  // Another user's home on a real shell. Resolving it against $HOME would
  // point at a different account's path, which is worse than refusing.
  expect(expanded("~someone/work", home)).toBeNull();
  expect(expanded("~someone", home)).toBeNull();
  // `~work` too, and NOT because it looks relative: on a real shell a leading
  // `~` followed by a name IS a user-home reference, so treating it as a plain
  // relative path is the same silent mis-resolution in a smaller disguise. The
  // rule is the simple one — anything still tilde-prefixed is refused.
  expect(expanded("~work", home)).toBeNull();
  // Nothing to expand against: no HOME, and the degenerate `/` home.
  expect(expanded("~/work", undefined)).toBeNull();
  expect(expanded("~/work", "/")).toBeNull();
  expect(expanded("~", undefined)).toBeNull();
});
