//! Replace local Fabric/Quilt dependencies by their declared identity, never by file name.
use crate::{error::AppResult, local_servers::store::plain_path, state::AppState};

#[derive(Default)]
pub(crate) struct ContentStage(Vec<(PathBuf,PathBuf,Option<String>)>);
impl ContentStage {
    pub fn prepare(&mut self,destination:&Path)->AppResult<PathBuf> {
        plain_path(destination)?;
        let staged=destination.with_file_name(format!(".{}.{}.slh-ready",destination.file_name().unwrap().to_string_lossy(),uuid::Uuid::new_v4()));
        let original=if destination.is_file(){Some(crate::local_servers::providers::hash_file(destination,None,None)?)}else{None};
        self.0.push((staged.clone(),destination.to_path_buf(),original));Ok(staged)
    }
    pub async fn commit(&self,staged:&Path,destination:&Path,sha1:&str)->AppResult<()> {
        plain_path(staged)?;plain_path(destination)?;
        let original=&self.0.iter().find(|(s,d,_)|s==staged&&d==destination).ok_or_else(||crate::error::AppError::Security("Unknown content staging file".into()))?.2;
        let current=if destination.is_file(){Some(crate::local_servers::providers::hash_file(destination,None,None)?)}else{None};
        if &current!=original {return Err(crate::error::AppError::Conflict("The installed file changed during download; retry the installation".into()));}
        if !crate::minecraft::download::verify_sha1(staged,sha1).await? {return Err(crate::error::AppError::Security("Content staging checksum mismatch".into()));}
        tokio::fs::rename(staged,destination).await?;Ok(())
    }
}
impl Drop for ContentStage {
    fn drop(&mut self) {
        for (staged,_,_) in &self.0 {
            let temporary=staged.with_file_name(format!(".{}.slh-part",staged.file_name().unwrap().to_string_lossy()));
            for path in [staged,&temporary] {if plain_path(path).is_ok(){let _=std::fs::remove_file(path);}}
        }
    }
}
use std::{
    collections::BTreeSet,
    io::Read,
    path::{Path, PathBuf},
};

fn identity(path: &Path) -> Option<BTreeSet<String>> {
    plain_path(path).ok()?;
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path).ok()?).ok()?;
    let mut ids = BTreeSet::new();
    for (name, pointer) in [
        ("fabric.mod.json", "/id"),
        ("quilt.mod.json", "/quilt_loader/id"),
    ] {
        if let Ok(file) = archive.by_name(name) {
            if file.size() > 256 * 1024 {
                return None;
            }
            let mut text = String::new();
            file.take(256 * 1024 + 1).read_to_string(&mut text).ok()?;
            let value: serde_json::Value = serde_json::from_str(&text).ok()?;
            let id = value.pointer(pointer)?.as_str()?;
            if id.is_empty()
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
            {
                return None;
            }
            ids.insert(id.to_owned());
        }
    }
    if ids.is_empty() { None } else { Some(ids) }
}

fn duplicates(destination: &Path) -> Vec<PathBuf> {
    let Some(id) = identity(destination) else {
        return vec![];
    };
    let Some(parent) = destination.parent() else {
        return vec![];
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return vec![];
    };
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|path| {
            path != destination
                && path
                    .extension()
                    .is_some_and(|s| s.eq_ignore_ascii_case("jar"))
                && identity(path).as_ref() == Some(&id)
        })
        .collect()
}

/// Called only after every replacement in the batch has passed the provider checksum.
/// Disabled files stay disabled. Unknown, corrupt and linked JARs are left untouched.
pub async fn replace_duplicates(
    state: &AppState,
    instance_id: &str,
    destination: &Path,
) -> AppResult<u64> {
    let mut removed = 0;
    for old in duplicates(destination) {
        plain_path(&old)?;
        let before = crate::local_servers::providers::hash_file(&old, None, None)?;
        let backup = state
            .paths
            .backups
            .join("content")
            .join(instance_id)
            .join(uuid::Uuid::new_v4().to_string())
            .join(old.file_name().unwrap());
        tokio::fs::create_dir_all(backup.parent().unwrap()).await?;
        tokio::fs::copy(&old, &backup).await?;
        plain_path(&old)?;
        if before != crate::local_servers::providers::hash_file(&backup, None, None)?
            || before != crate::local_servers::providers::hash_file(&old, None, None)?
        {
            continue;
        }
        tokio::fs::remove_file(&old).await?;
        sqlx::query("DELETE FROM installed_content WHERE instance_id = ? AND file_path = ?")
            .bind(instance_id)
            .bind(old.to_string_lossy().as_ref())
            .execute(&state.database)
            .await?;
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn jar(path: &Path, id: &str) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        zip.start_file("fabric.mod.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        write!(zip, "{{\"id\":\"{id}\"}}").unwrap();
        zip.finish().unwrap();
    }
    #[test]
    fn recognizes_dependency_versions_and_preserves_other_mods_and_disabled_files() {
        let root = tempfile::tempdir().unwrap();
        let new = root.path().join("fabric-api-0.164.jar");
        jar(&new, "fabric-api");
        let old = root.path().join("fabric-api-0.163.jar");
        jar(&old, "fabric-api");
        jar(&root.path().join("fabric-api-addon.jar"), "addon");
        jar(&root.path().join("fabric-api.jar.disabled"), "fabric-api");
        std::fs::write(root.path().join("broken.jar"), b"not a jar").unwrap();
        assert_eq!(duplicates(&new), vec![old]);
    }
    #[test]
    fn does_not_guess_identity_from_names_or_invalid_replacement() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("fabric-api-new.jar");
        std::fs::write(&path, b"broken download").unwrap();
        jar(&root.path().join("fabric-api-old.jar"), "fabric-api");
        assert!(duplicates(&path).is_empty());
    }
}

#[cfg(test)] mod staging_tests {
 use super::*;
 #[test] fn interrupted_batch_leaves_existing_mods_unchanged() {
  let root=tempfile::tempdir().unwrap();let target=root.path().join("fabric-api.jar");std::fs::write(&target,b"old").unwrap();
  let staged={let mut stage=ContentStage::default();let path=stage.prepare(&target).unwrap();std::fs::write(&path,b"new verified file").unwrap();path};
  assert_eq!(std::fs::read(target).unwrap(),b"old");assert!(!staged.exists());
 }
 #[tokio::test] async fn changed_target_and_invalid_download_are_not_replaced() {
  use sha1::Digest;let root=tempfile::tempdir().unwrap();let target=root.path().join("fabric-api.jar");std::fs::write(&target,b"old").unwrap();
  let mut stage=ContentStage::default();let path=stage.prepare(&target).unwrap();std::fs::write(&path,b"new").unwrap();
  assert!(stage.commit(&path,&target,"0000000000000000000000000000000000000000").await.is_err());
  let hash=hex::encode(sha1::Sha1::digest(b"new"));std::fs::write(&target,b"user edit").unwrap();assert!(stage.commit(&path,&target,&hash).await.is_err());assert_eq!(std::fs::read(&target).unwrap(),b"user edit");
 }
}
