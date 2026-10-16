use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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

/// A lightweight token for polling editable locale files without parsing or
/// transferring the complete dictionaries when no file changed.
pub fn locale_revision(paths: &PortablePaths, requested: &str) -> AppResult<String> {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    requested.hash(&mut hash);
    for root in bundled_locale_roots(paths) {
        root.hash(&mut hash);
        if !root.exists() { continue; }
        let mut files = Vec::new();
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_file() && path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("json")) {
                files.push(path);
            }
        }
        files.sort();
        for file in files {
            file.hash(&mut hash);
            let metadata = std::fs::metadata(file)?;
            metadata.len().hash(&mut hash);
            metadata.modified()?.hash(&mut hash);
        }
    }
    Ok(format!("{:016x}", hash.finish()))
}

#[cfg(test)]
mod revision_tests {
    use super::*;
    #[test]
    fn revision_detects_same_size_edits_additions_and_removal_without_parsing_json() {
        let root = tempfile::tempdir().unwrap();
        let paths = PortablePaths::from_executable(&root.path().join("slh.exe"), None).unwrap();
        std::fs::create_dir_all(&paths.languages).unwrap();
        let before = locale_revision(&paths, "ru-RU").unwrap();
        assert_eq!(before, locale_revision(&paths, "ru-RU").unwrap());
        assert_ne!(before, locale_revision(&paths, "en-US").unwrap());
        let file = paths.languages.join("custom.JSON");
        std::fs::write(&file, "broken").unwrap();
        let added = locale_revision(&paths, "ru-RU").unwrap();
        assert_ne!(before, added);
        std::fs::write(&file, "edited").unwrap();
        std::fs::File::options().write(true).open(&file).unwrap().set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(2)).unwrap();
        assert_ne!(added, locale_revision(&paths, "ru-RU").unwrap());
        std::fs::remove_file(file).unwrap();
        assert_eq!(before, locale_revision(&paths, "ru-RU").unwrap());
    }
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
    if locale.meta.code.is_empty() || locale.meta.code.len() > 32 || locale.meta.name.trim().is_empty()
        || !locale.meta.code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(crate::error::AppError::InvalidInput("Language needs a valid code and a non-empty name".into()));
    }
    Ok(locale)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleDiagnostic { pub path: String, pub reason: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleSnapshot {
    pub code: String,
    pub messages: serde_json::Value,
    pub locales: Vec<LocaleDescriptor>,
    pub diagnostics: Vec<LocaleDiagnostic>,
    pub valid: bool,
}

fn merge(target: &mut serde_json::Value, overlay: serde_json::Value) {
    if let (Some(base), Some(next)) = (target.as_object_mut(), overlay.as_object()) {
        for (key, value) in next {
            if let Some(previous) = base.get_mut(key) { merge(previous, value.clone()); }
            else { base.insert(key.clone(), value.clone()); }
        }
    } else { *target = overlay; }
}

fn set_message(tree: &mut serde_json::Value, key: &str, value: serde_json::Value) {
    let mut parts = key.splitn(2, '.');
    let part = parts.next().unwrap();
    if let Some(rest) = parts.next() {
        if tree.get(part).is_none() { tree[part] = serde_json::json!({}); }
        set_message(&mut tree[part], rest, value);
    } else if tree.get(part).is_none() { tree[part] = value; }
}

fn parse_messages(path: &Path) -> AppResult<serde_json::Value> {
    read_locale(path)?;
    let content = std::fs::read_to_string(path)?;
    let mut tree: serde_json::Value = serde_json::from_str(content.trim_start_matches('\u{feff}'))?;
    fn validate(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::String(_) => true,
            serde_json::Value::Object(map) => map.values().all(validate),
            _ => false,
        }
    }
    if tree.as_object().is_none_or(|map| map.iter().any(|(key, value)| key != "meta" && !validate(value))) {
        return Err(crate::error::AppError::InvalidInput("Translation values must be strings or sections of strings".into()));
    }
    static SOURCES: std::sync::OnceLock<BTreeMap<String, String>> = std::sync::OnceLock::new();
    let mapping = SOURCES.get_or_init(|| serde_json::from_str(include_str!("../../../src/i18n/sources.json")).expect("checked source catalog"));
    if let Some(legacy) = tree.get("legacy").and_then(|v| v.as_object()).cloned() {
        for (source, value) in legacy {
            if let Some(key) = mapping.get(&source) { set_message(&mut tree, key, value); }
        }
    }
    static ENGLISH: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    let english = ENGLISH.get_or_init(|| serde_json::from_str(include_str!("../../../resources/languages/en-US.json")).expect("checked English catalog"));
    static PARAMS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let params = PARAMS.get_or_init(|| regex::Regex::new(r"\{(\w+)\}").unwrap());
    fn check(value: &serde_json::Value, base: &serde_json::Value, key: &str, params: &regex::Regex) -> AppResult<()> {
        if let (Some(text), Some(original)) = (value.as_str(), base.as_str().or_else(|| base.get("other").and_then(|v| v.as_str()))) {
            let extract = |s: &str| params.captures_iter(s).map(|m| m[1].to_owned()).collect::<std::collections::BTreeSet<_>>();
            if extract(text) != extract(original) { return Err(crate::error::AppError::InvalidInput(format!("Translation {key} must preserve parameters {}", extract(original).into_iter().collect::<Vec<_>>().join(", ")))); }
        } else if let Some(section) = value.as_object() {
            if section.keys().any(|part| ["zero", "one", "two", "few", "many", "other"].contains(&part.as_str())) && section.get("other").is_none_or(|v| !v.is_string()) {
                return Err(crate::error::AppError::InvalidInput(format!("Plural translation {key} must contain an other form")));
            }
            for (part, item) in section { if part != "meta" && part != "legacy" { check(item, base.get(part).or_else(|| base.get("other")).unwrap_or(&serde_json::Value::Null), &format!("{key}.{part}"), params)?; } }
        }
        Ok(())
    }
    check(&tree, english, "", params)?;
    Ok(tree)
}

/// Read all layers in one request; malformed user files remain visible as diagnostics.
pub fn locale_snapshot(paths: &PortablePaths, requested: &str) -> AppResult<LocaleSnapshot> {
    // Remember the code even when an editor temporarily saves invalid JSON
    // in a custom filename such as French.json.
    static FILE_CODES: std::sync::OnceLock<std::sync::Mutex<BTreeMap<PathBuf, String>>> = std::sync::OnceLock::new();
    let file_codes = FILE_CODES.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()));
    let mut messages: serde_json::Value = serde_json::from_str(include_str!("../../../resources/languages/en-US.json"))?;
    let mut diagnostics = vec![];
    let mut selected = vec![];
    let mut locales = BTreeMap::new();
    let mut valid = true;
    for root in bundled_locale_roots(paths) {
        if !root.exists() { continue; }
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            let path = entry.path();
            if !entry.file_type()?.is_file() || !path.extension().and_then(|v| v.to_str()).is_some_and(|v| v.eq_ignore_ascii_case("json")) { continue; }
            match parse_messages(&path) {
                Ok(tree) => {
                    let meta: LocaleFile = serde_json::from_value(tree.clone())?;
                    let code = meta.meta.code;
                    file_codes.lock().unwrap().insert(path.clone(), code.clone());
                    if code == "en-US" { merge(&mut messages, tree.clone()); }
                    if code == requested && requested != "en-US" { selected.push(tree); }
                    locales.insert(code.clone(), LocaleDescriptor { code, name: meta.meta.name, path: path.to_string_lossy().into_owned() });
                }
                Err(error) => {
                    let stem_matches = path.file_stem().and_then(|v| v.to_str()) == Some(requested);
                    let meta_matches = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(s.trim_start_matches('\u{feff}')).ok())
                        .is_some_and(|v| v["meta"]["code"] == requested);
                    let remembered = file_codes.lock().unwrap().get(&path).is_some_and(|code| code == requested);
                    if stem_matches || meta_matches || remembered { valid = false; }
                    diagnostics.push(LocaleDiagnostic { path: path.to_string_lossy().into_owned(), reason: error.to_string() });
                }
            }
        }
    }
    let code = if locales.contains_key(requested) || !valid { requested.to_owned() } else { "en-US".into() };
    let embedded = match code.as_str() {
        "ru-RU" => Some(include_str!("../../../resources/languages/ru-RU.json")),
        "de-DE" => Some(include_str!("../../../resources/languages/de-DE.json")),
        _ => None,
    };
    if let Some(embedded) = embedded { merge(&mut messages, serde_json::from_str(embedded)?); }
    for layer in selected { merge(&mut messages, layer); }
    Ok(LocaleSnapshot { code, messages, locales: locales.into_values().collect(), diagnostics, valid })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_russian_pack_keeps_overrides_and_receives_new_java_labels_without_writes() {
        let root = tempfile::tempdir().unwrap();
        let paths = PortablePaths::from_executable(&root.path().join("SLH.exe"), Some(root.path().join("portable"))).unwrap();
        std::fs::create_dir_all(&paths.languages).unwrap();
        let file = paths.languages.join("ru-RU.json");
        let original = r#"{"meta":{"code":"ru-RU","name":"Custom Russian","schemaVersion":1},"common":{"close":"My close label"}}"#;
        std::fs::write(&file, original).unwrap();
        let snapshot = locale_snapshot(&paths, "ru-RU").unwrap();
        assert_eq!(snapshot.messages["common"]["close"], "My close label");
        assert_eq!(snapshot.messages["settings"]["texts"]["javaSourceDisk"], "Найдена на диске");
        assert_eq!(snapshot.messages["updater"]["install"], "Обновить сейчас");
        assert_eq!(std::fs::read_to_string(file).unwrap(), original);
    }

    #[test]
    fn snapshots_merge_extensions_report_errors_and_fall_back_after_removal() {
        let root = tempfile::tempdir().unwrap();
        let paths = PortablePaths::from_executable(&root.path().join("SLH.exe"), Some(root.path().join("portable"))).unwrap();
        std::fs::create_dir_all(&paths.languages).unwrap();
        let file = paths.languages.join("fr-FR.json");
        std::fs::write(&file, "\u{feff}{\"meta\":{\"code\":\"fr-FR\",\"name\":\"Français\",\"schemaVersion\":1},\"common\":{\"close\":\"Fermer\"}}").unwrap();
        let snapshot = locale_snapshot(&paths, "fr-FR").unwrap();
        assert_eq!(snapshot.code, "fr-FR");
        assert_eq!(snapshot.messages["common"]["close"], "Fermer");
        assert_eq!(snapshot.messages["common"]["cancel"], "Cancel");
        std::fs::write(&file, "{ partially saved").unwrap();
        let broken = locale_snapshot(&paths, "fr-FR").unwrap();
        assert!(!broken.valid);
        assert_eq!(broken.diagnostics.len(), 1);
        std::fs::remove_file(&file).unwrap();
        assert_eq!(locale_snapshot(&paths, "fr-FR").unwrap().code, "en-US");
    }

    #[test]
    fn user_legacy_overrides_are_converted_before_merging_builtins() {
        let root = tempfile::tempdir().unwrap();
        let paths = PortablePaths::from_executable(&root.path().join("SLH.exe"), Some(root.path().join("portable"))).unwrap();
        std::fs::create_dir_all(&paths.languages).unwrap();
        std::fs::write(paths.languages.join("ru-RU.json"), "{\"meta\":{\"code\":\"ru-RU\",\"name\":\"Русский\",\"schemaVersion\":1},\"legacy\":{\"Close\":\"Закрыть окошко\"}}").unwrap();
        let snapshot = locale_snapshot(&paths, "ru-RU").unwrap();
        assert_eq!(snapshot.messages["common"]["close"], "Закрыть окошко");
        assert_eq!(snapshot.messages["common"]["cancel"], "Отмена");
    }

    #[test]
    fn custom_filenames_retain_code_during_invalid_saves_and_validate_parameters() {
        let root = tempfile::tempdir().unwrap();
        let paths = PortablePaths::from_executable(&root.path().join("SLH.exe"), Some(root.path().join("portable"))).unwrap();
        std::fs::create_dir_all(&paths.languages).unwrap();
        let file = paths.languages.join("French.json");
        let json = r#"{"meta":{"code":"fr-FR","name":"Français","schemaVersion":1},"installation":{"installNamed":"Installer {name}"}}"#;
        std::fs::write(&file, json).unwrap();
        assert!(locale_snapshot(&paths, "fr-FR").unwrap().valid);
        std::fs::write(&file, "{").unwrap();
        let broken = locale_snapshot(&paths, "fr-FR").unwrap();
        assert_eq!(broken.code, "fr-FR");
        assert!(!broken.valid);
        std::fs::write(&file, json.replace("{name}", "{title}")).unwrap();
        let invalid = locale_snapshot(&paths, "fr-FR").unwrap();
        assert!(!invalid.valid);
        assert!(invalid.diagnostics[0].reason.contains("name"));
        std::fs::write(&file, json.replace("Installer", "Installer maintenant")).unwrap();
        let changed = locale_snapshot(&paths, "fr-FR").unwrap();
        assert!(changed.valid);
        assert_eq!(changed.messages["installation"]["installNamed"], "Installer maintenant {name}");
    }

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
