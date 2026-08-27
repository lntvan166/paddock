import { expect, test } from "bun:test";
import {
  MAX_COMMANDS,
  MAX_DESCRIPTION,
  parseDescription,
  readAgentCommands,
  type CommandFs,
} from "@server/commands/read";

// ---- the description, as harnesses actually write it -----------------------

test("a plain scalar description is taken as written", () => {
  expect(parseDescription("---\ndescription: Run the checks\n---\n\nbody\n"))
    .toBe("Run the checks");
});

test("a block scalar description is reduced to its first line", () => {
  // The shape real command files use. A row in a phone-sized list has one
  // line; the rest of the block is trigger guidance for the model, not for
  // the operator.
  const doc = [
    "---",
    "description: |",
    "  Write a handoff doc for a consuming team.",
    "  Trigger on any ask to communicate a contract change.",
    "---",
    "",
    "body",
  ].join("\n");
  expect(parseDescription(doc)).toBe("Write a handoff doc for a consuming team.");
});

test("quotes are not part of the description", () => {
  expect(parseDescription('---\ndescription: "Run the checks"\n---\n')).toBe("Run the checks");
  expect(parseDescription("---\ndescription: 'Run the checks'\n---\n")).toBe("Run the checks");
});

test("frontmatter without a description yields none", () => {
  expect(parseDescription("---\nname: check\n---\n")).toBeNull();
});

test("a document with no frontmatter yields none", () => {
  // Valid: a command file needs no frontmatter at all. It still belongs in the
  // list — the NAME is the useful half — so this returns null rather than
  // refusing the file.
  expect(parseDescription("# Check\n\nRun the checks.\n")).toBeNull();
});

test("a description key outside the frontmatter is not mistaken for one", () => {
  // The body can say anything, including something that looks like a key.
  expect(parseDescription("# Check\n\ndescription: not this\n")).toBeNull();
});

// ---- reading a project ----------------------------------------------------

/** A fake filesystem: directory listings and file bodies, nothing else. */
function fakeFs(
  dirs: Record<string, string[]>,
  files: Record<string, string>,
): CommandFs {
  return {
    readdir: async (dir) => {
      const entries = dirs[dir];
      if (!entries) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return entries;
    },
    readFile: async (path) => {
      const body = files[path];
      if (body === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return body;
    },
  };
}

const CWD = "/srv/project";

test("project commands are read from .claude/commands", async () => {
  const fs = fakeFs(
    { [`${CWD}/.claude/commands`]: ["check.md", "eod.md"] },
    {
      [`${CWD}/.claude/commands/check.md`]: "---\ndescription: Run the checks\n---\n",
      [`${CWD}/.claude/commands/eod.md`]: "---\ndescription: End of day\n---\n",
    },
  );

  const found = await readAgentCommands(CWD, [], fs);

  expect(found).toEqual([
    { command: "/check", description: "Run the checks", source: "command" },
    { command: "/eod", description: "End of day", source: "command" },
  ]);
});

test("project skills are read from .claude/skills/<name>/SKILL.md", async () => {
  const fs = fakeFs(
    { [`${CWD}/.claude/skills`]: ["deploy", "audit"] },
    {
      [`${CWD}/.claude/skills/deploy/SKILL.md`]: "---\ndescription: Ship it\n---\n",
      [`${CWD}/.claude/skills/audit/SKILL.md`]: "---\ndescription: Check licences\n---\n",
    },
  );

  const found = await readAgentCommands(CWD, [], fs);

  expect(found).toEqual([
    { command: "/deploy", description: "Ship it", source: "skill" },
    { command: "/audit", description: "Check licences", source: "skill" },
  ]);
});

test("a directory under skills with no SKILL.md is skipped, not an error", async () => {
  const fs = fakeFs(
    { [`${CWD}/.claude/skills`]: ["deploy", "notaskill"] },
    { [`${CWD}/.claude/skills/deploy/SKILL.md`]: "---\ndescription: Ship it\n---\n" },
  );

  expect((await readAgentCommands(CWD, [], fs)).map((c) => c.command)).toEqual(["/deploy"]);
});

test("a project with no .claude offers nothing, and does not throw", async () => {
  // The common case by a wide margin. It has to be an empty list rather than
  // an error, because the reply field still has to work.
  expect(await readAgentCommands(CWD, [], fakeFs({}, {}))).toEqual([]);
});

test("only .md files count as commands", async () => {
  const fs = fakeFs(
    { [`${CWD}/.claude/commands`]: ["check.md", "README.txt", "notes"] },
    { [`${CWD}/.claude/commands/check.md`]: "---\ndescription: Run\n---\n" },
  );

  expect((await readAgentCommands(CWD, [], fs)).map((c) => c.command)).toEqual(["/check"]);
});

test("a name that could become a path is refused", async () => {
  // readdir returns basenames, so this should be impossible — which is exactly
  // why it is cheap to assert. A separator or a dot segment reaching the join
  // is how a listing becomes a traversal.
  const fs = fakeFs(
    { [`${CWD}/.claude/commands`]: ["../../escape.md", ".hidden.md", "ok.md"] },
    {
      [`${CWD}/.claude/commands/ok.md`]: "---\ndescription: Fine\n---\n",
      [`${CWD}/.claude/commands/../../escape.md`]: "---\ndescription: Nope\n---\n",
      [`${CWD}/.claude/commands/.hidden.md`]: "---\ndescription: Nope\n---\n",
    },
  );

  expect((await readAgentCommands(CWD, [], fs)).map((c) => c.command)).toEqual(["/ok"]);
});

test("the list is capped, so a pathological project cannot flood the field", async () => {
  const names = Array.from({ length: MAX_COMMANDS + 25 }, (_, i) => `c${i}.md`);
  const files: Record<string, string> = {};
  for (const n of names) files[`${CWD}/.claude/commands/${n}`] = "---\ndescription: x\n---\n";

  const found = await readAgentCommands(CWD, [], fakeFs({ [`${CWD}/.claude/commands`]: names }, files));

  expect(found).toHaveLength(MAX_COMMANDS);
});

test("a file that cannot be read is skipped rather than failing the list", async () => {
  // One unreadable file must not cost the operator every other command.
  const fs = fakeFs(
    { [`${CWD}/.claude/commands`]: ["broken.md", "ok.md"] },
    { [`${CWD}/.claude/commands/ok.md`]: "---\ndescription: Fine\n---\n" },
  );

  expect((await readAgentCommands(CWD, [], fs)).map((c) => c.command)).toEqual(["/ok"]);
});

test("a description longer than a row is cut, at a word boundary", () => {
  // Measured, not imagined: a real project's `description: |` blocks put a
  // whole paragraph on the first line — 1172 characters in one case. A row in
  // a phone-sized list shows one line, and shipping the rest costs the
  // operator's link for text nothing can display.
  const long = "Write a handoff document telling a consuming team exactly what changed in the response they read, so they know what to fix before the release goes out";
  const cut = parseDescription(`---\ndescription: ${long}\n---\n`);

  expect(cut!.length).toBeLessThanOrEqual(MAX_DESCRIPTION + 1);
  expect(cut!.endsWith("…"), "says it was cut").toBe(true);

  const head = cut!.slice(0, -1);
  expect(long.startsWith(head), "keeps the opening verbatim").toBe(true);
  // The cut LANDS on a boundary: the original continues with a space, so no
  // word was severed. Asserting a space before the ellipsis instead would be
  // unsatisfiable, since the head is trimmed.
  expect(long[head.length], "cuts between words, not mid-word").toBe(" ");
});

test("a description that already fits is untouched", () => {
  const said = parseDescription("---\ndescription: Run the checks\n---\n");
  expect(said).toBe("Run the checks");
  expect(said!.endsWith("…")).toBe(false);
});

// ---- user-level sources ---------------------------------------------------
//
// Why these exist at all: `/superpowers:brainstorming` is a PLUGIN skill, so a
// reader that only looks at the agent's cwd can never offer it. The reason for
// originally excluding them — that plugin skills sit on disk at every installed
// version, so a walk returns one skill five times — turned out to be solved by
// a registry that names the active install. See `installedPluginSkills`.

/** No `/home/` anywhere: the public-repo scanner rejects it, correctly. */
const HOME = "/srv/dot-claude";

const registry = (plugins: Record<string, string>) =>
  JSON.stringify({
    version: 2,
    plugins: Object.fromEntries(
      Object.entries(plugins).map(([key, installPath]) => [
        key,
        [{ scope: "user", installPath, version: "1.0.0" }],
      ]),
    ),
  });

test("user commands and skills are offered alongside the project's", async () => {
  const fs = fakeFs(
    {
      [`${CWD}/.claude/commands`]: ["check.md"],
      [`${HOME}/commands`]: ["eod.md"],
      [`${HOME}/skills`]: ["backup"],
    },
    {
      [`${CWD}/.claude/commands/check.md`]: "---\ndescription: Project one\n---\n",
      [`${HOME}/commands/eod.md`]: "---\ndescription: User one\n---\n",
      [`${HOME}/skills/backup/SKILL.md`]: "---\ndescription: Back up\n---\n",
    },
  );

  const found = await readAgentCommands(CWD, [HOME], fs);

  expect(found.map((c) => c.command)).toEqual(["/check", "/eod", "/backup"]);
});

test("a plugin skill is namespaced by its plugin", async () => {
  // Measured from a real invocation: it is `/superpowers:brainstorming`, never
  // `/brainstorming`. The short name is the part before `@` in the registry key.
  const install = `${HOME}/plugins/cache/official/superpowers/6.3.0`;
  const fs = fakeFs(
    { [`${install}/skills`]: ["brainstorming"] },
    {
      [`${HOME}/plugins/installed_plugins.json`]: registry({
        "superpowers@claude-plugins-official": install,
      }),
      [`${install}/skills/brainstorming/SKILL.md`]: "---\ndescription: Turn an idea into a design\n---\n",
    },
  );

  const found = await readAgentCommands(CWD, [HOME], fs);

  expect(found).toEqual([{
    command: "/superpowers:brainstorming",
    description: "Turn an idea into a design",
    source: "plugin",
  }]);
});

test("only the version the registry names is read", async () => {
  // The trap this whole approach was once rejected over. Both versions are on
  // disk; the registry names one; the stale one must not appear.
  const live = `${HOME}/plugins/cache/x/mem/13.16.1`;
  const stale = `${HOME}/plugins/cache/x/mem/13.15.0`;
  const fs = fakeFs(
    { [`${live}/skills`]: ["recall"], [`${stale}/skills`]: ["recall"] },
    {
      [`${HOME}/plugins/installed_plugins.json`]: registry({ "mem@x": live }),
      [`${live}/skills/recall/SKILL.md`]: "---\ndescription: Live\n---\n",
      [`${stale}/skills/recall/SKILL.md`]: "---\ndescription: Stale\n---\n",
    },
  );

  const found = await readAgentCommands(CWD, [HOME], fs);

  expect(found).toHaveLength(1);
  expect(found[0]!.description).toBe("Live");
});

test("no plugin registry is not an error", async () => {
  const fs = fakeFs(
    { [`${HOME}/commands`]: ["eod.md"] },
    { [`${HOME}/commands/eod.md`]: "---\ndescription: User one\n---\n" },
  );

  expect((await readAgentCommands(CWD, [HOME], fs)).map((c) => c.command)).toEqual(["/eod"]);
});

test("a malformed plugin registry costs the plugins and nothing else", async () => {
  const fs = fakeFs(
    { [`${HOME}/commands`]: ["eod.md"] },
    {
      [`${HOME}/plugins/installed_plugins.json`]: "{ this is not json",
      [`${HOME}/commands/eod.md`]: "---\ndescription: User one\n---\n",
    },
  );

  expect((await readAgentCommands(CWD, [HOME], fs)).map((c) => c.command)).toEqual(["/eod"]);
});

test("the project wins a name the user also declares", async () => {
  // The more specific list is the one the operator reached for on this agent.
  const fs = fakeFs(
    { [`${CWD}/.claude/commands`]: ["check.md"], [`${HOME}/commands`]: ["check.md"] },
    {
      [`${CWD}/.claude/commands/check.md`]: "---\ndescription: Project one\n---\n",
      [`${HOME}/commands/check.md`]: "---\ndescription: User one\n---\n",
    },
  );

  const found = await readAgentCommands(CWD, [HOME], fs);

  expect(found).toHaveLength(1);
  expect(found[0]!.description).toBe("Project one");
});

test("with no Claude home, only the project is read", async () => {
  const fs = fakeFs(
    { [`${HOME}/commands`]: ["eod.md"] },
    { [`${HOME}/commands/eod.md`]: "---\ndescription: User one\n---\n" },
  );

  expect(await readAgentCommands(CWD, [], fs)).toEqual([]);
});
