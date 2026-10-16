# Памятка по обновлению и сборке SLH

## Где менять лаунчер

- Интерфейс и поведение окон: `src/`.
- Tauri/Rust-команды, база данных, загрузки и запуск Minecraft: `src-tauri/`.
- Версию релиза нужно синхронно менять в `package.json`, `src-tauri/Cargo.toml` и `src-tauri/tauri.conf.json`.
- Рабочий исходник лаунчера — проект; готовый `slh.exe` только собирается из него и вручную не редактируется.

Иконки провайдеров лежат в `src/assets/provider-icons/`. Для Modrinth и CurseForge используются изображения из `Desktop\Хлам\SocialsIcons\128x`. Иконка ядра Vanilla лежит в `src/assets/loader-icons/vanilla.png` и скопирована из `Desktop\icons\Vanilla.png`. Новые похожие иконки сначала ищем в этих папках, затем копируем в проект и подключаем импортом.

## Проверка перед сборкой

```powershell
npm run build
npm run test
cargo test --manifest-path src-tauri/Cargo.toml
```

Для полной поддержки Bedrock сначала инициализируйте закреплённый helper и
установите Go 1.25.3 или новее:

```powershell
git submodule update --init --recursive
npm run build:bedrock-native
```

`build:bedrock-native` собирает лицензированный Windows x64 helper из
`vendor/LeviLauncher` и не добавляет его исходные или Store-токены в SLH.
Сборка x86 остаётся Java-only; helper там не используется.

## Сборки для GitHub

1. `npm run tauri:build` — собирает основной Windows x64 `src-tauri/target/release/slh.exe` без установщика и предварительно собирает Bedrock helper.
2. `npx tauri build` — собирает Windows-установщики с helper в resources; результаты находятся в `src-tauri/target/release/bundle/` (`nsis` и `msi`).
3. `npm run portable` — обновляет portable-папку `release/SLH-Portable` вместе с WebView2, языками и лицензиями.
4. Для чистого архива GitHub использовать:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-portable.ps1 -CleanData
```

Для x86 можно добавить `-Architecture x86`. В GitHub загружаются только чистые portable/installer-файлы без личной папки `data` и аккаунтов. Подготовленные release-материалы хранятся в `forgithub/`.
