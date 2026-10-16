# SLH code audit — 2026-10-14

Scope: the current working tree in `E:\Codex Projects\Apps\SLH`, including its existing uncommitted changes. `E:\SLH\BUILD-INFO.json` was read to identify the installed build; the installed launcher and its data were not modified or launched. This is a source audit, not a claim that every source finding is present in the installed executable.

Follow-up requested by the user: the conditional export effect and its dialog-opening helper were moved above the InstancePage early returns. Deletion now checks for page errors and a usable library, and a new test covers valid-instance → missing-instance → library navigation. The updated frontend passed 112 unit tests and all 9 Playwright scenarios against the production build. Findings below retain the original audit evidence; finding 1 is fixed in the follow-up source, while finding 2 is addressed for these regression scenarios. Broader cleanup findings remain open.

The follow-up release was installed at `E:\SLH\SLH.exe` after embedded-frontend and WebView2 diagnostic probes passed. SHA-256: `01627819ecc29ef7aba48c95c610a3c4cd0b4909e57c6030f01eeb977e23a249`. The previous executable and metadata are backed up in `E:\Codex Projects\Apps\SLH\backups\audit-update-20261014T152817Z`. Post-install verification confirmed all 23 protected file hashes and 95,392 data/resource metadata entries were unchanged. The native helper was identical to the project helper and was retained. Only SLH.exe and BUILD-INFO.json were replaced in the installed directory; the launcher was left closed. This update includes the hook fix, not the remaining cleanup/refactoring findings.

## Findings, ordered by practical impact

### 1. P1 — Conditional React hook in InstancePage causes a runtime error

Evidence: `src/routes/Instance/InstancePage.tsx:608–609` returns early when bootstrap or instance is missing. Another `useEffect` is called at line 791, below those returns. Deleting the currently open instance refreshes bootstrap and changes the number of hooks executed by the same component.

Reproduction: open `/#/instance/preview-1?tab=settings` in browser preview, click Delete, capture `pageerror`. The route changes to `/#/library`, but React emits:

> Rendered fewer hooks than expected. This may be caused by an accidental early return statement.

The error appeared during the existing Playwright suite and was independently reproduced with a page-error listener. Fix by moving the effect above all conditional returns and guarding its body, or by separating the resolved-instance view into a child component. The effect depends on export-dialog behavior, so preserve that behavior while moving it.

### 2. P2 — End-to-end tests pass despite an uncaught React error

Evidence: `tests/e2e/shell.pw.ts:65` tests deletion and checks the URL and disappearance of a library item. None of the checked-in e2e/UI tests install a `pageerror` failure guard. All eight e2e tests passed during this audit despite finding 1.

Add a shared page-error guard and a deletion regression assertion that verifies the library remains usable. Browser preview coverage does not verify native command implementations, real authentication, or game launch.

### 3. P2 — Two page components concentrate too many responsibilities

Measured physical lines, including comments and blank lines:

| File | Lines | useState calls | useEffect calls |
| --- | ---: | ---: | ---: |
| `src/routes/Instance/InstancePage.tsx` | 1,426 | 57 | 16 |
| `src/routes/Settings/SettingsPage.tsx` | 1,355 | 39 | 12 |

InstancePage handles content lists and updates, console streaming, screenshots, export, game settings, Bedrock setup, and draggable tab menus. SettingsPage handles thirteen settings sections, provider credentials, Java management, navigation dragging, and several independent save flows. The conditional-hook defect is a concrete example of the maintenance risk.

Extract behavior by feature: instance console, content actions, export dialog, tab arrangement; Java, appearance, sync, and WebView settings panels. Keep existing common controls and translations. Line count alone is not a defect; the mixed responsibilities and interacting state are the concern.

### 4. P2 — Runtime import cycles couple otherwise separate modules

An AST-based traversal of static imports, re-exports, and literal dynamic imports found these cycles:

- `src/stores/appStore.ts` → `src/stores/packJobs.ts` → `appStore.ts`: the application store forwards progress to pack jobs; pack jobs refresh the application store after operations.
- `src/vendor/mine3d/core/skin-uv-inset.ts` → `skin-leg-stock.ts` → `skin-uv-inset.ts`: UV restoration imports leg restoration, while leg restoration imports `SKIN_TEXTURE_SIZE` from the UV module.

These are runtime imports, not merely type dependencies. No initialization failure was demonstrated. Move the texture constant into an independent constants module. Coordinate pack completion and bootstrap refresh through an explicit coordinator or callback rather than mutually importing stores.

### 5. P2 — Settings saves can overwrite changes made from the same stale snapshot

Evidence: `src/routes/Settings/SettingsPage.tsx:325` submits complete setting-category objects, many controls spread `bootstrap.settings.<category>`, and `crates/slh-core/src/settings.rs:40` eventually replaces the stored category through `database::set_setting`. There is no general field-patch or revision-conflict mechanism. `src/stores/appStore.ts:132` similarly captures an entire bootstrap snapshot for view-mode saving.

Inference from the code: two quick changes before refresh finishes can both submit the same old category, with the later write resetting the first changed field. This was not reproduced against the user's database. The existing `remember_section` implementation already updates one JSON field atomically; consider extending that approach to independent setting controls or serializing saves against the latest state.

### 6. P3 — Confirmed unused dependencies and declarations

- `package.json:42`: `zod` has no imports or usage in application source, tests, or launcher scripts inspected.
- `src/components/icons/index.tsx:133–134`: `BrushIcon` and `EarthIcon` appear only in their declarations.
- `src/vendor/mine3d/core/product-visuals.ts:604`: `createProductBackground` appears only in its declaration.
- `crates/slh-core/src/platform.rs:226`: `show_error` has no callers in the launcher sources or core examples inspected.
- `crates/slh-core/src/loaders/mod.rs:20`: `LoaderProvider` has no implementations or consumers and is annotated with `allow(dead_code)`.
- `crates/slh-core/src/accounts/mod.rs:25`: only `OfflineProvider.availability()` consumes the AccountProvider abstraction. Its provider_type, refresh, and logout methods have no callers through that abstraction; actual online provider operations use their concrete modules.
- `src/lib/home.ts:29`: `homeEmotes` is consumed only by a test, not by the production UI. Treat it as test support or connect it to the real selection model; do not assume it is safe to delete without adjusting the test's purpose.

Tree shaking can already exclude unused JavaScript exports. Removing these declarations primarily improves maintenance; it does not establish a measurable RAM reduction.

### 7. P3 — Registered commands without a current UI caller

The command registration list and frontend call sites were cross-checked, including literal commands carried through pack-install jobs:

| Command | Observation |
| --- | --- |
| `get_system_metrics` | No production frontend caller. HomeStatusPanel tests explicitly assert that it is not called. |
| `create_instance_desktop_shortcut` | Implemented and registered, but no frontend or diagnostic-script caller found. |
| `list_installed_content` | No frontend caller; `reconcile_installed_content` uses the same internal listing helper. Preserve the shared helper. |
| `run_sync` | No frontend caller for this wrapper; core `run_for_instance` is actively called before/after game execution. Preserve synchronization. |
| `get_window_activity` | No frontend caller, but used by native diagnostic and load scripts. Keep it as diagnostics. |

Decide whether the first four commands are intentionally retained API/feature surface or obsolete endpoints. Registered commands are callable APIs, so absence of a UI caller alone does not prove their implementations can be removed.

The metrics module also implements actively used folder-size calculation (`get_launcher_storage_usage`); deleting the entire module would break the home status panel.

### 8. P3 — Tauri host manifest retains dependencies moved into the core crate

These 18 direct dependencies in `src-tauri/Cargo.toml` have no references in host `.rs` sources or build.rs inspected: sysinfo, async-trait, chrono, futures-util, fastnbt, hex, md5, regex, sha1, sha2, shlex, tempfile, thiserror, tracing-appender, tracing-subscriber, url, uuid, zip.

Their core uses are separate and must remain. Remove candidate direct host declarations in a separate cleanup and verify Windows compilation and any supported cross-platform builds. Many remain transitive dependencies through slh-core, so removing manifest entries does not imply removing the libraries from the executable.

### 9. P3 — Transport, preview fixtures, and API contracts are intertwined

`src/lib/tauri.ts` contains 535 lines combining command transport, failure normalization, preview bootstrap data, and a long command-name dispatcher. `command<T>(name: string, args?: Record<string, unknown>)` leaves argument/result compatibility to callers. Preview still accepts `select_account_skin`, which is not a registered native command.

Separate preview support from production transport and introduce a command-to-arguments/result map. Keep preview tests, but add native boundary checks for flows that depend on Rust. Dynamic preview locale imports are emitted in the native frontend build as well; assess packaging intentionally before changing them.

### 10. P3 — Standalone core tests resolve a different dependency graph

The core crate is a path dependency, not a workspace member. Its own lock file differs from `src-tauri/Cargo.lock`: for example, aws-lc-sys is 0.45.0 versus 0.44.0, open is 5.4.4 versus 5.4.1, and futures-core is 0.3.34 versus 0.3.33. Both test commands use `--locked`, but they test different transitive dependency graphs. Also, `cargo test --manifest-path src-tauri/Cargo.toml` runs only host tests; it does not run the dependency crate's unit tests.

Consider a common Cargo workspace/lock file and an explicit CI command that runs both suites. Until then, keep reporting host and core checks separately. No failure caused by this version drift was demonstrated.

## Architecture that should be preserved

- `crates/slh-core` already separates domain work from the desktop host. One-line `pub use slh_core::...` modules in `src-tauri/src` are adapters, not duplicated implementations.
- An AST reachability scan covered 85 non-test TypeScript source files, including declaration files. The only unreachable implementation module was `src/vendor/mine3d/index.ts`, a public re-export facade. Its underlying engine modules are actively imported directly.
- `vendor/LeviLauncher` supplies the native Bedrock integration; its own frontend/reference sources are not automatically launcher dead code.
- Two skin viewers are actively used: Mine3D for the home character and skinview3d for account appearance. Both contribute sizeable lazy chunks, but neither is an unused dependency. Consolidation requires comparing their behavior and lifecycle handling.
- `crates/slh-core/src/minecraft/bedrock_runtime.rs` has 3,574 physical lines and mixes platform probing, account binding, installation, manifest generation, launch, profile preparation, and command execution. Split by those responsibilities gradually; retain compatibility paths and platform cfg branches. Large backend files also contain tests, so their raw size should not be equated with production complexity.

## Validation

- Dependencies restored with `npm ci --ignore-scripts --no-audit --no-fund` from the existing lock file.
- `npm run check:ui`: passed, 1,472 catalog values.
- `npm run build`: passed; warnings for two minified chunks over 500 kB (scene-loop and skinview3d).
- `npm test`: 31 files, 112 tests passed.
- `npm run test:e2e`: 8 passed, with the uncaught InstancePage React error described above.
- Separate Playwright reproduction: captured the same error when deleting the open instance. A subsequent missing-instance navigation timed out after the error; this is not counted as a separately isolated defect.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: passed, 13 host tests.
- `cargo test --manifest-path crates/slh-core/Cargo.toml --locked --target-dir src-tauri/target`: passed, 129 core tests; 2 explicitly ignored (live CurseForge fixture and host Java diagnostic). This target directory shares artifacts, not dependency resolution.

No application source, installed executable, accounts, settings, language dictionaries, or existing user changes were edited for this audit. Generated build/test outputs and node_modules were created in the project checkout. This audit is not an exhaustive proof that all unreachable code has been identified.

## Suggested order

1. Fix the conditional hook and make uncaught browser errors fail the deletion regression test.
2. Address stale settings writes and break the two runtime import cycles.
3. Remove confirmed unused declarations and redundant manifest entries with targeted compilation checks.
4. Resolve unused command intent, then extract page behavior and split the Bedrock runtime by responsibility.
