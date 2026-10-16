# SLH v0.1 implementation plan

## Locked stack

- Tauri `2.11.5`, Tauri CLI `2.11.4`, Tauri API `2.11.1`
- Rust `1.97.1`, Tokio `1.53.1`, Reqwest `0.13.4`, SQLx `0.9.0`
- React `19.2.8`, TypeScript `7.0.2`, Vite `8.2.1`
- React Router `7.18.2`, Zustand `5.0.14`, Zod `4.4.3`
- Vitest `4.1.10`, Playwright `1.62.1`

`package-lock.json`, `Cargo.lock`, and `rust-toolchain.toml` are the reproducibility source of truth.

## Delivery order

1. Portable Tauri shell, SQLite migrations, brand system, runtime locales, typed settings.
2. Instances, groups, Offline account, Java detection, Vanilla install and launch.
3. Fabric, Forge, NeoForge, Quilt, and managed Java adapters.
4. Microsoft and Ely.by account providers with secure token storage.
5. Modrinth, optional CurseForge, project details, dependency-aware installs.
6. Hash-based local sync, conflicts, and backups.
7. Import/export, repair, worlds, screenshots, servers, downloads, and storage tools.
8. Accessibility, performance, diagnostics, portable release verification, and documentation.

Every milestone must remain buildable and must expose unavailable capabilities honestly.

## Checkpoint — 2026-08-09 (continued)

Implemented and verified:

- M0/M1 foundation: portable executable-relative paths, SQLite migrations, runtime locales, brand assets/icons, dark React shell, settings, onboarding, library views, and documentation.
- M2: groups and instances, deterministic Offline UUIDs, Java discovery/validation, verified Vanilla metadata/libraries/assets/natives installer, structured launch arguments, process/log/playtime tracking, and duplicate-launch protection.
- M3: Fabric and Quilt metadata/profile adapters, official Forge and NeoForge installer adapters, compatibility-filtered loader versions, Java discovery, and verified portable Temurin 8/17/21 installation through Adoptium.
- M4: Microsoft system-browser Authorization Code + PKCE flow, Xbox/XSTS/Minecraft profile exchange, refresh handling, and DPAPI token blobs; Ely.by launcher authentication, 2FA challenge, DPAPI token blobs, and SHA-256-pinned authlib-injector boundary. Live provider acceptance remains pending because credentials/configuration are external.
- M5: live Modrinth search and dependency-aware installation with compatibility/conflict planning, verified downloads, managed-content records, and backups. CurseForge is a second runtime-key-gated provider with official API search, compatibility/dependency planning, distribution-permission enforcement, and SHA-1-verified installation.
- M6: explicit local mappings, pre-launch pull, post-exit push, SHA-256 snapshots, two-sided conflict detection, atomic copy, backups, and Worlds safety gate.
- M7: real Mods/Worlds/Screenshots/Logs indexing, install repair, storage diagnostics, download history, 30-day log rotation, NBT-safe `servers.dat` editing with backups, folder import with credential/cache exclusions, SLH export/import, `.mrpack` import, and key-gated CurseForge manifest v1 import. Archives and folder copies validate paths, symlinks, entry counts, expansion limits, hashes, staging, and atomic replacement.
- M8 partial: strict frontend/backend builds are clean, unavailable states remain explicit, secrets are redacted, long lists use browser rendering containment, Playwright covers the primary browser shell flows, and the portable release layout has been generated successfully. Live credential/provider acceptance, real game launch acceptance, and native desktop acceptance remain external/manual release gates.

Current automated baseline: clean TypeScript/Vite build, 2 Vitest tests, 29 Rust unit tests, 3 Playwright browser-shell scenarios, warning-free locked `cargo check`, visual browser verification of primary routes/dialogs, optimized Tauri build, portable layout generation, and release-executable startup/migration smoke test. External account/provider and real Minecraft launch acceptance remain manual gates.

## Primary blockers

- Microsoft requires a registered public desktop application client ID.
- CurseForge requires a personal API key supplied at process start through `SLH_CURSEFORGE_API_KEY` and compliance with its platform terms.
- Ely.by and loader endpoints must be rechecked against current official documentation before release.
- Windows builds require MSVC Build Tools and WebView2.
