# SLH 0.2.2 compatibility audit

Date: 2026-10-30. Scope: Discover provider adapters, client pack imports,
dependency resolution, Rust core and the Windows release executable.
The audit was performed on the existing uncommitted working tree.

## Fixed

| Area | Trigger and previous behavior | Change |
| --- | --- | --- |
| Modrinth file selection | No eligible primary file; fallback could install the first file even when it was a sources/dev/javadoc JAR or signature. | Both primary and fallback selection use the filtered runtime files. An auxiliary-only version fails before downloading. |
| Modrinth project identity | Install a selected pack version using the project's slug; its canonical project ID was compared with the slug and rejected as a different project. | Compare against the ID returned by project metadata; use that ID for automatic version lookup too. |
| Modrinth dependencies | Two newly resolved projects declared each other incompatible, but neither was installed yet. Version-specific conflicts also blocked every release of the project. | Check both installed content and the planned graph; retain an exact version constraint when one is declared. |
| CurseForge loader metadata | Tags such as `Fabric` and `NeoForge` reached consumers that expect lowercase loader IDs; unrelated environment tags also appeared as loaders. | Emit only canonical `fabric`, `forge`, `neoforge`, and `quilt` IDs. |
| CurseForge client packs | Server archives could appear in the client version picker or automatic selection; explicit file installation did not reject them. | Read `isServerPack` and reject server files in all three paths. Missing flags remain compatible with older cached/relay responses. |

Version metadata is synchronized across npm, Tauri, both Rust packages and
their lockfiles, the preview adapter and the server-provider User-Agent.
Historical release documents retain their original version numbers.

## Compatibility boundaries

- Java modpacks still require the loader and Minecraft versions declared by
  their archive. Horizon (`rust`) is a separate native runtime; Java loader
  mods are rejected for Horizon instances.
- CurseForge distribution restrictions remain enforced. A required file
  without an authorized download still needs the existing manual import flow
  and exact hash verification.
- CurseForge project details expose up to 50 files from the API's first page.
  Older releases beyond this window remain a known limitation of the picker.
- Browser tests use the preview adapter. They validate UI flows, not real
  provider downloads or a Minecraft game launch. Ignored live pack/legacy-Java
  tests require external caches and Java installations and are not proof of
  compatibility with every published pack.

## API references

- [Modrinth version file schema](https://docs.modrinth.com/api/operations/getversions/)
- [CurseForge file schema and loader filters](https://docs.curseforge.com/rest-api/)

## Snapshot startup investigation

The existing `26.4-snapshot-6/game/logs/latest.log` records
`312 Datafixer optimizations took 64582 milliseconds` before window creation.
The local 26.3 Fabric log records 525 milliseconds for its own Datafixer pass;
these are different builds and configurations, not a controlled benchmark.
The snapshot metadata requests Java 25, and the selected Oracle JDK 25.0.2 x64
matches. Read-only `jcmd VM.flags` inspection found G1GC, a 512 MiB initial
heap and 6 GiB maximum heap, with no interpreter-only mode.

This snapshot launch overlapped the audit's Rust compilation and test runs.
CPU contention may have contributed, so the log alone does not establish a
snapshot regression. Launch preparation does not reinstall installed Java
profiles or re-download their assets. Added structured timing logs for sync,
credentials, runtime/arguments and total preparation distinguish launcher
preparation from time spent inside the spawned game. No JVM settings, worlds
or installed pack files were changed during the investigation.

An isolated JVM probe then called the same `DataFixers.optimize` entry point
with `DataFixTypes.TYPES_FOR_LEVEL_LIST`, using the installed client JARs and
libraries, JDK 25.0.2, `-Xms512M -Xmx6144M`, and a separate working directory.
It did not launch a game window or open worlds. After compilation finished:

| Version | Minecraft's Datafixer timer | Entire probe process |
| --- | --- | --- |
| 26.4-snapshot-6 | 560 ms | 3.281 s |
| 26.3 | 559 ms | 3.562 s |

The minute-long Datafixer delay was not reproduced. System contention is a
plausible contributor to that recorded launch, not a proven explanation for
every slow startup. A full game startup also includes rendering, resources
and potentially network/authentication work. Probe sources, raw output and
results are under `logs/audit-022-dfu/`; earlier probes during compilation
are retained separately. No speculative JVM tuning was applied.

## Validation

Validation logs are written under `logs/audit-022-*` in the project workspace.
Results:

- UI catalog/style audit: passed (1,885 catalog values).
- TypeScript/Vite production build: passed; existing >500 kB chunk warnings remain.
- Vitest: 45 files, 166 tests passed with one worker and a 20-second test
  timeout. Earlier runs under concurrent compilation hit the default
  5-second timeout in UI tests; no assertion failures remained in the final run.
- Rust core, including bin/doc targets: 209 passed, 5 explicitly ignored live
  environment tests; no failures.
- Tauri adapter library tests: 11 passed.
- Playwright (`curseforge`, `pack-diagnostics`, `release-021`): 10 passed.
- Version consistency check: npm/Tauri/Rust manifests and launcher entries in
  both Cargo lockfiles all report 0.2.2.

The standard native build requires Go 1.25.3 or newer to rebuild the Bedrock
helper. Go was unavailable in this environment; the release build uses the
existing helper, with no Bedrock source changes.

The final Windows executable passed `--check-build-mode` and
`--check-webview-runtime` (both exit 0). It was installed at `E:\SLH\SLH.exe`
with its previous executable and build metadata backed up under
`E:\SLH\launcher-backups\before-0.2.2-*`. Only the executable and
`BUILD-INFO.json` were replaced. The installed/source SHA-256 values match;
database, account files, language files and the retained Bedrock helper were
fingerprinted before/after the replacement. The exact backup path, hash and
protected-file count are in `logs/audit-022-installed.json`.
