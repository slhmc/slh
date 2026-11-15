# Friends networking removal — 2026-11-05

Historical record. The later local-contact P2P implementation was also removed on 9 November 2026; see [current removal](friends-removal-2026-11-09.md).

The built-in Play with friends feature has been removed, including its settings section, invitation dialogs, WebRTC TCP bridge, LAN-log discovery, Cloudflare STUN usage, UPnP port management, Tauri commands, feature-only dependencies, translations and obsolete networking tests/documentation.

Local Minecraft servers and their ordinary networking settings remain available. Existing user data is not migrated or rewritten. Legacy sharing preferences are inert; unknown navigation entries are filtered, and an old settings URL displays General settings. No replacement networking service is introduced.

## Verification

- UI catalog audit: passed, 2045 values with matching EN/RU/DE/template parameters.
- Frontend production build: passed.
- Vitest: 50 files, 180 tests passed.
- Playwright: two legacy-settings scenarios passed at 800×560 and 1440×900, including keyboard focus and server settings navigation. Both screenshots inspected; existing settings composition is preserved.
- Rust core: 226 passed, 6 ignored; native shell: 11 passed. The initial parallel core run had one failure in the existing player-list startup timing scenario; its isolated rerun and the complete sequential run both passed. No unrelated player-list code was changed.
- Native release: built successfully; embedded-frontend and WebView2 probes passed. Launched via agent-desktop with --isolated and a fresh --data-dir; first-run screen inspected, then the process was terminated and its absence verified. UI Automation exposed browser chrome rather than useful page controls, so native verification was limited to launch and screenshot; settings interaction was covered by Playwright.
- A whole-repository git diff --check also reports existing whitespace problems in unrelated work in progress; those files were preserved.

No router, firewall, account, instance or installed language files are changed. Native smoke testing uses an isolated data directory. Only the installed launcher executable is replaced after backup and validation.

## Installed executable

Updated only `E:\SLH\SLH.exe`, after verifying that no SLH process was running.

Backup: `E:\SLH\launcher-backups\SLH-before-friends-removal-20261105-221449.exe`. Backup SHA-256 matched the previous executable.

Installed SHA-256: `773D43B6B1876B4771791678A09BA11D6154979CB6AD26B225B55BCA80B20061`; matches the tested release binary.

All five existing installed language files retained their original SHA-256 hashes. User accounts, instances and settings were not edited. The installed launcher was left closed.
