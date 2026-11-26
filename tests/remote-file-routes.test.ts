import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStore } from "@server/files/store";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { Agent } from "@shared/types";

/*
 * A path printed by an agent on ANOTHER machine names a file there. It is read
 * there (herdr-core `file.read` with `on`), staged here, and served like any
 * other. Invented names: `build-box` is the machine, `/srv/project` its tree.
 */

const NOW = 1_700_000_000_000;
const REMOTE: Agent = {
  hostId: "dev-box", agentId: "hc.build-box/t9", name: "schema-migration", task: "", state: "idle",
  workspaceId: "w", workspaceLabel: null, cwd: "/srv/project", harness: "claude", stateSince: NOW,
  stateSinceExact: true, updatedAt: NOW, acknowledgedAt: null, hasJournal: false, origin: "core", turn: null, seen: null,
};

function harness() {
  const store = new AgentStore("dev-box");
  store.replaceAll([REMOTE], NOW, "core");
  const reads: { machine: string; path: string; cwd: string | null }[] = [];
  const app = createApp({
    store, hub: new Hub(), health: () => ({}) as never, files: createFileStore(),
    remoteFiles: {
      async read(machine, path, cwd) {
        reads.push({ machine, path, cwd });
        if (path.includes("missing")) throw new Error("no such file");
        return `# notes from ${machine}\n`;
      },
      async stage(name, text) {
        const dir = await mkdtemp(join(tmpdir(), "paddock-test-remote-"));
        const p = join(dir, name);
        await writeFile(p, text);
        return p;
      },
    },
  });
  const open = (path: string) => app.request("/api/files", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, agentId: REMOTE.agentId }),
  });
  return { app, reads, open };
}

test("a text file an agent on another machine printed is read THERE, and served from a local copy", async () => {
  const h = harness();
  const res = await h.open("/srv/project/NOTES.md");
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, name: "NOTES.md", render: "text" });
  expect(h.reads).toEqual([{ machine: "build-box", path: "/srv/project/NOTES.md", cwd: null }]);
  const served = await h.app.request(`/api/files/${body.id}`);
  expect(await served.text()).toBe("# notes from build-box\n");
  // Sandboxed like any served file.
  expect(served.headers.get("content-security-policy")).toBe("sandbox");
});

test("a relative path is that agent's working directory; `~/` is that machine's home", async () => {
  const h = harness();
  await h.open("docs/plan.md");
  await h.open("~/todo.txt");
  expect(h.reads).toEqual([
    { machine: "build-box", path: "docs/plan.md", cwd: "/srv/project" },
    { machine: "build-box", path: "todo.txt", cwd: null },
  ]);
});

test("an image or a binary on another machine is refused, said plainly, and nothing is read", async () => {
  const h = harness();
  const res = await h.open("/srv/project/shot.png");
  expect(res.status).toBe(415);
  expect((await res.json()).detail).toContain("only text files can be opened from another machine");
  expect(h.reads).toEqual([]);
});

test("a file the other machine cannot read says so, naming the machine", async () => {
  const h = harness();
  const res = await h.open("/srv/project/missing.md");
  expect(res.status).toBe(502);
  expect((await res.json()).detail).toContain("on build-box");
});
