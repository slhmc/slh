# Bedrock deployment and content

SLH uses Windows package registration for Bedrock. Separate SLH instance folders
do not provide separate Windows registrations or separate official game data.

Isolation is technically possible through a dedicated native launch path. The
vendored LeviLauncher tree contains folder-redirection hooks in
`native/levilauncher/src/hook/folder_redirect.cpp` and a native launch integration
in `internal/versionlaunch/launcher.go`. SLH currently uses its native helper for
installation/account operations, not that launch path. Those sources are not proof
of compatibility with every Minecraft version or with Store-owned installations.
Enabling the setting alone cannot activate that mechanism in SLH.

## Supported behavior

- Existing Store release and Preview packages can be attached to SLH profiles.
- Preview installation remains owned by Store/Xbox; SLH does not download Preview.
- A different registered version in the same package family blocks installation
  before downloading. SLH never removes an existing Minecraft package to resolve
  a deployment conflict. The UWP deployment path checks again before installation.
- Before activation, SLH checks the current package family, AUMID and version.
  Updating or replacing the package in Windows invalidates an older profile's launch.
- Official package isolation is unavailable. New profiles use shared data; existing
  isolation settings are preserved, but must explicitly be changed to shared before
  installation, launch or import. Protected data no longer silently falls back to a
  shared profile when isolation was requested.
- Explicit downloaded UWP/GDK runtime metadata determines the data root. Store
  metadata from older SLH builds can label a modern GDK game as UWP because the
  package kept its original name; those profiles use the GDK version boundary.
  An unrelated existing GDK directory does not redirect an older UWP profile.
- The embedded CurseForge catalog starts with the profile's game-version tag,
  removing the Windows package revision. Version discovery never resets that filter
  to all versions. An empty filtered result stays empty; all versions is explicit.
- Catalog installation uses the selected instance's import command, not Windows file
  associations. `.mcaddon` imports both resource and behavior packs, including nested
  `.mcpack` archives. UUID collisions and newer `min_engine_version` requirements
  reject the import before packs are moved. Original archives remain intact.
- `.mcworld` imports require `level.dat` and a `db` directory and allocate a new world
  folder without overwriting existing worlds. GDK imports require a unique player
  folder; an ambiguous/missing player folder requires import in Minecraft instead.
  Packs still need activation in the world's settings in Minecraft.

## Interface and validation

The catalog remains an embedded page, following the Java content catalog and the
existing Bedrock catalog's shared buttons, fields, palette and spacing. Profile-mode
selectors are absent from both global Bedrock settings and instance settings. A
shared-data notice remains in the instance runtime panel. An existing profile with
saved `isolated` mode gets a one-time "Use shared data" action. That action omits
version/loader changes and preserves its current version even if the catalogue has
selected a different default in the version editor. No saved profile is converted
automatically. New profiles explicitly request shared mode.
No new palette, surface type or layout tokens were introduced.

Automated regression coverage:

- Rust: missing/replaced package identities, official-isolation rejection,
  incompatible and paired addon imports, duplicate and unsafe archives, world imports.
- Vitest: provider version tags, Store version matching and localized import errors.
- Playwright: 800×560 and 1440×900, profile version absent from discovered provider
  tags, category navigation, scoped import arguments, incompatible import errors,
  keyboard navigation and horizontal overflow. The removal of mode selectors and
  explicit legacy-profile recovery are checked at both sizes. Screenshots:
  `artifacts/ui/bedrock-catalog-*.png`, `bedrock-profile-*.png`, and
  `bedrock-global-settings-*.png`.

Live historical deployment, data migration, Script API compatibility and in-game
pack activation are not certified by these tests. Script module/dependency solving
is not implemented. Parallel official versions with isolated worlds require a
different runtime architecture; they are not advertised as supported by this fix.
No installed games or user worlds are modified by the regression tests.

The native helper source is unchanged. Go is unavailable in this environment, so
the launcher build uses the existing x64 helper binary in `src-tauri/binaries`.

## Verification on 2026-11-09

`check:ui`, frontend production build, Vitest, the full core test suite (236 passed,
6 ignored) and Tauri library tests (11 passed) succeeded. After the last data-root
adjustment, all 31 Bedrock-related Rust tests passed. Targeted frontend regression
tests passed (7), as did both Playwright viewport scenarios, including settings
keyboard checks. The release executable passed build-mode and WebView2 probes and
rendered first-run onboarding with a separate `--data-dir`, observed through
agent-desktop snapshot/screenshot. No account was created during that smoke check.

Only `E:\SLH\SLH.exe` was replaced. The previous executable was preserved at
`E:\SLH\SLH.exe.before-bedrock-20261109-214341.bak`. SHA-256 checks confirmed that
the 16 protected database/account/language files inventoried before replacement
were unchanged. Installed and bundled native helpers had identical SHA-256 hashes.

The subsequent profile-selector removal passed `check:ui`, the frontend build,
191 Vitest tests, 237 core Rust tests (6 ignored) and both Playwright viewport
scenarios. Legacy-profile recovery is exercised with keyboard activation and
asserts that the stored Minecraft version is unchanged. The previously saved
default-profile setting and existing profile files are not migrated automatically.
