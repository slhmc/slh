Home and Discover no longer expose Random or its home panel. The ordinary Discover catalog remains available.

Home and Discover expose only Random for modpack selection. Its Dialog uses genres
and a download comparator/target; matching opens a full Discover project page,
reusing existing description/gallery/version/install controls. Closest is scoped to
matching catalog samples, explicitly stated. See [Random](../docs/modpack-finder.md).

Player rows display names/IP and relevant permissions without remote avatars or UUID.
The same four access lists appear in defaults and creation; creation edits a copy.
Unsupported server versions/runtimes disable standard helpers with a reason and
backend guards. EULA always gates creation; accepted EULA permits blank-name focus.
The EULA checkbox is vertically centered with its label. See server-settings-redesign.md.

Server defaults and individual configuration share ServerConfigFields side navigation,
collapsing above content at 640px. Defaults expose player templates; runtime player
commands remain editable during refresh. World generation and live commands are
separate roles. Core replacement uses explicit confirmation and transactional artifact
backup. See [server settings](../docs/server-settings-redesign.md).

Action layout uses the shared side-panel grid for instances and local servers.
The main list switch changes both; its ellipsis opens independent choices.
Older preferences without `serverActionsAsList` apply to both panels.
Animation settings use a right-aligned ellipsis and an 816px viewport-clamped
dialog (20% wider than medium). Button motion means press compression and
color feedback. Wizard review follows RAM in the right column, with canonical
loader names and an explicit minimum–maximum MB range. Storage categories
use shared gutters; cleanup has 24px inset padding.

# SLH interface

Animation options use the shared Dialog behind an ellipsis action beside the
master toggle. Overall speed is 0.1–10×; icons, buttons, switches and dialogs
can override speed or be disabled separately. Source tabs in instance creation
share fixed viewport-clamped outer geometry. See STATE_AND_MOTION.md.

Icon transitions use the existing pixel geometry through `MorphIcon`, with
300ms and easeInOut via Animate UI / Motion. The saved optional
`appearance.iconMorphing` defaults to enabled; reduced motion disables morphing
and rotation. The custom wizard uses content-height loader/memory panels, one
inner gutter and a compact review; Java selection follows global settings.
See [state and motion rules](STATE_AND_MOTION.md).

Loading actions use the existing `SpinnerGap`; shared `Button` replaces its `icon`
while busy. Horizon keeps its selected loader card enabled during manifest loading,
and reserves Java controls for Java instances. Instance header Play/Stop share
standard control geometry (header action height 45px). Decisions and verification scope:
[loading-consistency.md](../docs/loading-consistency.md).

The create-instance wizard opens `ArtworkEditor` with a compact 72×72 icon-only
trigger, with the translated edit label exposed as its accessible name and tooltip.
The instance settings retain the existing labeled trigger. The wizard layout and
keyboard activation are checked at 800×560 and 1440×900 in
`tests/e2e/artwork-trigger-layout.pw.ts`.

The modpack finder uses the existing large `Dialog` above Home/Discover, shared
controls and theme tokens. Genre chips use `--space-2` gaps, `--radius-sm` and
`--control-height`; questions use a two-column grid with `--space-4`, collapsing
below 680px. Result entry is 150ms ease-out and disabled under reduced motion.
The footer remains separate from scrolling questions/results. No new visual
tokens. Behavior, evidence limits and viewport checks: [modpack-finder.md](../docs/modpack-finder.md).

Диагностика вылета Java-сборки повторяет `PackJobDialog`/`PackInstallError`: общий `Dialog` medium, имя сборки в описании, `StatusPanel` с причиной, раскрываемые технические подробности и стандартный футер. Отступы и формы наследуются от общих компонентов; журнал переносится и прокручивается внутри окна. Одно основное действие ведёт к настройкам, модам или журналу. Не добавлять автоматическое изменение файлов под видом диагностики. Решение и проверки: [launch-diagnostics.md](../docs/launch-diagnostics.md).

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

Rare translation/manual Java/appearance controls use themed disclosures. The library has a short heading. Small creation windows put version selection before identity and keep a version/loader summary in the footer. Instance quick actions use a single button grid without More; explicit user arrangements and visibility are retained. At window widths up to 1320 px the instance grid uses two columns to keep labels readable in WebKit.

Window chrome follows the host by default. Advanced enables overrides; Appearance owns system dropdowns, window-control style and side. macOS signal colors are reserved --color-window-* tokens: 12px visual lights inside 24x28px hit regions. Windows retains 44px width; Linux uses 28px round hit regions. These are custom controls invoking host window actions, not native decorations.

Palette mixes resolve to RGBA through the theme/build pipeline for older WKWebView. Continue using semantic colors in source CSS. Active switches/window controls retain visible non-spatial feedback with reduced motion.

Appearance keeps Fit project names directly after Minimalism, outside the advanced disclosure. Corner radius and Interface density share the outer edges of Interface font; the nested geometry grid adds no padding. Existing row and tile modes remain supported.

The server.properties editor has an inline find bar. The field and editor are visible immediately in Advanced; Ctrl+F focuses it; Enter and the navigation buttons select matches without saving. It wraps controls at narrow widths and uses shared fields and buttons.

Instance pages retain the Library navigation selection and aria-current across tabs. Uses the existing active navigation style; checked in browser preview at 800x560 and 1440x900.

## Действия в боковой панели сборки

«Действия сборки списком» во «Внешнем виде» переключает быстрые действия выбранной сборки между плитками и строками на всю ширину панели. Строки используют семантические цвета плиток, высоту стандартного элемента управления и значок слева от подписи. Порядок, видимость и доступность действий сохраняются. Вид библиотеки настраивается в её панели инструментов.

Плитки и строки визуально сверены в браузерном превью на 800×560 и 1440×900. На 800×560 нижние действия доступны прокруткой внутри боковой панели. Playwright проверяет переключение клавиатурой, геометрию обоих вариантов и независимость вида библиотеки.

Редактор значка сборки использует общий Dialog large и Button. Слева закреплён просмотр с выделением и восемью маркерами; справа содержимое, размер и положение, фон. Каталог иконок открывается отдельно с крупными ячейками. Цвета меняются системным полем, также непосредственно в настройках сборки. Без Shift изменение размера пропорциональное, с Shift независимое; числовые поля и сброс обязательны. Дизеринг убран.

В редакторе оформления квадратный и прямоугольный варианты переключаются над просмотром и по умолчанию используют общую геометрию. Размер измеряется от короткой стороны, диапазон 5–1000%; поворот задаётся в градусах. Три отдельные кнопки сбрасывают положение, размер и поворот, сохраняя содержимое и палитру. Цвет значка и фон находятся рядом, разделены вертикальной линией; фотография отключает цвет значка.

## Artwork editor, 8 November 2026

Keep the launcher’s graphite surfaces, pixel icons, Pixeloid Sans and configured accent. The editor follows the shared Dialog/controls and the existing account appearance dialog; instance identity follows the existing color rows and the user’s compact preset grid reference. No new visual palette or animation system.

Rectangular artwork uses a consistent 1.6:1 surface in the editor, library cards and side panel; square artwork stays square. This deliberately replaces fixed rectangle heights so previews match the installed presentation. Transform dimensions use the short side of the surface. The workspace has a 24px gutter (`--space-6`) for handles outside the clipped artwork, 10px resize markers and 24px rotation hit regions just beyond each corner. Center snapping uses a 2 percentage point threshold. Selection guides use `--color-focus`. Transform gestures track the pointer immediately; actions inherit shared 150ms press feedback and reduced motion handling.

The settings identity panel groups colors, eight basic icon buttons and the editor entry. At narrow widths settings controls wrap. The editor keeps canvas and fields side by side at 800px, using one scrollable column below 700px with its footer always available. Short windows use shape buttons with accessible names/tooltips for format selection. Both output formats remain previewed. Apply writes artwork immediately through the existing instance command; name and other settings remain separate. Closing a changed editor requests confirmation only when destructive confirmations are enabled. Undo/redo cover content, transforms and colors; a pointer gesture is one step, with at most 100 history snapshots sharing image data.

Validation and limitations: [artwork-editor.md](../docs/artwork-editor.md).


Artwork editor refinement: identity presets fill the height of their color rows and the save action aligns with the editor button. Format buttons have equal widths. A top rotation handle complements corner rotation; a compact help popup describes gestures and shortcuts. Photo change/removal share the drop zone, resets share one row, and photo blur precedes the gradient setting. Uses existing SLH controls and semantic tokens. Browser preview checked at 800×560 and 1440×900; physical WebView gestures remain unverified.


Artwork parity refinement: preset icons fill their available columns; the editor and save buttons share a 160px desktop column. The editor toolbar has two vertical stacks (undo/redo and rectangle/square), each with matching button widths and icons. Help follows the entire editor content. Shortcuts use physical KeyZ/KeyY codes. SVG content uses an explicit stretched viewBox; image grid items allow shrinking. Local servers reuse ArtworkEditor, InstanceArtwork rendering and the core artwork validator, while retaining the original server-icon action. Save labels use common.save. Validated by UI audit/build, 185 frontend tests, 11 shell tests and 233 core tests (6 live tests skipped), browser editor/server regressions, and a Cyrillic shortcut/stretch regression. Native gestures remain unverified.


Interface regions: General settings now opt into Ctrl docking and independent absolute area scales (50–200%, 1% fields; keyboard increments 5%). Regions inherit the global WebView scale until explicitly configured. Nested panel zoom compensates its library parent instead of multiplying percentages. Ctrl-drag navigation/tabs to any edge, side panels/settings navigation to left/right; an 8px threshold and focus-colored edge preview precede persistence. Defaults leave both options off. The explicit user request supersedes the earlier no-Ctrl-navigation rule in INTERACTION_CONTRACT.md. Existing position selects provide keyboard alternatives. General settings reuse SettingRow/Toggle. Browser checks: 800×560 and 1440×900. Native physical gestures remain unverified.


9 November: separate area scaling was removed at the user’s request; the global scale and its Ctrl shortcuts remain. The General-settings switch for showing ungrouped instances was removed; existing library context actions and the saved visibility preference remain intact. Ctrl panel docking remains available.


9 November: the last-build artwork on the beautiful home preserves its configured foreground and background, matching the library. Muted metadata styling applies only to the adjacent text, never to descendants of InstanceArtwork. Verified at 800×560 and 1440×900 with a custom foreground and existing library artwork rendering; no intentional visual divergence.




Correction: the blue artwork-edge artifact reproduces at 800×560 because grid auto rows shrink below the aspect-ratio artwork height. The artwork overlaps identity and launch controls. The instance panel now stacks non-shrinking flex children in its scroll area; this retains the shared 15px gaps and scrolls excess content. Earlier speculative caret/selection styles were removed. Browser regression checks actual artwork/identity/button geometry at 800×560 and 1440×900.


## Home character settings, 9 November 2026

Home character is one ordinary settings tile, following the user's compact reference and the neighboring scale/home tiles. It contains a short description, three shared Button choices (3D, Image, Off), one inline FPS row and cursor-follow beneath it. The tile does not span the grid; normal responsive stacking remains. Row mode keeps the same control composition with the existing 360px compound-control column. No divider inside the tile. Stored modes 2/1/0 are retained; 3D-only controls remain visible and disabled outside 3D without clearing preferences.

Existing graphite surfaces, configured accent, typography, spacing, radii and shared 150ms press behavior remain. The mode grid uses .7/1.2/.9 fractions to allocate space to the image label and a 4px gap/padding from --space-1. Compact FPS retains the 30/60 magnets, exact keyboard values and unlimited state. New localized compact description, short Off and FPS label have separate keys; existing long descriptions and mode keys remain available. Validation: ../docs/home-character-settings.md.


## Sync setup, 9 November 2026

Sync uses the existing library header/list and Settings disclosure pattern. Create sync opens an inline three-step form: content, builds, initial copy. Shared Button, field styling, mapping rows and semantic surface tokens remain. First-copy replacement/backups and automatic lifecycle are explained next to the relevant control. World safety is contextual; advanced Rust/world gates live below the list. No always-on warning claiming worlds are off. A 150ms opacity/4px reveal follows SLH motion and is omitted with reduced motion. At narrow widths list controls and footer wrap without reducing text. See ../docs/sync-setup.md.


Sync alignment follow-up: mapping metadata spans its own row, with update controls sharing the select baseline; narrow layout stacks the source above actions. First-copy selection seeds the immediate manual choice, but restored mappings require an explicit manual source. No automatic first-build choice. See ../docs/sync-setup.md.


The home-character FPS output reserves a fixed 3ch column to prevent track resizing under the pointer at 60/infinity. Only the left caption carries FPS; the visible readout is numeric or infinity. Accessible value text retains units.

The 100% UI baseline is 0.9 WebView zoom; saved scale percentages are unchanged.
Custom creation targets 840 logical px height, clamped to the viewport.
Smooth animations retain the compatible `iconMorphing` preference key.
