# Home character settings

The appearance page groups mode, FPS and cursor following in one ordinary SettingRow tile, matching the user's compact reference and the adjacent scale/home controls. The previous full-width layout was replaced by normal tile width. The short description and Off label have separate localized keys; the new FPS caption is localized too. Existing long text keys remain unchanged. No divider or extra panel is added.

FPS comes before cursor follow. The compact FPS layout uses a flexible track plus the current value, retaining both 30/60 buttons, exact keyboard values, unlimited and the existing persistence handlers. Image and Off disable both 3D controls; returning to 3D restores preferences. Turning Beautiful Home off hides the whole section.

Verification: npm run check:ui, npm run build, npm test (188 passed), launcher Rust library (11 passed), core library (236 passed, 6 existing live/integration tests ignored). Playwright settings-refinements.pw.ts (3 passed) verifies both layouts at 800x560 and 1440x900, ordinary tile width against its neighbor, FPS-before-cursor ordering, all modes, disabled controls, preservation, keyboard activation, Russian labels and unlimited overflow. home-character-modes.pw.ts (3 passed) verifies live 3D/image/Off transitions and WebGL release, Space/Tab/Enter, and Russian/German/English labels at device scale 1.75.

Visual comparison: the tile follows the supplied screenshot's composition, with SLH's existing pixel font and spacing. It adapts to one column at narrow widths. The existing 30 FPS magnet is intentionally retained rather than changing it to the reference's 20. Screenshots: test-results/character-{800,1440}-ru-tile.png, character-{800,1440}-{tiles,rows}.png. Actual WebView pointer input was not tested.

Motion probe for mode buttons: normal motion 0 errors, 1 timing warning for the shared Image button release; reduced motion 0 errors/warnings. The warning asks for a longer spring release; the existing SLH shared timing is deliberately retained. Focus, press and hover feedback work in both modes.

Installed update: final native release build passed and --check-build-mode returned 0. E:/SLH/SLH.exe was replaced after verifying no installed launcher process remained. Backup: E:/SLH/SLH.exe.backup-20261109-173248. Built and installed SHA-256 match: 5E78B1C3E86B820ADB213E02D2E730A945367D88FEA14E77FCA6BC096B73EAD5. Installed data and language files were not replaced.


## FPS readout stability

The compact output column previously used max-content, so switching between a numeric FPS suffix and infinity resized the track beneath the pointer. The compact grid now reserves 3ch for the readout. Visible output is only a number or infinity; FPS remains at the left, while aria-valuetext retains units and the localized unlimited name. tests/e2e/character-fps-layout.pw.ts verifies 60/infinity keyboard transitions and held-pointer infinity stability with identical track rectangles in both row/tile layouts at 800x560 and 1440x900. Screenshots fps-{800,1440}-{tiles,rows}.png were reviewed. No new strings or motion.
