import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";

const directory = process.argv[2] ?? "packages";
const internalVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const version = internalVersion.replace(/\+1$/, ".1");
const platforms = {};
const files = readdirSync(directory);
for (const file of files.filter(name => name.startsWith("update-") && name.endsWith(".json"))) {
  Object.assign(platforms, JSON.parse(readFileSync(path.join(directory, file), "utf8")));
}
for (const target of ["windows-x86_64", "linux-x86_64", "darwin-x86_64", "darwin-aarch64"]) {
  if (!platforms[target]?.signature) throw Error(`Missing signed update: ${target}`);
  const url = new URL(platforms[target].url);
  if (url.origin !== "https://github.com" || !url.pathname.startsWith(`/slhmc/slh/releases/download/v${version}/`)) {
    throw Error(`Unexpected update URL: ${target}`);
  }
  if (!existsSync(path.join(directory, path.basename(url.pathname)))) throw Error(`Missing update payload: ${target}`);
}
const expected = {
  "x86_64-pc-windows-msvc": ["-setup.exe", ".msi", "-portable.zip"],
  "x86_64-apple-darwin": [".dmg", "-app.zip", ".app.tar.gz"],
  "aarch64-apple-darwin": [".dmg", "-app.zip", ".app.tar.gz"],
  "x86_64-unknown-linux-gnu": [".AppImage", ".deb", ".rpm"],
};
for (const [target, suffixes] of Object.entries(expected)) {
  for (const suffix of suffixes) {
    const file = `SLH-${version}-${target}${suffix}`;
    if (!existsSync(path.join(directory, file))) throw Error(`Missing release package: ${file}`);
  }
}
const template = readFileSync(`docs/releases/v${version}.md`, "utf8");
const notes = template.replaceAll("{{VERSION}}", version).replaceAll("{{COMMIT}}", process.env.GITHUB_SHA ?? "local");
if (/\{\{[A-Z_]+\}\}/.test(notes)) throw Error("Unresolved release note placeholder");
writeFileSync("release-notes.txt", notes);
writeFileSync(path.join(directory, "latest.json"), JSON.stringify({
  version: internalVersion,
  notes: "Local servers and Leaf, experimental Horizon, offline skins, legacy Minecraft and Forge fixes, more reliable Modrinth/CurseForge installs and launch diagnostics.",
  pub_date: new Date().toISOString(),
  platforms,
}, null, 2));
// Signatures remain inside latest.json; fragments are CI intermediates.
for (const name of files) {
  if ((name.startsWith("update-") && name.endsWith(".json")) || name.endsWith(".sig")) {
    unlinkSync(path.join(directory, name));
  }
}
console.log(`Prepared v${version}: 12 packages, updater manifest and checksum list pending.`);
