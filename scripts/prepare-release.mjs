import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
const directory = process.argv[2] ?? 'packages';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const platforms = {};
for (const file of readdirSync(directory).filter(name => name.startsWith('update-') && name.endsWith('.json'))) Object.assign(platforms, JSON.parse(readFileSync(path.join(directory, file), 'utf8')));
for (const target of ['windows-x86_64', 'linux-x86_64', 'darwin-x86_64', 'darwin-aarch64']) if (!platforms[target]?.signature) throw Error(`Missing signed update: ${target}`);
writeFileSync(path.join(directory, 'latest.json'), JSON.stringify({ version, notes: 'CurseForge installs and auto-import, improved Java discovery, localized UI and themes, character modes, macOS fixes and signed in-app updates.', pub_date: new Date().toISOString(), platforms }, null, 2));
const url = `https://github.com/slhmc/slh/releases/download/v${version}/SLH-${version}-`;
const link = (label, target, suffix) => `[${label}](${url}${target}${suffix})`;
writeFileSync('release-notes.txt', `# ✨ SLH v${version} — Better modpacks, a personal home and smoother updates

This pre-release includes the complete current launcher: improved CurseForge installation, expanded customization, Java discovery, lower background activity and signed in-app updates.

> ⚠️ Automated tests and builds cover all four desktop targets. A physical MacBook Pro with macOS Monterey 12.7.6 was not available for manual verification. Please report any remaining issue with launcher logs and your Minecraft version.

## 🧩 CurseForge and catalogs

- Install CurseForge modpacks with version selection, world archives, batching, caching and retry handling.
- Continue the same instance after an interrupted install, cancel downloads and keep downloaded files for retry.
- Open exact download pages for files whose authors disallow automatic downloads; pick up manually downloaded files with hash verification.
- Watch a chosen downloads folder for CurseForge ZIP archives and import them automatically. Optional source cleanup runs only after successful installation.
- Browse categories, images, tables and links in full Modrinth and CurseForge descriptions. Restricted downloads still need a browser click.

## 🎨 Interface and personalization

- Use grouped library icons alongside grid and list views; drag instances between groups and save their order.
- Switch the home character between animated 3D, a locally cached portrait and off; update its pose, lighting and three-position control.
- Search modpacks from the home screen, adjust title fitting and use the expanded appearance palette and compact layouts.
- Reload custom translations without restarting. Existing language values stay intact, and missing new labels use embedded fallbacks.
- Improve settings controls, narrow layouts, account menus and silent Windows notifications with the launcher logo.

## ☕ Java and performance

- Find installed Java quickly, remove duplicate entries and keep full disk scanning as a separate action.
- Select a compatible Java version automatically and download a managed runtime when needed and enabled.
- Show progress indicators for background operations and always finish Java progress on success or failure.
- Reduce repeated 3D work, retained caches and hidden-window timers; preserve the current WebView2 interface.
- Earlier experimental Slint builds and removed manual resource limits are not part of this release.

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
- Preserve settings from local builds and support their existing semantic-color migration.
- Keep custom language files intact and supply missing new strings in memory.
- Preserve the existing local fix for navigation to a deleted instance.

## 🚧 Bedrock Edition — W.I.P.

Bedrock remains experimental and Windows-only. Downloading conflicting Preview packages is disabled; an existing Store Preview installation remains usable.

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
- The extra macOS .app.tar.gz files and latest.json serve the automatic updater. Their signatures are embedded in latest.json; you do not need these files for manual installation.
- Verify downloads with [SHA256SUMS.txt](https://github.com/slhmc/slh/releases/download/v${version}/SHA256SUMS.txt).

## 💬 Feedback and source

[Report a bug](https://github.com/slhmc/slh/issues) · [Source code](https://github.com/slhmc/slh)

Built from commit \`${process.env.GITHUB_SHA ?? 'local'}\`.
`);

// Fragments are build intermediates. Signatures remain embedded in latest.json,
// so separate .sig files are not needed in the public download list.
for (const name of readdirSync(directory)) {
  if ((name.startsWith('update-') && name.endsWith('.json')) || name.endsWith('.sig')) unlinkSync(path.join(directory, name));
}
