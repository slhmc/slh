use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

#[derive(Clone, Debug)]
pub struct PortablePaths {
    /// Resource directory supplied by the desktop host.
    pub bundled_resources: Option<PathBuf>,
    pub executable_dir: PathBuf,
    pub root: PathBuf,
    pub data: PathBuf,
    pub accounts: PathBuf,
    pub instances: PathBuf,
    pub shared: PathBuf,
    pub cache: PathBuf,
    pub downloads: PathBuf,
    pub java: PathBuf,
    pub logs: PathBuf,
    pub backups: PathBuf,
    /// User-provided language files. Each `*.json` file is one locale.
    pub languages: PathBuf,
    pub fonts: PathBuf,
}

impl PortablePaths {
    pub fn resolve() -> AppResult<Self> {
        let executable = std::env::current_exe()?;
        let mut args = std::env::args_os().skip(1);
        let mut selected = None;
        while let Some(argument) = args.next() {
            if argument == "--data-dir" {
                let root = args.next().ok_or_else(|| AppError::InvalidInput("--data-dir requires a directory".into()))?;
                if root.is_empty() { return Err(AppError::InvalidInput("--data-dir requires a directory".into())); }
                selected = Some(PathBuf::from(root));
            }
        }
        let override_root = selected.or_else(|| if cfg!(any(debug_assertions, test)) {
            std::env::var_os("SLH_PORTABLE_ROOT").map(PathBuf::from)
        } else {
            None
        });
        Self::from_executable(&executable, override_root)
    }

    pub fn from_executable(executable: &Path, override_root: Option<PathBuf>) -> AppResult<Self> {
        let executable_dir = executable
            .parent()
            .ok_or_else(|| {
                AppError::InvalidInput("Executable path has no parent directory".into())
            })?
            .to_path_buf();
        let root = match override_root {
            Some(root) => root,
            None => crate::platform::default_data_root(executable_dir.clone())?,
        };
        let data = root.join("data");
        Ok(Self {
            bundled_resources: None,
            executable_dir,
            accounts: data.join("accounts"),
            instances: data.join("instances"),
            shared: data.join("shared"),
            cache: data.join("cache"),
            downloads: data.join("downloads"),
            java: data.join("java"),
            logs: data.join("logs"),
            backups: data.join("backups"),
            languages: data.join("languages"),
            fonts: data.join("fonts"),
            root,
            data,
        })
    }

    pub fn database(&self) -> PathBuf {
        self.data.join("app.db")
    }

    pub fn initialize(&self) -> AppResult<()> {
        for directory in [
            &self.data,
            &self.accounts,
            &self.instances,
            &self.shared,
            &self.cache,
            &self.downloads,
            &self.java,
            &self.logs,
            &self.backups,
            &self.languages,
            &self.fonts,
        ] {
            std::fs::create_dir_all(directory)?;
        }
        for category in [
            "options",
            "servers",
            "resourcepacks",
            "screenshots",
            "mod-configs",
            "custom",
            "worlds",
        ] {
            std::fs::create_dir_all(self.shared.join(category))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_data_directory_is_platform_independent() {
        let root = std::env::temp_dir().join("SLH portable test");
        let executable = root.join("bin").join("slh");
        let paths = PortablePaths::from_executable(&executable, Some(root.clone())).unwrap();
        assert_eq!(paths.database(), root.join("data/app.db"));
    }

    #[test]
    #[cfg(windows)]
    fn portable_root_is_based_on_executable_not_cwd() {
        let executable = PathBuf::from(r"C:\Игры с пробелами\SLH\SLH.exe");
        let paths = PortablePaths::from_executable(&executable, None).unwrap();
        assert_eq!(paths.data, PathBuf::from(r"C:\Игры с пробелами\SLH\data"));
        assert_eq!(
            paths.database(),
            PathBuf::from(r"C:\Игры с пробелами\SLH\data\app.db")
        );
    }

    #[test]
    #[cfg(windows)]
    fn explicit_debug_override_is_respected() {
        let executable = PathBuf::from(r"C:\build\slh.exe");
        let paths = PortablePaths::from_executable(
            &executable,
            Some(PathBuf::from(r"D:\Portable Test\SLH")),
        )
        .unwrap();
        assert_eq!(paths.root, PathBuf::from(r"D:\Portable Test\SLH"));
    }
}
