//! Small, local failure reports. Never collect account records, environment
//! variables or launch arguments; game log excerpts are bounded and redacted.
use std::{io::{Read, Seek, SeekFrom}, path::Path};
use crate::{error::AppError, state::AppState};

pub fn validate_report_path(paths: &crate::portable::PortablePaths, path: &Path) -> crate::error::AppResult<std::path::PathBuf> {
    let directory = paths.root.join("crash").canonicalize()?;
    let metadata = std::fs::symlink_metadata(path)?;
    let canonical = path.canonicalize()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || canonical.parent() != Some(directory.as_path())
        || canonical.extension().and_then(|e| e.to_str()) != Some("txt")
        || !canonical.file_name().unwrap_or_default().to_string_lossy().starts_with("slh-") {
        return Err(AppError::Security("Only SLH failure reports in the crash folder can be opened".into()));
    }
    Ok(canonical)
}

pub fn install_panic_hook(paths: &crate::portable::PortablePaths) {
    let directory = paths.root.join("crash");
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // No backtrace/environment dump: panic payload and source location only.
        let _ = std::fs::create_dir_all(&directory);
        let path = directory.join(format!("slh-panic-{}.txt", uuid::Uuid::new_v4()));
        let body = format!("SLH — сбой лаунчера / launcher panic\nTime: {}\nVersion: {}\n{}\nПерезапустите SLH; приложите этот отчёт при обращении за помощью. / Restart SLH and attach this report when asking for help.\n",
            chrono::Utc::now().to_rfc3339(), env!("CARGO_PKG_VERSION"), info);
        let _ = std::fs::write(path, crate::security::redact_diagnostic(&body));
        previous(info);
    }));
}

pub fn message_key(error: &AppError) -> String {
    let text = error.to_string().to_ascii_lowercase();
    let key = match error.root() {
        AppError::PackFileUnavailable { .. } => "errors.packFileUnavailable",
        AppError::Network(e) if e.status().is_some_and(|s| s.as_u16() == 429) => "errors.downloadRateLimited",
        AppError::Network(e) if e.status().is_some_and(|s| matches!(s.as_u16(), 401 | 403)) => "errors.downloadForbidden",
        AppError::Network(e) if e.status().is_some_and(|s| s.as_u16() == 404) => "errors.downloadMissing",
        AppError::Network(_) => "errors.downloadNetwork",
        AppError::Io(e) if e.kind() == std::io::ErrorKind::PermissionDenied => "errors.filePermission",
        AppError::Io(e) if matches!(e.raw_os_error(), Some(28 | 112)) => "errors.diskFull",
        AppError::Security(_) if text.contains("checksum mismatch") => "errors.downloadChecksum",
        AppError::Archive(_) => "errors.packArchive",
        AppError::Process(_) if text.contains("minecraft exited") => "errors.gameCrashed",
        AppError::Unavailable(_) if text.contains("curseforge") && text.contains("429") => "errors.downloadRateLimited",
        AppError::Unavailable(_) if text.contains("curseforge") && (text.contains("relay") || text.contains("non-json")) => "errors.curseforgeService",
        AppError::Conflict(_) if text.contains("sync conflict in ") => "errors.syncConflict",
        _ => return format!("errors.{}", error.code()),
    };
    key.into()
}

fn advice(error: &AppError) -> &'static str {
    match message_key(error).as_str() {
        "errors.downloadRateLimited" => "Сервис ограничил запросы. Подождите и повторите установку. / The service is rate limited. Wait and retry installation.",
        "errors.downloadForbidden" => "Сервис запретил загрузку. Проверьте доступ к провайдеру; для CurseForge используйте предложенную ручную загрузку. / Access denied. Check provider access; use the offered manual download for restricted CurseForge files.",
        "errors.downloadMissing" => "Файл больше не доступен. Выберите другую версию сборки или сообщите автору. / File unavailable. Choose another pack version or contact its author.",
        "errors.packFileUnavailable" => "Обязательный файл сборки помечен провайдером как недоступный. Выберите другую версию сборки или сообщите автору. Пропуск файла может сделать сборку неработоспособной. / A required pack file is unavailable at the provider. Choose another pack version or contact the author. Skipping it can break the pack.",
        "errors.downloadNetwork" => "Проверьте соединение и доступ к сервису. Повторите установку: проверенные файлы используются повторно. / Check connectivity and retry. Verified files are reused.",
        "errors.filePermission" => "Нет доступа к файлу. Закройте игру и проверьте права на папку; возможно, файл занят другим процессом. / Close the game and check folder permissions or file locks.",
        "errors.diskFull" => "Недостаточно места. Освободите место на диске с данными SLH и повторите установку. / Free space on the SLH data drive and retry.",
        "errors.downloadChecksum" => "Контрольная сумма не совпала. Повторите загрузку; если ошибка повторяется, сообщите автору сборки. / Checksum mismatch. Retry; contact the pack author if it persists.",
        "errors.packArchive" => "Не удалось прочитать архив. Скачайте его повторно из каталога провайдера. / Archive unreadable. Download it again from the provider.",
        "errors.curseforgeService" => "Сервис доступа к CurseForge недоступен или вернул неверный ответ. Повторите позже. Если настроен личный API-ключ, проверьте его в настройках загрузок. / CurseForge access is unavailable or returned an invalid response. Retry later; check a personal API key in download settings if configured.",
        "errors.gameCrashed" => "Minecraft завершился с ошибкой. Проверьте конец журнала ниже: требования Java, память и совместимость модов. Код выхода сам по себе не указывает точную причину. / Inspect the log excerpt for Java, memory or mod compatibility errors. The exit code alone does not identify the cause.",
        "errors.syncConflict" => "Откройте Настройки → Синхронизация и разрешите конфликт файлов. / Resolve the file conflict in Settings → Synchronization.",
        _ => "Прочитайте техническую причину ниже. Повторите действие после её устранения; для помощи приложите этот отчёт. / Read the technical cause below. Resolve it and retry; attach this report when asking for help.",
    }
}

pub async fn record(state: &AppState, error: AppError, operation: &str, stage: &str,
    instance_id: Option<&str>, log: Option<&Path>) -> AppError {
    if error.report_path().is_some() || matches!(error.root(), AppError::Cancelled | AppError::ManualDownloads { .. }
        | AppError::OfflineAccountNameRequired(_) | AppError::TwoFactorRequired(_)) { return error; }
    let instance = match instance_id { Some(id) => crate::database::instance(&state.database, id).await.ok(), None => None };
    let context = instance.map(|i| serde_json::json!({
        "id": i.id, "name": i.name, "minecraftVersion": i.minecraft_version,
        "loader": i.loader_type, "loaderVersion": i.loader_version,
        "memoryMinMb": i.memory_min_mb, "memoryMaxMb": i.memory_max_mb,
        "gameDirectory": i.game_dir,
    }));
    use std::error::Error;
    let mut sources = Vec::new();
    let mut source = error.source();
    while let Some(cause) = source {
        sources.push(crate::security::redact_diagnostic(&cause.to_string()));
        if sources.len() >= 8 { break; }
        source = cause.source();
    }
    let report = serde_json::json!({
        "schemaVersion": 1, "timeUtc": chrono::Utc::now().to_rfc3339(),
        "launcherVersion": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS,
        "operation": operation, "stage": stage, "instance": context,
        "errorCode": error.code(), "messageKey": message_key(&error),
        "technicalCause": crate::security::redact_diagnostic(&error.to_string()), "sourceChain": sources, "logPath": log.map(|p| p.to_string_lossy()),
    });
    let body = format!("SLH — отчёт об ошибке / failure report\n\nЧто делать / What to do:\n{}\n\nКонтекст и причина / Context and cause:\n{}\n",
        advice(&error), serde_json::to_string_pretty(&report).unwrap_or_default());
    let directory = state.paths.root.join("crash");
    let log = log.map(Path::to_path_buf);
    let written = tokio::task::spawn_blocking(move || -> std::io::Result<String> {
        let mut body = body;
        if let Some(log) = log {
            if let Ok(mut file) = std::fs::File::open(log) {
                let length = file.metadata()?.len();
                let start = length.saturating_sub(48 * 1024);
                file.seek(SeekFrom::Start(start))?;
                let mut bytes = Vec::new();
                file.take(48 * 1024).read_to_end(&mut bytes)?;
                // Drop a partial first line instead of exposing a cut-off credential.
                let excerpt = if start > 0 { bytes.iter().position(|b| *b == b'\n').map_or(&[][..], |p| &bytes[p+1..]) } else { &bytes };
                let excerpt = String::from_utf8_lossy(excerpt);
                if let Some(hint) = game_log_hint(&excerpt) {
                    body.push_str("\nПодсказка по журналу / Log hint:\n");
                    body.push_str(hint);
                }
                body.push_str("\nПоследние строки журнала / Last log lines:\n");
                body.push_str(&excerpt);
            }
        }
        std::fs::create_dir_all(&directory)?;
        let path = directory.join(format!("slh-{}-{}.txt", chrono::Utc::now().format("%Y%m%dT%H%M%SZ"), uuid::Uuid::new_v4()));
        // create_new prevents accidental overwrites, including through symlinks.
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
        file.write_all(crate::security::redact_diagnostic(&body).as_bytes())?;
        Ok(path.to_string_lossy().into_owned())
    }).await;
    match written {
        Ok(Ok(report_path)) => { tracing::error!(%report_path, code = error.code(), "failure report saved"); AppError::Reported { source: Box::new(error), report_path } },
        _ => { tracing::warn!("could not save failure report; returning original error"); error },
    }
}

fn game_log_hint(log: &str) -> Option<&'static str> {
    let log = log.to_ascii_lowercase();
    if log.contains("multipleargumentsforoptionexception") {
        Some("Журнал указывает на повторяющийся параметр запуска. Это ошибка формирования команды, а не признак отсутствующей Java. Обновите SLH; если ошибка повторится, приложите этот отчёт. / The log indicates a duplicated launch option. This is a command construction error, not evidence of missing Java. Update SLH and attach this report if it persists.\n")
    } else if log.contains("outofmemoryerror") || log.contains("could not reserve enough space") {
        Some("Журнал указывает на нехватку памяти. Проверьте лимит памяти сборки и свободную память компьютера. / The log indicates a memory allocation failure. Check instance memory limits and available system memory.\n")
    } else if log.contains("unsupportedclassversionerror") || log.contains("compiled by a more recent version of the java runtime") {
        Some("В журнале указана несовместимая версия Java. Проверьте требования сборки и выбранную Java. / The log indicates an incompatible Java version. Check pack requirements and the selected runtime.\n")
    } else if log.contains("incompatible mods found") || log.contains("modresolutionexception") || log.contains("mixin apply failed") {
        Some("Журнал содержит ошибку совместимости модов. Проверьте указанные ниже моды, их зависимости и версии загрузчика. / The log contains a mod compatibility error. Check the listed mods, dependencies and loader versions.\n")
    } else if log.contains("glfw error") || log.contains("failed to create window") {
        Some("Журнал содержит ошибку создания окна или графического контекста. Проверьте драйвер видеокарты и требования игры. / The log contains a window or graphics context error. Check the graphics driver and game requirements.\n")
    } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_launch_options_are_not_diagnosed_as_missing_java() {
        let hint = game_log_hint("joptsimple.MultipleArgumentsForOptionException: Found multiple arguments for option gameDir").unwrap();
        assert!(hint.contains("duplicated launch option"));
        assert!(hint.contains("not evidence of missing Java"));
    }
    #[tokio::test]
    async fn report_preserves_context_redacts_credentials_and_is_not_duplicated() {
        let root = tempfile::tempdir().unwrap();
        let paths = crate::portable::PortablePaths::from_executable(&root.path().join("SLH.exe"), Some(root.path().to_path_buf())).unwrap();
        let state = AppState::initialize_isolated_at(paths).await.unwrap();
        let log = root.path().join("game.log");
        std::fs::write(&log, "java.lang.OutOfMemoryError\n--accessToken secret-cli\nrefresh_token=secret-refresh\nAuthorization: Bearer secret-bearer\nhttps://cdn.test/file.jar?signature=secret-url\n").unwrap();
        let error = record(&state, AppError::Process("Minecraft exited with code Some(1)".into()), "launch", "game-process", None, Some(&log)).await;
        let path = error.report_path().unwrap().to_owned();
        let text = std::fs::read_to_string(&path).unwrap();
        for secret in ["secret-cli", "secret-refresh", "secret-bearer", "secret-url"] { assert!(!text.contains(secret), "leaked {secret}"); }
        assert!(text.contains("memory allocation failure"));
        assert!(text.contains("game-process"));
        let error = record(&state, error, "outer-command", "failed", None, None).await;
        assert_eq!(error.report_path(), Some(path.as_str()));
        assert_eq!(std::fs::read_dir(root.path().join("crash")).unwrap().count(), 1);
        assert!(validate_report_path(&state.paths, Path::new(&path)).is_ok());
        assert!(validate_report_path(&state.paths, &log).is_err());
        let command: crate::error::CommandError = error.into();
        assert_eq!(command.message_key.as_deref(), Some("errors.gameCrashed"));
        assert_eq!(command.details.unwrap()["reportPath"], path);
        state.database.close().await;
    }

    #[tokio::test]
    async fn expected_states_and_unwritable_reports_preserve_original_errors() {
        let root = tempfile::tempdir().unwrap();
        let paths = crate::portable::PortablePaths::from_executable(&root.path().join("SLH.exe"), Some(root.path().to_path_buf())).unwrap();
        let state = AppState::initialize_isolated_at(paths).await.unwrap();
        for error in [AppError::Cancelled, AppError::ManualDownloads { directory: "manual".into(), files: vec![] }] {
            let code = error.code();
            let error = record(&state, error, "import", "metadata", None, None).await;
            assert_eq!(error.code(), code);
            assert!(error.report_path().is_none());
        }
        assert!(!root.path().join("crash").exists());
        std::fs::write(root.path().join("crash"), b"occupied").unwrap();
        let error = record(&state, AppError::Conflict("original cause".into()), "launch", "prepare", None, None).await;
        assert!(error.report_path().is_none());
        assert!(error.to_string().contains("original cause"));
        state.database.close().await;
    }
}

