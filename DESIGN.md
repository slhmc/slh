# SLH interface

The interface follows [docs/UI_STYLE_GUIDE.md](docs/UI_STYLE_GUIDE.md), the authoritative existing SLH system. Graphite surfaces, configurable accent, Pixeloid Sans (400/700), compact controls. Use existing CSS tokens in `src/styles/tokens.css` and shared controls; no new visual values are introduced for Horizon.

Settings reuse `SettingsSection`, `SettingRow`, `Toggle`, `tileGrid` and shared secondary buttons. Installation reuses the loader grid, selected state and disabled state. Spacing uses `--space-*`, radii `--radius-*`, control height `--control-height`, text `--text-*`; inherit press feedback, focus and reduced motion from shared styles.

Horizon is an opt-in experimental runtime. Its card is shown only after enabling it, and lists releases filtered by the selected Minecraft version. Each instance pins its Horizon release; changing it requires an explicit action while stopped. The description states Microsoft account and Java-mod limitations. FAQ opens the upstream repository. Disabling hides new creation and blocks installation/launch without deleting instances.

Advanced settings label the Rust runtime with the shared warning badge “Beta”. Deletion hides the instance immediately while the activity bar reports actual removed filesystem entries as a percentage; enumeration is indeterminate, failure restores the card. No completion is reported before filesystem cleanup and the database deletion finish.

Content tabs accept native file drops and provide a Choose files button. Hovering a file over Mods, Resource packs or Shaders opens that tab; release copies to its corresponding folder. The content area and destination tab use an inset dashed accent outline with an explicit release label. Reuse `--space-3`, `--space-4`, `--text-body` and shared buttons. Originals and existing destination files remain intact. Validate desktop layouts at 900×700 and 1440×900, including native coordinate scaling and error recovery.
