# Third-party visual assets

## Pixeloid Sans

- Author: GGBotNet
- Source: https://ggbot.itch.io/pixeloid-font
- License: SIL Open Font License 1.1
- Bundled files: `src/assets/fonts/PixeloidSans.ttf`, `src/assets/fonts/PixeloidSans-Bold.ttf`
- Full license: `src/assets/fonts/OFL.txt`

## Pixelarticons

- Author: Gerrit Halfmann
- Source: https://pixelarticons.com/
- Package: `pixelarticons` 2.2.0
- License: MIT

Both assets are bundled locally so the portable launcher UI does not need a font or icon CDN.

## authlib-injector

- Author: yushijinhun and contributors
- Source: https://github.com/yushijinhun/authlib-injector
- Runtime version: 1.2.8
- License: GNU General Public License v3.0
- Distribution: downloaded from the official GitHub release on the first Ely.by launch and accepted only after SHA-256 verification; it is not embedded in `SLH.exe`

## Bedrock version metadata

- Sources: [mc-w10-versiondb-auto-update](https://github.com/ddf8196/mc-w10-versiondb-auto-update) and [minecraft-windows-gdk-version-db](https://github.com/LukasPAH/minecraft-windows-gdk-version-db)
- Use: runtime version metadata and Microsoft package delivery URLs only; Bedrock binaries are not bundled with SLH
- Requirement: the user must own Minecraft for Windows through a Microsoft account; Ely.by and offline Java accounts are not Bedrock authentication

## Bedrock native installer

- Source: [LeviLauncher](https://github.com/LiteLDev/LeviLauncher)
- Pinned source commit: \`69bde2efecc6af4479079242ebcaae7bd51c563d\`
- Vendored at: \`vendor/LeviLauncher\`
- License: GNU GPL v3.0-only
- Scope: the Windows x64 native MSIXVC extractor and its Store/Xbox licensing flow
- Additional notices: \`vendor/LeviLauncher/THIRD_PARTY_NOTICES\`
- The native installer also contains GPL-3.0-derived Xodus implementation work; the upstream notice and license files remain in the pinned submodule.


## Mine3D Embedded (beautiful home character)

- Copyright (c) 2026 Undefined Studio; MIT license.
- Source: https://github.com/millida/launcher/tree/79c5ec2c9b76c3370d20407651e31a6774b2712d/src/vendor/mine3d
- Local source and full license: `src/vendor/mine3d/`. Adaptations documented in `UPSTREAM.md`.
- Uses three.js 0.182.0, skin3d 0.1.3, skinview-utils 0.7.1 (MIT).
- No Millida service, remote cosmetics, branded art, or automatic emote scheduler is included.

## sysinfo 0.39.6

System CPU, memory, network and disk statistics use sysinfo (MIT).
Source: https://github.com/GuillaumeGomez/sysinfo
Copyright (c) 2015 Guillaume Gomez.
License: resources/licenses/sysinfo-MIT.txt.
GPU sampling uses the Windows PDH API.

## Native prototype

The separate native prototype uses Slint 1.18.1 and wgpu 30.0.1. Slint offers GPL-3.0-only, Slint Royalty-free 2.0, and commercial licensing alternatives; see https://slint.dev/license. Desktop distribution must follow the selected Slint license. The prototype does not change the licensing of the existing Tauri frontend.

wgpu, glam, bytemuck, directories, tar, flate2, and keyring are covered by their upstream permissive licenses. Exact dependencies and versions are recorded in `crates/slh-native/Cargo.lock` and `crates/slh-core/Cargo.lock`. Pixeloid Sans retains its existing SIL OFL attribution above.
