import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
const directory = process.argv[2] ?? 'packages';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const platforms = {};
for (const file of readdirSync(directory).filter(name => name.startsWith('update-') && name.endsWith('.json'))) Object.assign(platforms, JSON.parse(readFileSync(path.join(directory, file), 'utf8')));
for (const target of ['windows-x86_64', 'linux-x86_64', 'darwin-x86_64', 'darwin-aarch64']) if (!platforms[target]?.signature) throw Error(`Missing signed update: ${target}`);
writeFileSync(path.join(directory, 'latest.json'), JSON.stringify({ version, notes: 'macOS Monterey catalog and Java fixes, Mac trackpad gestures, settings repair and signed in-app updates.', pub_date: new Date().toISOString(), platforms }, null, 2));
const url = `https://github.com/slhmc/slh/releases/download/v${version}/SLH-${version}-`;
const link = (label, target, suffix) => `[${label}](${url}${target}${suffix})`;
writeFileSync('release-notes.txt', `# ✨ SLH v${version} — A smoother launch on Mac

This pre-release fixes catalog loading and Java installation on Intel Macs, adds trackpad gestures and introduces signed launcher updates.

> ⚠️ Automated tests and builds cover all four desktop targets. A physical MacBook Pro with macOS Monterey 12.7.6 was not available for manual verification. Please report any remaining issue with launcher logs and your Minecraft version.

## 🍎 macOS fixes

- Fixed a Markdown dependency that used JavaScript syntax unsupported by Monterey WebKit, causing a blank catalog screen.
- Find Java inside macOS bundles and preserve the complete runtime bundle during installation.
- Allow slow Java downloads to finish and report stalled transfers.
- Open context menus with Control-click, a secondary trackpad click, or a 550 ms hold on empty space. Moving the pointer cancels the hold.

## 🔄 Launcher updates

- Offer an Update now button inside SLH with download progress and mandatory signature verification.
- Restart after installation; instances, accounts, settings and custom language files stay outside the updated application.
- Existing 0.2.0 installations need one manual upgrade because that version does not contain the new updater.

## 🛠️ Settings and repository cleanup

- Restore all settings sections when the 0.2.0 migration left only Bedrock visible. Preserve other customized section lists.
- Remove the unused Slint prototype from the release source tree; it remains available in Git history.
- Exclude third-party vendor code from GitHub language statistics.

## 🚧 Bedrock Edition — W.I.P.

Bedrock remains experimental and Windows-only.

## 📦 Downloads

| Platform | Installer / package | Portable / app archive |
| --- | --- | --- |
| 🪟 Windows 10 / 11 · x64 | ${link('EXE','x86_64-pc-windows-msvc','-setup.exe')} · ${link('MSI','x86_64-pc-windows-msvc','.msi')} | ${link('Portable ZIP','x86_64-pc-windows-msvc','-portable.zip')} |
| 🍎 macOS · Intel | ${link('DMG','x86_64-apple-darwin','.dmg')} | ${link('App ZIP','x86_64-apple-darwin','-app.zip')} |
| 🍎 macOS · Apple Silicon | ${link('DMG','aarch64-apple-darwin','.dmg')} | ${link('App ZIP','aarch64-apple-darwin','-app.zip')} |
| 🐧 Linux · x64 | ${link('DEB','x86_64-unknown-linux-gnu','.deb')} · ${link('RPM','x86_64-unknown-linux-gnu','.rpm')} | ${link('AppImage','x86_64-unknown-linux-gnu','.AppImage')} |

### 📝 Before testing

- Back up important worlds before trying a pre-release.
- Windows portable: extract the entire ZIP to a writable folder and run SLH.exe.
- Windows and Linux packages are unsigned. macOS packages are ad-hoc signed and not notarized. Updater signatures separately verify update integrity.
- Linux auto-update is supported for AppImage installations.
- Verify downloads with [SHA256SUMS.txt](https://github.com/slhmc/slh/releases/download/v${version}/SHA256SUMS.txt).

## 💬 Feedback and source

[Report a bug](https://github.com/slhmc/slh/issues) · [Source code](https://github.com/slhmc/slh)

Built from commit \`${process.env.GITHUB_SHA ?? 'local'}\`.
`);
