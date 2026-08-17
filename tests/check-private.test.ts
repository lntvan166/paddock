import { expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runScanner(files: Record<string, string>): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "paddock-scan-"));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  const proc = Bun.spawn(["bash", join(process.cwd(), "scripts/check-private.sh"), dir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return await proc.exited;
}

// Fixture strings are ASSEMBLED at runtime rather than written as literals.
// A literal here would match the scanner's own patterns, so `make check-clean`
// would fail on this very file. Concatenation keeps the scanner honest and needs
// no exclusion rule — exclusions are how a scanner quietly stops working.
const HOME_PATH = "/" + "home/" + "someuser/.config";
const PRIVATE_IP = "192." + "168.1.20";
const EMAIL = "person" + "@" + "example.org";
const KEY_HEADER = "-----BEGIN RSA " + "PRIVATE KEY-----";

test("passes on clean content", async () => {
  expect(await runScanner({ "a.ts": "const host = 'paddock.example.com';\n" })).toBe(0);
});

test("fails on an absolute home path with a user segment", async () => {
  expect(await runScanner({ "a.ts": `const p = '${HOME_PATH}';\n` })).toBe(1);
});

test("does NOT fail on a bare path prefix used as documentation", async () => {
  const doc = "Patterns: `/" + "home/`, `/" + "Users/` are scanned.\n";
  expect(await runScanner({ "d.md": doc })).toBe(0);
});

test("fails on an email address", async () => {
  expect(await runScanner({ "a.ts": `// contact ${EMAIL}\n` })).toBe(1);
});

test("fails on a private key header", async () => {
  expect(await runScanner({ "k.pem": `${KEY_HEADER}\n` })).toBe(1);
});

test("fails on an RFC1918 address", async () => {
  expect(await runScanner({ "a.ts": `const ip = '${PRIVATE_IP}';\n` })).toBe(1);
});

// Regression coverage for a real defect: the scanner used to walk the raw
// filesystem, so gitignored scratch content (e.g. .superpowers/, .claude/)
// could fail a scan even though it can never be committed. It must scan only
// what git would actually let into a commit — tracked plus
// untracked-but-not-ignored files.
async function runScannerInGitRepo(files: Record<string, string>): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "paddock-scan-git-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: dir }).exited;
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  const proc = Bun.spawn(["bash", join(process.cwd(), "scripts/check-private.sh"), dir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return await proc.exited;
}

test("does NOT scan content inside a git-ignored path", async () => {
  expect(
    await runScannerInGitRepo({
      ".gitignore": "secret.txt\n",
      "secret.txt": `// contact ${EMAIL}\n`,
    }),
  ).toBe(0);
});

test("still scans tracked/untracked-not-ignored content inside a git repo", async () => {
  expect(
    await runScannerInGitRepo({
      "a.ts": `// contact ${EMAIL}\n`,
    }),
  ).toBe(1);
});
