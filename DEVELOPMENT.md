# Development

## Commands

Install dependencies with `npm ci` before the commands below. Generated dependencies, build outputs, local backups, screenshots, and release packages are excluded from Git. Keep personal profiles and development archives outside the source repository.

```powershell
npm install
npm run dev
npm run tauri:dev
npm run build
npm run test
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
npm run portable
```

Optional runtime configuration in the shell that starts SLH:

```powershell
$env:SLH_CURSEFORGE_API_KEY = "your-approved-personal-key"
$env:SLH_MICROSOFT_CLIENT_ID = "your-public-desktop-client-id"
```

Do not commit populated environment files. Personal CurseForge keys are sent only in direct official API request headers and are not written to SQLite or logs. Relay requests never include `x-api-key` from the launcher.

## Conventions

- Frontend TypeScript is strict and backend DTOs use `camelCase` serialization.
- Filesystem paths never cross the command boundary as trusted input; Rust resolves and validates them.
- Downloaded files use temporary siblings, checksum verification where metadata supplies a hash, and atomic rename.
- Commands never build shell strings. Java and helper processes receive structured argument arrays.
- UI controls show unavailable or failed states honestly and never simulate successful backend work.
- Tokens and passwords are forbidden in logs, exports, screenshots, tests, and committed fixtures.
- Provider integrations must be checked against current official documentation before release and must preserve permission/distribution gates.
