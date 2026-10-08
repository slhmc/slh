# Building SLH

## Requirements

- Node.js 24 and npm.
- Rust 1.97.1 (rustup reads rust-toolchain.toml).
- Windows: Visual Studio C++ build tools and WebView2 Evergreen.
- Windows Bedrock helper: Go version specified in vendor/LeviLauncher/go.mod.
- Linux: WebKitGTK 4.1, GTK/AppIndicator, librsvg, DBus, OpenSSL and build tools. The GitHub workflow lists Ubuntu packages.
- macOS: Xcode command line tools; build Intel and Apple Silicon targets separately.

```sh
git clone --recurse-submodules https://github.com/slhmc/slh.git
cd slh
npm ci
npm run tauri:dev
```

On Windows, first run `npm run build:bedrock-native`. A public Microsoft client ID is included in resources/microsoft-client-id.txt. Forks should register their own application and override SLH_MICROSOFT_CLIENT_ID at build or run time. This identifier is not a client secret. Never include OAuth tokens or personal launcher data in a release.

## Packages

```sh
npx tauri build --target x86_64-pc-windows-msvc -- --locked
node scripts/package-release.mjs x86_64-pc-windows-msvc
```

Run this on the matching platform, using x86_64-unknown-linux-gnu, x86_64-apple-darwin or aarch64-apple-darwin for other targets. Packages are placed in artifacts/packages. Windows includes NSIS EXE, MSI and portable ZIP. Linux includes AppImage, DEB and RPM. macOS includes DMG and a ZIP containing the app bundle.

Windows portable packages include portable.flag and keep data beside the executable. Fresh Windows installers include a separate installer marker and use per-user application data; existing legacy data beside the executable is preserved. Linux/macOS use platform user-data directories by default. The macOS app ZIP is a movable app bundle; it does not bundle player data or Java.

GitHub Actions builds on Windows, Linux and both Mac architectures, tests the code and assembles a draft v0.2.0 release with SHA-256 sums after all builds succeed. Packages are unsigned; macOS bundles have ad-hoc signatures and are not notarized.

## Verification

```sh
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib
cargo test --manifest-path crates/slh-core/Cargo.toml --locked --lib
```

Automated tests do not replace signing in, installing Minecraft and testing the resulting installers on clean operating systems.
