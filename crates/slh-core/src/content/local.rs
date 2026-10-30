//! Local files are copied, never moved or silently replaced.
use crate::{
    database,
    error::{AppError, AppResult},
    state::AppState,
};
use std::path::{Path, PathBuf};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: usize,
    pub errors: Vec<String>,
}

pub async fn import_files(
    state: &AppState,
    instance_id: &str,
    category: &str,
    paths: Vec<String>,
) -> AppResult<ImportResult> {
    if paths.is_empty()
        || paths.len() > 256
        || !matches!(category, "mods" | "resourcepacks" | "shaders")
    {
        return Err(AppError::InvalidInput(
            "Select up to 256 content files".into(),
        ));
    }
    let instance = database::instance(&state.database, instance_id).await?;
    if matches!(instance.status.as_str(), "installing" | "launching") {
        return Err(AppError::Conflict(
            "Wait for installation or launch to finish before adding files".into(),
        ));
    }
    let root = crate::instances::validated_instance_root(
        &state.paths,
        &instance.folder_name,
        &instance.game_dir,
    )?;
    let bedrock = instance.loader_type == "bedrock";
    let target = if bedrock {
        let roots = crate::bedrock_files::roots(&instance, &root);
        match category {
            "mods" => roots.behavior_packs.first().cloned(),
            "resourcepacks" => roots.resource_packs.first().cloned(),
            _ => None,
        }
        .ok_or_else(|| {
            AppError::InvalidInput("This Bedrock category does not support imported files".into())
        })?
    } else {
        Path::new(&instance.game_dir).join(if category == "shaders" {
            "shaderpacks"
        } else {
            category
        })
    };
    let category = category.to_owned();
    tokio::task::spawn_blocking(move || {
        if !bedrock
            && (!std::fs::canonicalize(target.parent().unwrap())?
                .starts_with(std::fs::canonicalize(&root)?)
                || std::fs::symlink_metadata(&root)?.file_type().is_symlink())
        {
            return Err(AppError::Security(
                "Game directory is outside this instance".into(),
            ));
        }
        if target.exists() {
            let metadata = std::fs::symlink_metadata(&target)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(AppError::Security(
                    "Content directory is not a regular directory".into(),
                ));
            }
        }
        std::fs::create_dir_all(&target)?;
        if !bedrock && !std::fs::canonicalize(&target)?.starts_with(std::fs::canonicalize(&root)?) {
            return Err(AppError::Security(
                "Content directory is outside this instance".into(),
            ));
        }
        let mut result = ImportResult {
            imported: 0,
            errors: Vec::new(),
        };
        for path in paths {
            let source = PathBuf::from(&path);
            let import = (|| -> AppResult<usize> {
                let metadata = std::fs::symlink_metadata(&source)?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(AppError::InvalidInput(
                        "Choose regular content files".into(),
                    ));
                }
                let extension = source
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if bedrock {
                    if !matches!(extension.as_str(), "mcpack" | "mcaddon" | "zip") {
                        return Err(AppError::InvalidInput(
                            "Choose .mcpack, .mcaddon or .zip packages".into(),
                        ));
                    }
                    return import_bedrock_pack(&source, &target, &category);
                }
                if extension != if category == "mods" { "jar" } else { "zip" } {
                    return Err(AppError::InvalidInput(
                        if category == "mods" {
                            "Mods require .jar files"
                        } else {
                            "Resource packs and shaders require .zip files"
                        }
                        .into(),
                    ));
                }
                // Copy atomically without overwriting an existing pack or mod.
                let mut temporary = tempfile::NamedTempFile::new_in(&target)?;
                std::io::copy(&mut std::fs::File::open(&source)?, &mut temporary)?;
                temporary
                    .persist_noclobber(target.join(source.file_name().unwrap()))
                    .map_err(|error| AppError::Io(error.error))?;
                Ok(1)
            })();
            match import {
                Ok(count) => result.imported += count,
                Err(error) => result.errors.push(format!(
                    "{}: {error}",
                    source.file_name().unwrap_or_default().to_string_lossy()
                )),
            }
        }
        Ok(result)
    })
    .await
    .map_err(|error| AppError::Process(error.to_string()))?
}

fn import_bedrock_pack(source: &Path, target: &Path, category: &str) -> AppResult<usize> {
    let staging = tempfile::tempdir_in(target)?;
    crate::archives::safe_extract(source, staging.path())?;
    // .mcaddon packages may wrap individual .mcpack archives.
    let nested = walkdir::WalkDir::new(staging.path())
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("mcpack"))
        })
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    for (index, package) in nested.iter().enumerate() {
        crate::archives::safe_extract(package, &staging.path().join(format!("nested-{index}")))?;
    }
    let manifests = walkdir::WalkDir::new(staging.path())
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "manifest.json")
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    let mut packs = Vec::new();
    for manifest in manifests {
        let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest)?)?;
        let expected = if category == "mods" {
            "data"
        } else {
            "resources"
        };
        if !value["modules"]
            .as_array()
            .is_some_and(|modules| modules.iter().any(|module| module["type"] == expected))
        {
            continue;
        }
        let uuid = uuid::Uuid::parse_str(value["header"]["uuid"].as_str().unwrap_or_default())
            .map_err(|_| AppError::InvalidInput("Invalid Bedrock pack UUID".into()))?;
        let destination = target.join(uuid.to_string());
        if destination.exists() {
            return Err(AppError::Conflict(
                "This Bedrock pack is already installed".into(),
            ));
        }
        if packs.iter().any(|(_, existing)| existing == &destination) {
            return Err(AppError::Conflict("Duplicate Bedrock pack UUID".into()));
        }
        packs.push((manifest.parent().unwrap().to_path_buf(), destination));
    }
    if packs.is_empty() {
        return Err(AppError::InvalidInput(
            "No Bedrock packs matching the selected category were found".into(),
        ));
    }
    for (index, (source, destination)) in packs.iter().enumerate() {
        if let Err(error) = std::fs::rename(source, destination) {
            for (original, installed) in packs[..index].iter().rev() {
                let _ = std::fs::rename(installed, original);
            }
            return Err(error.into());
        }
    }
    Ok(packs.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_files_work_for_every_java_loader_without_overwriting_or_moving_sources() {
        let temp = tempfile::tempdir().unwrap();
        let paths = crate::portable::PortablePaths::from_executable(
            &temp.path().join("SLH.exe"),
            Some(temp.path().into()),
        )
        .unwrap();
        let state = AppState::initialize_isolated_at(paths).await.unwrap();
        sqlx::query("UPDATE settings SET value_json=json_set(value_json,'$.rustMinecraft',json('true')) WHERE key='general'").execute(&state.database).await.unwrap();
        let source = temp.path().join("example.jar");
        let pack = temp.path().join("pack.zip");
        std::fs::write(&source, b"original mod").unwrap();
        std::fs::write(&pack, b"original pack").unwrap();
        for loader in ["vanilla", "fabric", "forge", "neoforge", "quilt", "rust"] {
            if loader == "rust" && !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
                continue;
            }
            let request = serde_json::from_value(serde_json::json!({"name":loader,"minecraftVersion":"26.3","loaderType":loader,"loaderVersion":"v0.2.96","memoryMinMb":512,"memoryMaxMb":2048})).unwrap();
            let instance =
                crate::instances::create_instance(&state.database, &state.paths, request)
                    .await
                    .unwrap();
            let imported = import_files(
                &state,
                &instance.id,
                "mods",
                vec![
                    source.to_string_lossy().into(),
                    source.to_string_lossy().into(),
                    pack.to_string_lossy().into(),
                ],
            )
            .await
            .unwrap();
            assert_eq!(imported.imported, 1);
            assert_eq!(imported.errors.len(), 2);
            assert_eq!(
                std::fs::read(Path::new(&instance.game_dir).join("mods/example.jar")).unwrap(),
                b"original mod"
            );
            for (category, folder) in [
                ("resourcepacks", "resourcepacks"),
                ("shaders", "shaderpacks"),
            ] {
                let result = import_files(
                    &state,
                    &instance.id,
                    category,
                    vec![pack.to_string_lossy().into()],
                )
                .await
                .unwrap();
                assert_eq!(result.imported, 1);
                assert_eq!(
                    std::fs::read(Path::new(&instance.game_dir).join(folder).join("pack.zip"))
                        .unwrap(),
                    b"original pack"
                );
            }
        }
        assert_eq!(std::fs::read(source).unwrap(), b"original mod");
        state.database.close().await;
    }

    #[test]
    fn bedrock_imports_matching_packs_and_rejects_duplicate_or_unsafe_archives() {
        use std::io::Write;
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("resource_packs");
        std::fs::create_dir_all(&target).unwrap();
        let source = temp.path().join("pack.mcpack");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&source).unwrap());
        zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(br#"{"header":{"uuid":"12345678-1234-1234-1234-123456789abc"},"modules":[{"type":"resources"}]}"#).unwrap();
        zip.finish().unwrap();
        assert!(import_bedrock_pack(&source, &target, "mods").is_err());
        assert_eq!(
            import_bedrock_pack(&source, &target, "resourcepacks").unwrap(),
            1
        );
        assert!(import_bedrock_pack(&source, &target, "resourcepacks").is_err());
        assert!(
            target
                .join("12345678-1234-1234-1234-123456789abc/manifest.json")
                .is_file()
        );
        let unsafe_zip = temp.path().join("unsafe.mcpack");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&unsafe_zip).unwrap());
        zip.start_file("../outside.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"escape").unwrap();
        zip.finish().unwrap();
        assert!(import_bedrock_pack(&unsafe_zip, &target, "resourcepacks").is_err());
        assert!(!temp.path().join("outside.txt").exists());
    }
}
