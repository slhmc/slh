# Home character modes

Appearance exposes the selector when Beautiful Home Menu is enabled:

| Value | Display | Rendering |
| --- | --- | --- |
| 2 | Existing animated character | Live WebGL; existing character FPS setting applies |
| 1 | Skin portrait in a fixed pose | One local PNG render on cache miss, then an ordinary image |
| 0 | Hidden character | Neither portrait nor character canvas is mounted |

Missing or invalid legacy values default to mode 2. The new optional
`appearance.homeCharacterMode` accepts only integer values 0–2; no migration or
automatic rewrite of existing preferences is needed.

The selector follows the UI's compact-menu setting: tiles use a vertical
2–1–0 control, rows use a horizontal 2–1–0 control. The FPS selector appears only
for live 3D. Changing modes preserves the saved live-view angle, scale and FPS.
The three-stop rail uses a round thumb, pointer dragging and keyboard arrows;
Home selects 2 and End selects 0. Text labels remain directly clickable.

Both visual modes share account skin loading, model detection, cached offline
fallbacks and avatar-update notifications. Portraits are rendered locally, with
no external avatar service. Classic/slim geometry, materials and skin overlays
use the existing renderer. The temporary renderer never starts its animation
loop and is disposed after PNG encoding, including on failure. Mode 1 has no
drag-to-rotate behavior.
The static pose follows Avatar Maker's Body4 upper-body angles, with a small
gap between the legs and a subtle shared lean following the torso. It uses a near-front camera
and softer neutral fill lighting. These lighting changes affect portraits only.

IndexedDB `slh-home-portrait-v1` stores just the last generated PNG and its skin
hash. Concurrent identical requests share one render; different renders are
serialized. The hash includes a portrait revision, so a pose or lighting update
automatically replaces an older cached PNG. A cached portrait can be displayed after restarting without
importing the 3D engine. Switching skins replaces the bounded cache. Object URLs
are revoked when the image changes or unmounts. First-time portrait generation
still requires WebGL briefly.

Checks cover image generation and cleanup, retry after failure, browser cache
reuse across reload, live-to-static cleanup, off mode, persistence, RU/EN/DE
labels, narrow/wide settings, both control orientations and Rust validation.
The isolated native harness supports `--compare-character-modes` to check the
same transitions and persisted cache under WebView2.
