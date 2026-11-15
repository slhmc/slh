# Approved UX audit changes — 1 November 2026

The user approved R-01 through R-14 and excluded new backups/trash (R-15). No recovery store is implemented. Existing data and existing backup mechanisms are not migrated.

## Product contract

- general.confirmDestructiveActions defaults to true when absent. Advanced exposes the switch. It controls deletion confirmations for instances, content, accounts, saved server entries and local servers. Backend validation, compatibility errors and world-sync safeguards remain independent. The shared themed Dialog rejects concurrent duplicate requests.
- general.platformCustomization defaults to false. Enabling it exposes Appearance controls: systemControls (native selects, default false), windowControlsStyle (auto/windows/macos/linux), windowControlsSide (auto/left/right). Disabling preserves values but applies host defaults.
- Host defaults: macOS traffic lights on the left, Windows line/square/close on the right, Linux round controls on the right. These are custom drawn controls invoking Tauri actions, not native OS decorations. Green invokes fullscreen on macOS; Windows/Linux maximize restores/maximizes regardless of the selected visual style.
- OS traffic-light colors are reserved tokens in tokens.css. Everything else retains the active palette. Visible active feedback remains with reduced motion.
- Translation tools, manual Java and detailed appearance controls are disclosed on demand. Memory defaults have one editing location in Minecraft; Java links to it. Hide-on-launch remains in General.
- Default quick actions use four frequent commands plus More; explicit user action order/visibility is preserved. The multiplayer list is reached from a Java instance, retains its target and returns to that instance. Instance pages gain Library return. Startup selects the most recently used instance without launching it.

## WebKit compatibility

The screenshots show missing paints and unthemed native selects. Apple added color-mix in Safari 16.2; the OS version alone does not establish the exact installed WebKit version. Reference: https://developer.apple.com/documentation/safari-release-notes/safari-16_2-release-notes

Vite PostCSS lowers CSS srgb color-mix expressions to semantic palette variables. buildTheme calculates those variables as RGBA with premultiplied alpha, nested mixes and shadows. Dev and production use the same path. There is no platform-specific replacement palette. The numerical color converter is documented in the UI-audit exceptions. Restart Vite when adding a new mix expression so its compile-time registry refreshes.

Selects explicitly remove browser-native appearance by default; System-style dropdowns restores it. Actual native painting belongs to the host webview. Stop has an explicit themed fill/border; Home retains its theme-derived glow/shadow.

## Audit mapping

| ID | Result |
|---|---|
| R-01 | Deletion confirmation, default on, optional switch; no new backup |
| R-02 | Results keyed by instance/category; cleared on load; persistent error/Retry |
| R-03 | Store handler reuses translator, no event-time hook |
| R-04 | Explicit main-toggle callback; independent FAQ and keyboard switch |
| R-05 | Direct Offline/Ely.by forms; pledge removed; actual restrictions retained |
| R-06 | Narrow version/loader first, footer summary, compact source strip |
| R-07 | Technical narration removed; single Bedrock warning; UUID in Details |
| R-08 | Rare controls disclosed; memory/hide duplicates consolidated |
| R-09 | Context-specific screenshot/world empty states |
| R-10 | Known provider messages and account action names localized |
| R-11 | Short library heading and initial recent selection |
| R-12 | Frequent actions plus More, preserving custom order; Library return |
| R-13 | Shared add-account flow; direct activation of inactive accounts |
| R-14 | Contextual multiplayer entry/return; corrected Ely.by preview |
| R-15 | Excluded; no recovery/trash feature |

## Verification boundaries

Browser checks use isolated in-memory fixtures; Rust settings tests use temporary SQLite. No real account login, world deletion or installation is performed. Required sizes: 800x560 and 1440x900. RU/EN/DE, font-picker text, rows/tiles, light/dark and reduced motion are exercised in affected browser checks; existing appearance tests include effective 200 percent zoom.

Mac/Linux detection and overrides are simulated in Chrome. Actual Monterey WKWebView, Cocoa/GTK dropdown paint and native fullscreen require those operating systems. No macOS/Linux executable is built on this Windows host.

Native build and installed-executable replacement follow AGENTS.md: verify embedded frontend, retain previous executable, replace only E:/SLH/SLH.exe, preserve resources/languages and all user data. Final results are recorded below after completion.

## Final checks on the approved changes

- npm run check:ui: PASS, 2040 catalog values, matching parameters and UI-token checks.
- npm run build: PASS (also invoked by the Tauri release build). Existing large 3D bundle warnings remain.
- npm test: PASS, 49 files / 175 tests.
- cargo test, src-tauri manifest: PASS, 11 host tests.
- cargo test, slh-core library: PASS, 225 tests; 5 live/integration tests ignored.
- Playwright combined affected suite: PASS, 34 scenarios in one final run, including RU/EN/DE, 800x560 and 1440x900, effective 200 percent zoom, deletion/cancel/opt-out, file-read recovery, Store-handler fixture, offline onboarding, native-style overrides and Stop background.
- Emitted production CSS contains no color-mix expressions.
- Motion probe on changed window controls and switches: zero errors in normal and reduced-motion modes. Reduced mode reports three transition-property warnings for the default computed property on window buttons; press/focus feedback still passes without movement.
- Scoped window-control geometry dumps at 800 and 1440: zero errors. The existing 12px maximize versus 15px minimize/close icons produce an intentional icon-size warning in the Windows style; this preserves their established visual proportions. These are scoped geometry checks, not a full-app accessibility certification.
- Screenshots: artifacts/ui/ux-*.png and platform-options-ru-*.png. All supplied account imagery is excluded from generated fixtures.

## Installed Windows executable

Release Tauri build: PASS (12m32s). Embedded-frontend probe and WebView2 probe both returned 0. Only E:/SLH/SLH.exe was replaced; its SHA-256 matches the verified release build:

2D3AB72F8FCFF56C9B63EFD71430DBA3F51373CCDDB9E1A289FD42C46872694C

Size: 50,922,496 bytes. The previous executable is retained as E:/SLH/SLH.exe.bak-20261101-162802. This is an executable rollback copy required by AGENTS.md, not a game-data backup feature. Installed language-file hashes were identical before and after replacement. No running installed SLH process was present during replacement. User accounts, instances, settings and worlds were not opened or modified.

macOS/Linux packages need to be rebuilt from this source; no native host verification for those operating systems is claimed.
