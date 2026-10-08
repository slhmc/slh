use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::AppResult;
use crate::models::LocaleDescriptor;
use crate::portable::PortablePaths;

#[derive(Deserialize)]
struct LocaleFile {
    meta: LocaleMeta,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocaleMeta {
    code: String,
    name: String,
    schema_version: u32,
}

fn bundled_locale_roots(paths: &PortablePaths) -> Vec<PathBuf> {
    // Legacy roots are read first so the new per-language extension folder
    // can override an older install with the same locale code.
    let mut roots = vec![
        paths.data.join("locales"),
        paths.executable_dir.join("resources").join("locales"),
        // Tauri places bundle resources under `_up_/resources` next to the
        // executable on Windows. Portable releases use `resources` directly.
        paths
            .executable_dir
            .join("_up_")
            .join("resources")
            .join("languages"),
    ];
    if cfg!(debug_assertions) {
        roots.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join("resources")
                .join("locales"),
        );
        roots.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join("resources")
                .join("languages"),
        );
    }
    if let Some(bundle) = &paths.bundled_resources {
        roots.push(bundle.join("_up_").join("resources").join("languages"));
        roots.push(bundle.join("resources").join("languages"));
    }
    roots.push(paths.executable_dir.join("resources").join("languages"));
    roots.push(paths.languages.clone());
    roots
}

pub fn list_locales(paths: &PortablePaths) -> AppResult<Vec<LocaleDescriptor>> {
    let mut locales = BTreeMap::<String, LocaleDescriptor>::new();
    for root in bundled_locale_roots(paths) {
        if !root.exists() {
            continue;
        }
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let path = entry.path();
            if !path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("json"))
            {
                continue;
            }
            if let Ok(locale) = read_locale(&path) {
                locales.insert(
                    locale.meta.code.clone(),
                    LocaleDescriptor {
                        code: locale.meta.code,
                        name: locale.meta.name,
                        path: path.to_string_lossy().into_owned(),
                    },
                );
            }
        }
    }
    Ok(locales.into_values().collect())
}

pub fn load_locale(paths: &PortablePaths, code: &str) -> AppResult<serde_json::Value> {
    if code.is_empty()
        || code.len() > 32
        || !code
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(crate::error::AppError::InvalidInput(
            "Locale code contains invalid characters".into(),
        ));
    }
    let descriptor = list_locales(paths)?
        .into_iter()
        .find(|locale| locale.code == code)
        .ok_or_else(|| crate::error::AppError::NotFound(format!("Locale {code}")))?;
    let content = std::fs::read_to_string(descriptor.path)?;
    let content = content.strip_prefix('\u{feff}').unwrap_or(&content);
    Ok(serde_json::from_str(content)?)
}

fn read_locale(path: &Path) -> AppResult<LocaleFile> {
    // Editors on Windows may save a UTF-8 BOM. It is harmless for a locale
    // file, so accept it instead of silently hiding an otherwise valid locale.
    let content = std::fs::read_to_string(path)?;
    let content = content.strip_prefix('\u{feff}').unwrap_or(&content);
    let locale: LocaleFile = serde_json::from_str(&content)?;
    if locale.meta.schema_version != 1 {
        return Err(crate::error::AppError::InvalidInput(format!(
            "Unsupported locale schema in {}",
            path.display()
        )));
    }
    Ok(locale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_user_languages_and_case_insensitive_json_extensions() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("SLH.exe");
        let paths = PortablePaths::from_executable(&executable, Some(root.path().join("portable")))
            .unwrap();
        std::fs::create_dir_all(&paths.languages).unwrap();
        std::fs::write(
            paths.languages.join("de-DE.JSON"),
            "\u{feff}{\"meta\":{\"code\":\"de-DE\",\"name\":\"Deutsch\",\"schemaVersion\":1}}",
        )
        .unwrap();

        let locales = list_locales(&paths).unwrap();
        let german = locales
            .iter()
            .find(|locale| locale.code == "de-DE")
            .unwrap();
        assert_eq!(german.name, "Deutsch");
        assert_eq!(
            load_locale(&paths, "de-DE").unwrap()["meta"]["name"],
            "Deutsch"
        );
    }

    #[test]
    fn discovers_tauri_windows_bundle_languages() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("SLH.exe");
        let paths = PortablePaths::from_executable(&executable, None).unwrap();
        let bundled_languages = paths
            .executable_dir
            .join("_up_")
            .join("resources")
            .join("languages");
        std::fs::create_dir_all(&bundled_languages).unwrap();
        std::fs::write(
            bundled_languages.join("ru-RU.json"),
            "{\"meta\":{\"code\":\"ru-RU\",\"name\":\"Русский\",\"schemaVersion\":1}}",
        )
        .unwrap();

        let locales = list_locales(&paths).unwrap();
        assert!(locales.iter().any(|locale| locale.code == "ru-RU"));
    }

    #[test]
    fn host_bundle_resources_work_independently_of_executable_location() {
        let root = tempfile::tempdir().unwrap();
        let mut paths = PortablePaths::from_executable(&root.path().join("bin/slh"), Some(root.path().join("data-root"))).unwrap();
        let bundle = root.path().join("app-resources");
        let languages = bundle.join("_up_/resources/languages");
        std::fs::create_dir_all(&languages).unwrap();
        std::fs::write(languages.join("ru-RU.json"), "{\"meta\":{\"code\":\"ru-RU\",\"name\":\"Русский\",\"schemaVersion\":1}}").unwrap();
        paths.bundled_resources = Some(bundle);
        assert_eq!(load_locale(&paths, "ru-RU").unwrap()["meta"]["name"], "Русский");
    }
}
