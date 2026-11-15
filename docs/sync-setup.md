# Sync setup

The settings section separates existing mappings, explicit creation and additional settings. The library header/list and existing settings disclosure are the nearest working analogues. Create sync reveals an inline fieldset with three numbered steps. Cancel hides it while retaining draft values. Successful creation returns to the list; failure keeps the draft. During saving the fieldset and opener are disabled.

Content labels distinguish Minecraft settings and the server list. The initial-copy field explains replacement/backups and that shared storage may be empty. The selected build is reset when it is excluded from scope. Worlds show their risk only when selected, and cannot be created until the existing gate is enabled. Existing world confirmation, backups, stop checks and automatic synchronization remain in the core. No user mapping is modified by opening the page.

Existing mappings show localized category, scope, last-sync time, a labelled manual-update source, enable switch and delete action. Additional Rust/world controls are below the list. No new backend commands or file-copy behavior are introduced.

Validation: check:ui, frontend build, 186 Vitest tests, 11 launcher Rust library tests, 232 core tests passed (6 existing external tests ignored). Playwright sync-setup.pw.ts passes at 800x560 and 1440x900: empty entry, keyboard focus, world gate, no-build validation, create payload, successful list refresh, disabled update and deletion. Browser creation uses a command fixture; native filesystem synchronization was not rerun. Screenshots sync-form/list-{800,1440}.png were visually compared to the settings/library surfaces. Widths wrap in the narrow viewport and actions remain reachable by scrolling.

Motion probe: Create sync has press/hover/focus feedback with zero errors or warnings in normal and reduced motion. The form reveal uses shared SLH timing; no idle animation is introduced.

Native release build and --check-build-mode passed. Installed E:/SLH/SLH.exe replaced after verifying no installed SLH process remained. Backup: E:/SLH/SLH.exe.backup-20261109-195436. Installed/built SHA-256: 25F0C1E1B3727553E34F50B953ECD3CCBFE6973B40CE51C409295B383ECE07B6. Only the executable was replaced; user data, mappings and installed language files were not changed.


## Source selection and alignment follow-up

The first-copy choice and the manual publish dropdown were independent: the latter silently defaulted to the first build. Creation now uses the returned mapping id to seed its manual selection from the chosen initial build. Shared-folder creation or an existing mapping with no explicit manual selection leaves the dropdown blank and Update now disabled; run_sync_mapping_now has no first-build fallback. The label explicitly says Manual update source. This is an in-memory action choice, not a permanent single-source policy for bidirectional sync. Existing mappings/files are not rewritten.

Mapping metadata occupies its own row, with select, update, switch and delete aligned on the control row. The narrow layout puts the labelled source above the actions. Form steps use consistent group padding; the empty-state creation hint is hidden while the creation form is open.

Regression at 800x560 and 1440x900 uses builds named 26.2 and 26.3, verifies initialSource=26.3, selected manual source=26.3 and actual manual-update payload=26.3, plus a restored mapping's empty manual source. Wide control baselines are measured with a 1px tolerance. Vitest (186), launcher Rust (11), core Rust (232 passed/6 ignored) and UI/build checks pass. Screenshots sync-list/form-{800,1440}.png were visually inspected again.

Follow-up installed build: release and --check-build-mode passed. Backup E:/SLH/SLH.exe.backup-20261109-200518; installed/built SHA-256 97AFD649767068A756ED15947EA6DF28DC0609A7198D56D585A91B463DBA26A1. Only the stopped launcher's executable was replaced. Existing mappings and all user data/language files were retained. The three form-step keylines are also measured with 1px tolerance by Playwright.
