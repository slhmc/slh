# SLH interface

Актуальные решения UX-аудита, серверных настроек, поиска и системного оформления: [внешний вид и поведение](INTERACTION_CONTRACT.md). При расхождении с историческими описаниями ниже используйте это уточнение.

The interface follows [UI_STYLE_GUIDE.md](UI_STYLE_GUIDE.md), the authoritative existing SLH system. Graphite surfaces, configurable accent, Pixeloid Sans (400/700), compact controls. Use existing CSS tokens in `src/styles/tokens.css` and shared controls; no new visual values are introduced for Horizon.

Settings reuse `SettingsSection`, `SettingRow`, `Toggle`, `tileGrid` and shared secondary buttons. Installation reuses the loader grid, selected state and disabled state. Spacing uses `--space-*`, radii `--radius-*`, control height `--control-height`, text `--text-*`; inherit press feedback, focus and reduced motion from shared styles.

Horizon is an opt-in experimental runtime. Its card is shown only after enabling it, and lists releases filtered by the selected Minecraft version. Each instance pins its Horizon release; changing it requires an explicit action while stopped. The description states Microsoft account and Java-mod limitations. FAQ opens the upstream repository. Disabling hides new creation and blocks installation/launch without deleting instances.

Advanced settings label the Rust runtime with the shared warning badge “Beta”. Deletion hides the instance immediately while the activity bar reports actual removed filesystem entries as a percentage; enumeration is indeterminate, failure restores the card. No completion is reported before filesystem cleanup and the database deletion finish.

Content tabs accept native file drops and provide a Choose files button. Hovering a file over Mods, Resource packs or Shaders opens that tab; release copies to its corresponding folder. The content area and destination tab use an inset dashed accent outline with an explicit release label. Reuse `--space-3`, `--space-4`, `--text-body` and shared buttons. Originals and existing destination files remain intact. Validate desktop layouts at 900×700 and 1440×900, including native coordinate scaling and error recovery.

The complete launcher-specific reference is [LAUNCHER_STYLE_REFERENCE.md](LAUNCHER_STYLE_REFERENCE.md); current implementation and validation notes are in [UI_CONSISTENCY_AUDIT.md](UI_CONSISTENCY_AUDIT.md). In grouped server icons, status is a compact overlay with a text description and tooltip; the selected server panel retains the full status. Shared button press motion is omitted when reduced motion is requested.

Server settings expose a Players and access section through section shortcuts. Player rows use 32px pixelated heads, shared surface/radius tokens and a fallback icon. Add forms stay collapsed until requested; whitelist membership remains editable while enforcement is off. Short server setting tiles use `SettingGrid fitContent` to avoid empty fixed-height space; compact mode retains the shared rows.


Local server settings use a section sidebar and SettingRow/SettingGrid. Players and access separates its four lists with tabs. Players and access opens first; navigation stays enabled in every process state. Fields requiring stopped-process file writes are disabled; JVM memory preferences can be saved independently for the next launch. Running access changes go through Minecraft commands and wait for persisted confirmation. Layout controls belong to launcher Settings only; server tabs and panels follow the common instance placement settings. Main navigation no longer supports Ctrl-drag docking. No new visual tokens. See `../docs/local-server-settings.md` for validation.


### Обновление 1 ноября: работающий сервер и память

Подраздел «Управление миром» добавляет runtime-настройки через команды Minecraft: сложность, режим по умолчанию, idle timeout, время, погоду, границу, сохранение и gamerules с учётом версии. Отображать реальный вывод сервера; отправку команды не называть подтверждённым изменением. Списки доступа ориентируются на свежий runtimeState из ядра. При запуске формы доступны, применение ждёт готовности host; при остановке и потере управления команды недоступны. Это заменяет прежний запрет редактирования в состоянии starting.

Java-память редактируется вручную двумя числовыми полями от 128 МиБ, включая при работающем сервере. Отдельное сохранение меняет только параметры следующего запуска в профиле, не текущую JVM и не файлы сервера. В обзоре использовать ключ `serverLive.memoryOverview` («Память ОЗУ (МиБ)»). Horizon не имеет JVM-лимитов; показывать автоматическое управление. Использовать существующие SettingRow/Grid, Dialog, Button, tokens и ряд/плитки. Границы и фактические результаты: `docs/local-server-settings.md`.

### Approved UX audit and platform appearance, 1 November 2026

See ../docs/ux-audit-implementation.md for decisions and coverage. Reuse the shared confirmation Dialog; destructive confirmations default on and can be disabled in Advanced. No new backup/trash feature. Real errors, licensing and world-sync safeguards are independent.

Rare translation/manual Java/appearance controls use themed disclosures. The library has a short heading. Small creation windows put version selection before identity and keep a version/loader summary in the footer. Default quick actions use More; explicit user arrangements are retained.

Window chrome follows the host by default. Advanced enables overrides; Appearance owns system dropdowns, window-control style and side. macOS signal colors are reserved --color-window-* tokens: 12px visual lights inside 24x28px hit regions. Windows retains 44px width; Linux uses 28px round hit regions. These are custom controls invoking host window actions, not native decorations.

Palette mixes resolve to RGBA through the theme/build pipeline for older WKWebView. Continue using semantic colors in source CSS. Active switches/window controls retain visible non-spatial feedback with reduced motion.

Appearance keeps Fit project names directly after Minimalism, outside the advanced disclosure. Corner radius and Interface density share the outer edges of Interface font; the nested geometry grid adds no padding. Existing row and tile modes remain supported.

The server.properties editor has an inline find bar. The field and editor are visible immediately in Advanced; Ctrl+F focuses it; Enter and the navigation buttons select matches without saving. It wraps controls at narrow widths and uses shared fields and buttons.
