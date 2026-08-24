/**
 * Renders `packaging/homebrew/paddock.rb.tmpl` into the Homebrew formula the
 * tap repository serves.
 *
 * The checksums come from the release's own SHA256SUMS rather than being
 * recomputed here, so the formula and the published artifacts cannot disagree:
 * there is one source for both, and it is the one `install.sh` and
 * `paddock update` already verify against.
 *
 * The template names its own platforms. This renderer resolves whatever
 * `{{sha256:<asset>}}` placeholders it finds, so adding or dropping a platform
 * is a template edit and nothing here changes.
 */

/** Parses `sha256sum` output: `<hex>  <name>`, or `<hex> *<name>` in binary mode. */
function digests(sums: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of sums.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [digest, ...rest] = trimmed.split(/\s+/);
    const asset = rest.join(" ").replace(/^\*/, "");
    if (digest && asset) out.set(asset, digest);
  }
  return out;
}

export function renderFormula(tmpl: string, version: string, sums: string): string {
  const known = digests(sums);
  const missing: string[] = [];

  const out = tmpl
    .replaceAll("{{version}}", version)
    .replace(/\{\{sha256:([^}]+)\}\}/g, (_match, asset: string) => {
      const digest = known.get(asset);
      if (!digest) {
        // Collected rather than thrown at the first miss, so a release that
        // published none of its assets reports all four instead of sending
        // whoever is debugging it round the loop once per platform.
        missing.push(asset);
        return "";
      }
      return digest;
    });

  if (missing.length > 0) {
    throw new Error(
      `render-formula: not listed in SHA256SUMS: ${missing.sort().join(", ")}`,
    );
  }
  return out;
}

// Run as a program only when invoked directly, so the tests above can import
// the renderer without it trying to read a release's files.
if (import.meta.main) {
  const [version, sumsPath, outPath] = process.argv.slice(2);
  if (!version || !sumsPath || !outPath) {
    console.error("usage: bun run scripts/render-formula.ts <version> <SHA256SUMS> <out.rb>");
    process.exit(2);
  }
  const tmpl = await Bun.file("packaging/homebrew/paddock.rb.tmpl").text();
  const sums = await Bun.file(sumsPath).text();
  await Bun.write(outPath, renderFormula(tmpl, version.replace(/^v/, ""), sums));
  console.log(`render-formula: wrote ${outPath} for ${version}`);
}
