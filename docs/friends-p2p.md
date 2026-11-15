# Local friends and direct play

Historical record: this feature was completely removed again on 9 November 2026. See [removal](friends-removal-2026-11-09.md).

## Product contract, 9 November 2026

The first version serves Java LAN worlds and local Java servers, with SLH at both ends. There is no SLH backend, signaling server or relay. Public STUN assists ICE discovery only. The host must keep the launcher and Minecraft running. Direct ICE can fail with restrictive NAT or firewalls; the application must report this honestly.

Friends are stored in launcher data. A stable cryptographic launcher identity establishes trust; the selected Minecraft account supplies the displayed profile, not proof of identity. Contact codes are exchanged once and explicitly accepted after comparing fingerprints through a trusted channel. Account switches must not silently replace a trusted key.

The local profile follows the selected account. A saved remote contact is a snapshot: exchange its contact code again to update the displayed name/provider after that player changes accounts. The existing key remains trusted; there is no background profile directory. Identity secrets use the operating system credential protection and are not automatically portable to another OS user or computer; re-pair there. Copying the launcher executable alone never transfers friendship data.

For each connection the host selects a friend and a local target, sends an offer, and imports that friend's answer. Signed envelopes bind the peer, session, SDP and expiration. Pending codes expire after ten minutes. A guest receives a loopback Minecraft address after connecting. Stopping access or removing a friend closes that friend's active sessions. No persistent online presence is implied when the launchers have no connection.

## Interface contract

The new Friends page inherits the existing library header/list composition and account/settings dialogs. It uses shared Dialog, Button and status controls, Pixeloid Sans and semantic tokens. Contact exchange, opening access and joining are dialogs over the current page. Initial loading, empty state, copy failure, rejected code, pending answer, connecting, connected, failed and revoked states must remain distinct. Closing a dialog does not silently revoke access.

The interface must remain operable by keyboard at 800×560 and 1440×900. Long codes and fingerprints wrap or scroll inside their own fields; dialog footers stay accessible. New navigation is exposed for legacy preference lists without rewriting the stored preferences. Once navigation preferences include Friends, explicit hiding is respected. No new visual palette or font values are introduced.

## Minecraft authentication

Transport authentication and Minecraft session authentication are separate. Microsoft, Ely.by and offline profiles can all use the tunnel; the target Minecraft server still determines whether a profile may enter. The launcher does not silently disable authentication or alter an existing instance.

For mixed accounts on a local server, the owner can explicitly configure `online-mode` through the existing server settings and restart. A LAN world needs a version/loader-compatible host-side configuration mod, such as [LAN Server Properties](https://github.com/rikka0w0/LanServerProperties) / [LAN World Plug-n-Play](https://github.com/Satxm/mcwifipnp), when vanilla session checks reject the guest. Compatibility must be checked for the actual version. This is a prerequisite, not a promise that any vanilla version accepts all account combinations.

Turning off Minecraft session authentication can change player UUIDs and associated inventories and does not validate player names. The existing Minecraft LAN/server socket remains independently reachable according to its own bind address, firewall and access settings. SLH friend revocation closes the SLH tunnel; it does not change other network paths to the game.

The previous `Invalid session` error has no established cause without the corresponding logs. A mod could have contributed; it must not be diagnosed from that message alone.

## Validation

Verified on the implementation workspace:

- UI catalog audit: 2,194 values, matching parameters across EN/RU/DE/template; TypeScript and production frontend build passed.
- Vitest: 51 files, 188 tests passed, including legacy navigation visibility, missing saved navigation order and explicit hiding of Friends.
- Core library: 236 passed, 6 ignored (external-data scenarios). Four friends tests cover signed contact/SDP validation, identity persistence and protection, revocation and actual transport.
- Native shell: 11 tests passed; the new command wrappers compile in the native application.
- Actual WebRTC loopback: four concurrent 150,000-byte streams, TCP half-close, 40 subsequent connections and closure of an active stream/listener passed. The test disables STUN and uses real local ICE/DTLS/SCTP, not browser fixtures.
- Playwright: four scenarios passed at 800×560 and 1440×900, covering manual contact inspection/confirmation, long codes, persistent action errors, offer/answer, reopening codes, guest response, clipboard rejection, disconnect, Escape and legacy settings. Browser networking responses are fixtures and do not prove native NAT traversal.
- Visual inspection: contact/connection/guest screenshots at both sizes. Shared SLH typography, tokens and dialogs retained; no new font or palette. Primary buttons and focus are visible. Dialog footer bounds are asserted in Playwright.
- Geometry: page dumps at both sizes pass the numeric checker after declaring shell edge wrappers. A task-local dumper adaptation keeps baseline probes inside the original flex text item; the stock helper otherwise displaces Button text during measurement. Contact dialogs retain the shared header's four-pixel title/close-hit-area offset, which the generic checker reports as a row mismatch; the existing Dialog composition is deliberately unchanged. Body overflow is scrollable and the footer remains visible.
- Motion: the focused Friends-page probe has zero errors in ordinary and reduced-motion modes. Reduced motion uses a static pressed inset instead of scale. Inline help links retain a generic `transition: all` warning under the existing global reduced-motion reset; no animation is running there. The first broad probe landed on Library and is excluded from Friends evidence.

Cross-internet NAT traversal and real Microsoft/Ely.by/offline Minecraft joins have not been verified: they require independently connected computers and version-specific game/authentication testing. A successful transport test is not proof that a vanilla Minecraft LAN world accepts mixed accounts. Native release smoke and installed executable replacement are recorded below.

## Native release and installed executable

The final release passed `--check-build-mode` and `--check-webview-runtime` (both exit 0). It was launched through agent-desktop with `--isolated --data-dir` and separate child-process APPDATA/LOCALAPPDATA, using a synthetic offline account. The actual Friends page called the native backend and created one protected identity row in that fixture. The final native screenshots were inspected at logical 800×560 and 1440×900, captured at Windows scale 1.75. The legacy missing-navigation-order case and Russian strings were visible with copies of the old installed language files, confirming the embedded translation fallback.

UI Automation exposed WebView chrome rather than usable page controls. Native evidence therefore covers startup, page rendering, backend snapshot/identity and semantic window resizing; full click/keyboard flows are covered by Playwright fixtures and the core transport tests, not claimed as native end-to-end Minecraft play. Test captures are under `artifacts/ui/friends-native-ru-*.png`.

Only `E:\SLH\SLH.exe` was replaced after confirming that every SLH process had stopped. The tested fixture, release output and installed executable have SHA-256 `0D71D62DA0B7CB3E1DC54A0813DF808C300490A8BC567145504F8D3D75707760`.

Previous executable backup: `E:\SLH\launcher-backups\SLH-before-local-friends-20261109-ad37e30e.exe`; SHA-256 `643464E8C3238F08FEE841D33EEAD253E871E40727C50308653494F57F79DFB0`, matching the pre-update file. All five installed language files retained their hashes. User accounts, instances and settings were not edited. The installed launcher was left closed.
