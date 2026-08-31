# Install, binary distribution and update — design

**Status:** approved, not yet implemented.
**Extends** `docs/design/2026-08-17-paddock-design.md`.

## Goal

Make paddock installable and upgradable in one command each:

```bash
curl -fsSL https://paddock.vercel.app/install.sh | sh
paddock update
```

Three subsystems, stacked. Each is independently useful and independently
shippable, and they are listed in the order they must be built:

1. **A self-contained binary** — the compiled binary is the whole product.
2. **Release pipeline and installer** — tagged builds per platform, checksums,
   a `curl | sh` that installs without `sudo`.
3. **Explicit update** — `paddock update`, plus a way to learn a new version
   exists without paddock modifying itself unasked.

## What was measured first

Four facts were established by probe rather than assumed, because each one
would have changed the design:

- **The current binary is a half-product.** Compiled with today's `make build`
  and run from an empty directory, `/api/health` answered and herdr connected
  with six live agents — but `GET /` returned **404**. `routes.ts` reads static
  assets from disk at runtime, so the binary only serves a dashboard when it
  happens to be standing next to a `dist/`. Fixing this is a prerequisite, not
  a nicety: installing today's binary to `~/.local/bin` yields an API with no UI.
- **Bun cross-compiles.** A Linux machine produced genuine `Mach-O arm64`,
  `Mach-O x86_64`, `ELF aarch64` and `PE32+` binaries. The release workflow is
  therefore ONE `ubuntu-latest` job, not a runner matrix with paid macOS time.
  Windows was included in that probe and builds fine — it is dropped below for a
  product reason, not a build one, and that distinction is worth keeping: if
  herdr ever ships for Windows, the pipeline needs one more line and nothing else.
- **Bun embeds files into compiled binaries.** `import x from "./f" with { type:
  "file" }` followed by `Bun.file(x)` read correctly from a directory containing
  no `dist/`. This is the mechanism section 1 depends on.
- **herdr does not run on Windows.** Its releases publish exactly four assets:
  `herdr-linux-aarch64`, `herdr-linux-x86_64`, `herdr-macos-aarch64`,
  `herdr-macos-x86_64`. paddock reaches herdr over a unix domain socket, so a
  Windows paddock would start and find nothing to connect to. Windows is out of
  scope — see Decisions.

## Scope

**In:** embedding the built UI; `--version`; `paddock update`; a release
workflow producing four binaries and `SHA256SUMS`; `install.sh`; a cached,
opt-out version check surfaced in the dashboard.

**Out, deliberately:** Windows; release signing (see Security); update
channels (herdr has stable/preview; paddock has one channel until there is a
reason for two); package-manager distribution (Homebrew, AUR); auto-applying
updates without the operator asking.

## 1. The self-contained binary

`scripts/gen-embedded.ts` walks `dist/` and generates `src/server/embedded.ts`:
a map of URL path to embedded file handle, one `import … with { type: "file" }`
per asset.

It must be generated per build rather than committed, because Vite
content-hashes asset filenames — `index-Co2bYcwY.js` changes every time the
bundle changes. The generated module is a build artifact: gitignored, produced
by `make build`, never hand-edited.

`routes.ts` serves from the embedded map when it is populated and falls back to
`staticDir` when it is not. That fallback is what keeps `make dev` and its HMR
loop working unchanged, and keeps `PADDOCK_STATIC_DIR` meaningful for the
Docker image.

**The failing case is the test.** A compiled binary run from a directory with no
`dist/` must serve the dashboard at `/`. That is exactly the probe that proved
the current defect, promoted to a regression test.

## 2. Version and the CLI

Bare `paddock` still starts the dashboard, and `--demo` is unchanged. Preserving
that is deliberate: the Docker `CMD`, the README, and every screenshot caption
assume it, and a distribution change should not break the thing being
distributed.

Added:

| Command | Behaviour |
|---|---|
| `paddock --version`, `-V` | Print the version and exit |
| `paddock update` | Download, verify and install the latest release |
| `paddock update --check` | Report whether a newer version exists; change nothing |

The version is injected at build time from the git tag via `bun build`'s
`--define`, so no file has to be edited or committed per release and the tag
stays the single source of truth. A build with no tag reports `0.0.0-dev`, so a
binary can always answer whether it came from a release — which matters when
someone reports a bug against a binary they built themselves.

Today's argument handling is `new Set(Bun.argv.slice(2))`, which is adequate for
flags and cannot express a verb carrying its own flag. It grows into a small
parser in `src/server/cli.ts`. No dependency: the surface is four commands.

The existing reserved verbs (`agent`, `hub`, which exit pointing at
`docs/roadmap.md`) keep that behaviour.

## 3. Release pipeline

`.github/workflows/release.yml`, triggered on a `v*` tag. One `ubuntu-latest`
job:

1. `bun install`
2. `bun run build:web`
3. `bun run scripts/gen-embedded.ts`
4. compile four targets
5. write `SHA256SUMS`
6. attach the binaries and `SHA256SUMS` to the GitHub release

Asset names mirror herdr's vocabulary exactly — `paddock-linux-x86_64`,
`paddock-linux-aarch64`, `paddock-macos-x86_64`, `paddock-macos-aarch64` — so
the two projects read as siblings, the same reasoning that put herdr's palette
in the logo. No version in the filename; the release tag in the URL carries it,
as herdr's do.

`ci.yml` is unchanged and still gates pull requests. The release workflow runs
only on tags, so a red CI run cannot be released around.

## 4. `install.sh`

Detects OS and architecture from `uname`, maps them to an asset name, downloads
that asset and `SHA256SUMS`, **verifies the checksum before writing anything**,
installs to `~/.local/bin/paddock`, and `chmod +x`.

- **Never `sudo`.** `~/.local/bin` is a user-writable directory that needs no
  privilege escalation, which is also what herdr does. A one-liner that asks for
  root to install a dashboard is a habit worth not teaching.
- **Warns when `~/.local/bin` is not on `PATH`**, and prints the line to add.
  Silently installing something the shell cannot find is a support burden.
- **Refuses an unrecognised platform** with the list of what exists, rather than
  downloading something that cannot run.
- **Aborts on a checksum mismatch** without writing the binary.

Hosted on the GitHub Pages site already deployed for the demo. **That is a
dependency, not a coincidence:** `demo.yml` publishes the directory `dist-demo`
as the Pages artifact, so `install.sh` must be copied into `dist-demo` by that
workflow or the published URL returns 404 while every other page keeps working.
A check asserts the script is present in the artifact, because the failure mode
is a broken install command on a site that otherwise looks healthy.

The published command is:

```bash
curl -fsSL https://paddock.vercel.app/install.sh | sh
```

The README will also show how to read it before running it, because telling
people to pipe a URL into a shell without mentioning that is how the habit
spreads.

## 5. `paddock update`

1. Query the GitHub releases API for the latest tag.
2. Compare with the embedded version; if current, say so and stop.
3. Download the asset for the running platform, plus `SHA256SUMS`. The asset is
   chosen from `process.platform` and `process.arch` through the same mapping
   table `install.sh` uses — `darwin`/`linux` to `macos`/`linux`, `arm64`/`x64`
   to `aarch64`/`x86_64` — so the installer and the updater cannot disagree
   about what to fetch. An unmapped pair aborts rather than guessing.
4. Verify SHA-256. On mismatch, abort and leave the existing binary untouched.
5. Write the new binary beside the current one, `chmod`, then `rename` over it.

`rename(2)` over a running executable is safe on Linux and macOS: the running
process keeps its inode, and the next invocation gets the new file. This is the
whole reason dropping Windows simplifies the design — a running `.exe` cannot be
replaced in place and would have needed a separate dance.

**Refuse rather than half-update.** If the binary is not writable — installed by
a package manager, or into a system directory — `update` says so and names the
path, instead of failing partway. Same for a download that is short or a
checksum that does not match: nothing replaces the working binary until the
replacement is verified.

## 6. Learning that a new version exists

**No network call on startup.** Checking on every run would phone GitHub each
time paddock starts, make the tool depend on connectivity it does not otherwise
need, and leak usage timing. Instead:

- a check at most once per 24 hours, cached in
  `~/.config/paddock/update-check.json` alongside `settings.json`
- surfaced in the dashboard as a dim line, reusing the existing `UpdateBar`
  idea rather than inventing a second notification concept
- disabled entirely with `PADDOCK_NO_UPDATE_CHECK=1`
- failure is silent in the UI and logged at INFO — a version check that cannot
  reach GitHub is not a reason to show the operator an error about a dashboard
  that is working

The cache file records the last check time and the last seen version, so a
restart does not re-check.

## 7. Security

Verified in both `install.sh` and `paddock update`: HTTPS only, GitHub hosts
only, checksum before install, no `sudo` anywhere, and no execution of anything
downloaded other than the binary the operator asked for.

**What this does not protect against, stated plainly:** `SHA256SUMS` is
published on the same GitHub release as the binaries. It therefore defends
against a corrupted download or a broken TLS path — and **not** against a
compromised release, a compromised account, or a malicious maintainer. Real
protection needs a signature from a key that does not live on GitHub.

That is not proposed here, because key management is its own project with its
own failure modes, and a signing key checked into CI is theatre. It is recorded
because the honest version matters more than usual for this project: paddock can
send keystrokes to coding agents, so a bad update is not merely a bad dashboard.
`docs/roadmap.md` carries it as a known gap.

**The update is explicit by design.** paddock never modifies itself unasked. The
operator runs `paddock update`, which is the difference between a tool that can
be upgraded and a tool that can change underneath you.

## 8. Testing

- **The binary serves the dashboard from a directory with no `dist/`** — the
  probe that found the original defect, promoted to a test.
- The embed manifest covers every file in `dist/`, so a new asset type cannot be
  silently omitted.
- `install.sh`'s platform table maps each `uname` pair to the right asset, and
  an unknown pair exits non-zero.
- **A corrupted checksum aborts the install**, leaving no binary behind.
- **A corrupted checksum aborts the update**, leaving the existing binary
  working — the most important test here, because the failure it prevents is
  replacing a working install with a broken one.
- A non-writable target makes `update` refuse with the path named.
- `--version` reports the injected version, and `0.0.0-dev` when untagged.

Every one is to be broken deliberately and watched fail before it is trusted.

## Decisions recorded

1. **Windows is out of scope**, because herdr publishes no Windows build and
   paddock speaks to it over a unix socket. Shipping a binary that starts and
   then cannot find herdr would be worse than shipping none.
2. **Bare `paddock` keeps serving.** A distribution change that broke the
   documented invocation would defeat its own purpose.
3. **One `ubuntu-latest` job**, because cross-compilation was proven rather than
   assumed. No macOS runners.
4. **The embed manifest is generated, not committed**, because Vite's content
   hashes change every build; a committed manifest would drift silently.
5. **Update is explicit, never automatic.** The operator decides when code that
   can type into their agents gets replaced.
6. **Checksums, not signatures**, with the limitation written down rather than
   implied.
7. **Asset names mirror herdr's**, so the sibling relationship is visible in the
   filenames as well as the artwork.
