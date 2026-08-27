import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCommand } from "@shared/types";

/**
 * The commands an agent's own project declares, for the reply field's
 * autocomplete.
 *
 * WHY THE WORKING DIRECTORY, and not the operator's home. Three sources were
 * measured before this one was chosen:
 *
 * - **herdr** cannot answer. `server.agent_manifests` returns
 *   `AgentManifestInfo`, which carries version and update bookkeeping —
 *   `active_version`, `cached_remote_version`, `source` — and no commands at
 *   all. `agent.explain` has no params or result shape in the schema.
 * - **the project** is clean: one copy, no version resolution, and paddock
 *   already carries `cwd` on every `Agent`, so the list costs no new herdr
 *   call and is correctly per-agent — two agents in different repositories
 *   offer different commands.
 * - **`~/.claude`** was rejected first, on the grounds that plugin skills sit
 *   on disk at EVERY installed version — `claude-mem` is present five times —
 *   so a walk would return one skill repeatedly. **That reasoning was wrong,
 *   and it was wrong because it was inferred from a directory listing rather
 *   than looked up.** `plugins/installed_plugins.json` names one `installPath`
 *   per plugin, pointing at the active version alone. It is read here, and
 *   nothing walks the cache. The user sources went in only once that registry
 *   was found; the symptom that sent us looking was `/superpowers:brainstorming`
 *   being absent, which no project-only reader could ever have offered.
 *
 * WHAT THIS CANNOT CONTAIN: the harness's built-in commands (`/clear`,
 * `/compact`, `/model`). They live inside the harness binary, on no
 * filesystem. Collie ships a hand-curated catalogue for exactly this reason.
 * paddock offers what the project declares and does not pretend to know the
 * rest — an autocomplete that silently omits `/clear` is honest; one that
 * lists a stale catalogue of somebody else's build is not.
 *
 * Reading harness files from the server is an established pattern here, not a
 * new one — see `journal/files.ts`, which reads session logs the same way and
 * owns the containment helper this file's sibling route reuses.
 */

/**
 * How many commands one agent may offer.
 *
 * A project declares a handful; this bounds the pathological case — a
 * directory of hundreds of generated files — so neither the response nor the
 * list under a thumb can be flooded. The cap is on what is OFFERED, and it is
 * applied after both layouts are read, so a project cannot hide its skills
 * behind a wall of commands.
 */
export const MAX_COMMANDS = 200;

/**
 * How much of a description survives to the wire.
 *
 * MEASURED, not guessed: a real project's `description: |` blocks put an
 * entire paragraph on the first line — 1172 characters in one case, because
 * the text is written as trigger guidance for a model rather than a summary
 * for a person. A list row shows one line, so the remainder can never be
 * displayed, and shipping it spends the operator's link on text nothing will
 * render. Cut at a word boundary with an ellipsis, so a truncated row says so
 * rather than appearing to end mid-thought.
 */
export const MAX_DESCRIPTION = 120;

/** Just enough filesystem to read a project. Injected, so a test needs none. */
export interface CommandFs {
  readdir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

export const nodeCommandFs: CommandFs = {
  readdir: (dir) => fsReaddir(dir),
  readFile: (path) => fsReadFile(path, "utf8"),
};

/**
 * The two layouts a Claude directory holds, in the order they are offered.
 *
 * Used for BOTH the project's `.claude` and each user-level Claude home, which
 * carry the same two shapes — so the layout is described once. Adding a harness
 * is an entry here, never a branch in the route: the same
 * single-decision-site rule `journal/registry.ts` states.
 */
const LAYOUTS = [
  { dir: "commands", kind: "file", source: "command" },
  { dir: "skills", kind: "dir", source: "skill" },
] as const;

/** Where the harness records which version of each plugin is live. */
const PLUGIN_REGISTRY = "installed_plugins.json";

/**
 * The first line of a document's frontmatter `description`.
 *
 * Deliberately not a YAML parser. Only one key is wanted, the frontmatter is
 * the harness's own generated shape, and a dependency that can throw on a
 * malformed file would turn one bad command into no autocomplete. What it
 * handles is what harnesses actually write: a plain scalar, a quoted scalar,
 * and a `|` block whose first line is the summary and whose remainder is
 * trigger guidance meant for the model rather than the operator.
 *
 * Scoped to the leading `---` block, so a body that happens to contain a line
 * beginning `description:` is not mistaken for one.
 */
export function parseDescription(text: string): string | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;

  const lines = text.slice(3, end).split("\n");
  const at = lines.findIndex((l) => l.startsWith("description:"));
  // Read through a binding rather than indexing twice: `findIndex` does not
  // narrow the lookup that follows it.
  const line = at === -1 ? undefined : lines[at];
  if (line === undefined) return null;

  const inline = line.slice("description:".length).trim();
  // A block scalar (`|`, `>`, and their chomping variants) puts the text on
  // the following lines; anything else is the value itself.
  const raw = /^[|>][-+]?$/.test(inline) ? (lines[at + 1] ?? "").trim() : inline;
  const unquoted = raw.replace(/^(['"])(.*)\1$/, "$2").trim();
  if (unquoted === "") return null;
  return unquoted.length <= MAX_DESCRIPTION ? unquoted : clip(unquoted);
}

/** Cut to `MAX_DESCRIPTION`, preferring the last word boundary before it. */
function clip(text: string): string {
  const head = text.slice(0, MAX_DESCRIPTION);
  const lastSpace = head.lastIndexOf(" ");
  // Only honour the boundary if it is not so early that the row says nothing;
  // a single 200-character word is cut mid-word rather than shown as "…".
  const cut = lastSpace > MAX_DESCRIPTION / 2 ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd()}…`;
}

/**
 * Whether a listing entry may be turned into a path at all.
 *
 * `readdir` returns basenames, so nothing here should ever be rejected — which
 * is precisely why it is cheap to check. A separator or a dot segment reaching
 * the `join` is how a directory listing becomes a traversal, and a leading dot
 * is a hidden file no operator meant to offer.
 */
function isPlainName(name: string): boolean {
  return !name.includes("/") && !name.includes("\\") && !name.startsWith(".");
}

async function readOne(
  fs: CommandFs,
  path: string,
  name: string,
  source: AgentCommand["source"],
): Promise<AgentCommand | null> {
  try {
    return { command: `/${name}`, description: parseDescription(await fs.readFile(path)), source };
  } catch {
    // One unreadable file must not cost the operator every other command. Not
    // a swallowed error in the sense the project bans: the absence is visible
    // in the list itself, and the alternative is no list at all.
    return null;
  }
}

/**
 * Everything one Claude directory declares — its commands and its skills.
 *
 * `prefix` is prepended to the command name, never to the path: a plugin skill
 * is invoked as `/<plugin>:<skill>`, and only the visible name is namespaced.
 *
 * Symlinks are FOLLOWED rather than refused. A user skill can legitimately be a
 * link — one of them here points into a shared `.agents` directory — so a
 * containment check against the Claude home would exclude a working command.
 * Nothing the browser sends reaches these paths (see the route), so there is no
 * traversal to contain: every name comes from a listing of a directory this
 * code chose.
 */
async function readClaudeDir(
  fs: CommandFs,
  base: string,
  prefix = "",
  sourceOverride?: AgentCommand["source"],
): Promise<AgentCommand[]> {
  const found: AgentCommand[] = [];

  for (const layout of LAYOUTS) {
    const root = join(base, layout.dir);

    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      // No such directory. The common case by a wide margin, and it must be an
      // empty list rather than an error, because the reply field still works.
      continue;
    }

    const source = sourceOverride ?? layout.source;
    for (const entry of entries) {
      if (!isPlainName(entry)) continue;

      if (layout.kind === "file") {
        if (!entry.endsWith(".md")) continue;
        const one = await readOne(fs, join(root, entry), `${prefix}${entry.slice(0, -3)}`, source);
        if (one) found.push(one);
      } else {
        // A skill is a DIRECTORY holding SKILL.md; the directory's name is the
        // command. A directory without one is somebody's notes, not a skill.
        const one = await readOne(fs, join(root, entry, "SKILL.md"), `${prefix}${entry}`, source);
        if (one) found.push(one);
      }
    }
  }

  return found;
}

/**
 * The skills of every INSTALLED plugin, at the version the harness is actually
 * running.
 *
 * This function is the whole reason the user-level sources are safe to read.
 * The registry maps a plugin key to one `installPath`; every other version in
 * the cache is ignored, so the five copies of one plugin on disk cannot become
 * five rows in the list.
 *
 * The plugin's short name — the part before `@` — is what namespaces the
 * command, matching how the harness accepts it.
 *
 * A missing registry means no plugins, which is ordinary. A MALFORMED one is
 * logged: it is the harness's own file, so paddock failing to parse it is worth
 * saying out loud, and it still costs only the plugin entries.
 */
async function installedPluginSkills(fs: CommandFs, home: string): Promise<AgentCommand[]> {
  let text: string;
  try {
    text = await fs.readFile(join(home, "plugins", PLUGIN_REGISTRY));
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(`commands: could not parse ${join(home, "plugins", PLUGIN_REGISTRY)}`, err);
    return [];
  }

  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (typeof plugins !== "object" || plugins === null) return [];

  const found: AgentCommand[] = [];
  for (const [key, installs] of Object.entries(plugins as Record<string, unknown>)) {
    // `superpowers@claude-plugins-official` is invoked as `superpowers:`.
    const short = key.split("@")[0] ?? key;
    if (short === "" || !Array.isArray(installs)) continue;

    for (const install of installs) {
      const path = (install as { installPath?: unknown } | null)?.installPath;
      if (typeof path !== "string" || path === "") continue;
      found.push(...await readClaudeDir(fs, path, `${short}:`, "plugin"));
    }
  }
  return found;
}

/**
 * Every command this agent can be offered, best-scoped first.
 *
 * `homes` are the user's Claude directories — `claudeHomes` in
 * `journal/files.ts`, which owns the one parse of `CLAUDE_CONFIG_DIR`. An empty
 * list reads the project alone, which is what `--demo` gets.
 *
 * ORDER IS THE PROJECT FIRST, then each home. It carries two meanings: the
 * filter's ranking preserves it within a tier, so the more specific command
 * surfaces higher; and the deduplication below keeps the FIRST of a repeated
 * name, so a project that defines `/check` shadows a user-level `/check`
 * rather than showing both under one label.
 */
export async function readAgentCommands(
  cwd: string,
  homes: readonly string[],
  fs: CommandFs = nodeCommandFs,
): Promise<AgentCommand[]> {
  const found: AgentCommand[] = await readClaudeDir(fs, join(cwd, ".claude"));

  for (const home of homes) {
    found.push(...await readClaudeDir(fs, home));
    found.push(...await installedPluginSkills(fs, home));
  }

  const seen = new Set<string>();
  const unique = found.filter((c) => {
    if (seen.has(c.command)) return false;
    seen.add(c.command);
    return true;
  });

  return unique.slice(0, MAX_COMMANDS);
}
