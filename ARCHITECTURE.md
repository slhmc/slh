# Architecture

## Process boundary

React renders the application and owns transient presentation state. Rust owns the database, filesystem, downloads, hashing, archive extraction, account security, Java discovery, game installation, process launch, and synchronization. Communication uses typed Tauri commands and progress events.

This repository contains the Tauri/WebView2 launcher. The backend lives in `crates/slh-core`; `src-tauri` supplies the desktop host, commands, and operating-system integrations.

The native Bedrock helper in `vendor/LeviLauncher` and its build scripts belong to the launcher and are required for its Windows Bedrock integration.

## Backend modules

- `portable`: executable-relative storage layout and directory initialization
- `database`: SQLite pool, migrations, and persistence queries
- `accounts`: provider abstraction and provider-specific authentication
- `minecraft`: metadata, downloads, installation, Java selection, and launch
- `loaders`: Fabric, Forge, NeoForge, Quilt adapter boundary
- `content`: Modrinth and credential-gated CurseForge adapters
- `archives`: staged SLH, Modrinth, CurseForge, and existing-folder imports plus token-free exports
- `servers`: NBT-preserving `servers.dat` reads and backup-before-replace writes
- `storage`: instance file indexes, portable storage totals, and persisted download history
- `sync`: copy/hash snapshots, conflicts, and backups
- `security`: DPAPI token blobs, path validation, and secret redaction
- `commands`: the narrow Tauri API exposed to React

Provider modules return domain objects and never call frontend code. Long-running operations publish structured events with an operation ID, stage, completed count, total count, and optional byte progress.

## Persistence

SQLite is authoritative for launcher state. Instance game files live under `data/instances/<uuid>/game`, while reusable official Minecraft files live under `data/cache/minecraft`. Account token material is stored only as encrypted files under `data/accounts`.

Schema and entity migrations are forward-only. Stable UUIDs are used for instances, groups, accounts, mappings, downloads, launches, and backups. Installed provider content records project/version IDs, destination paths, and expected hashes so updates and conflicts can be planned before mutation.
