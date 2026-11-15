# Instance artwork editor — 8 November 2026

The editor uses the existing `Dialog`, `Button`, color inputs and `InstanceArtwork` renderer. The working analogues are the existing artwork editor and account appearance dialog; the identity panel follows the user's compact color/preset/editor reference. Palette, font, radii, spacing and press feedback remain from SLH's design system.

## Behavior

- Undo, redo, Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y include images, icons, geometry and colors. Dragging/resizing/rotating is one history step. History is bounded at 100 snapshots and shares image strings rather than copying base64 on every movement.
- Moving snaps independently to horizontal/vertical center within 2 percentage points; center guides use the focus token. Resize markers sit outside the artwork clipping region; a 24px workspace gutter reserves room for them. Select by pressing the content, deselect by pressing empty canvas or outside it. Rotation hit areas lie just outside each corner. Numeric fields and independent resets remain available.
- Ctrl+wheel scales both dimensions, with a non-passive wheel listener preventing browser zoom. Resizing is proportional unless Shift is held; rotated resizing uses the object's local axes.
- New artwork shares its square/rectangle transform by default. Explicit separate transforms in saved artwork remain respected. Loaded photos retain their natural aspect ratio; reset size also restores that ratio.
- Rectangles now use 1.6:1 in the editor, library cards and side panel. This intentionally replaces fixed rectangle heights, removing the preview/output aspect mismatch. Square surfaces retain their existing size.
- Both output formats are previewed. The icon catalogue stays open after selection and appends results near the scroll end. The photo control has a themed button/drop zone with drag feedback and the selected filename below it; the native file input is hidden.
- Apply waits for `update_instance`, refreshes the library and closes only after success. It submits the current persisted name and memory with the new artwork, preserving separate pending name/runtime drafts. Save failure leaves the editor open. Closing with unsaved changes uses a separate shared Dialog only if `confirmDestructiveActions` is enabled.
- Identity settings group color rows on the left, eight icon choices, and the editor button on the right. Narrow settings layouts wrap. At 800px the editor keeps canvas and controls side by side; below 700px it uses one scrollable column. Short windows show compact shape buttons with accessible names and tooltips; both formats remain previewed below the canvas. The shared footer stays available.

## Validation

- `npm run check:ui` and `npm run build` passed.
- `npm test`: 185 passed across 51 files.
- Rust shell tests: 11 passed. Core: 232 unit tests plus 1 integration test passed; 6 existing live-provider tests ignored.
- `tests/e2e/artwork-editor.pw.ts`: five scenarios passed. Main flows at 800×560 and 1440×900 cover shared/separate transforms, undo/redo shortcuts, photo upload, image/selection bounds, Ctrl+wheel, center snapping, rotation, proportional drag resize, one-step gesture undo, handles outside the canvas, deselection/reselection, catalogue persistence and infinite scrolling, immediate save/reopen, and confirmation enabled/disabled.
- Keyboard commands also work with footer focus. Layout checked at effective CSS viewports for 75%, 100% and 150% scale; this simulates browser zoom layout rather than changing the OS/WebView zoom. Reduced-motion computed transform and browser page errors checked.
- Five existing instance header/action regression scenarios passed, including Russian text and both window sizes.
- Visual evidence: `artifacts/ui/artwork-new-{800,1440}.png` and `artifacts/ui/artwork-settings-new-{800,1440}.png`. Compared against the existing SLH controls and the user's composition reference. No added decorative copy/cards; the icon tile grid is an explicit requested picker, not a decorative navigation grid (`slop:icon-tile`).

Native drag/drop, native file-picker dismissal and physical keyboard/mouse gestures in WebView have not been exercised in this run. Browser tests use preview instance data. The release executable is built with Tauri and checked with `--check-build-mode` before deployment. Installed accounts, instances, configuration and language files are excluded from replacement.


## Installed executable

`npx tauri build --no-bundle` succeeded. Both `--check-build-mode` and `--check-webview-runtime` exited with code 0. No SLH process was running before replacement.

Only `E:\SLH\SLH.exe` was replaced. Previous executable: `E:\SLH\SLH.exe.backup-20261108-artwork-undo-layout`. Source and installed SHA-256 match: `180FC590EBBF1055055BD73B6FC1DA8D6F94427B424B3F06EB68B4079137436D`. Backup SHA-256 matches the previous installed binary. Installed data and language files were not copied or modified by deployment.
