//! Resource policy for the Windows web UI, never for games or downloads.
use serde::{Deserialize, Serialize};
use crate::error::{AppError, AppResult};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebviewSettings {
    pub enabled: bool,
    pub extreme: bool,
    pub cpu_cores: u32,
    pub background_cpu_cores: u32,
    pub background_memory_mb: u32,
    pub max_fps: u32,
    pub suspend_after_seconds: u32,
}

impl Default for WebviewSettings {
    fn default() -> Self {
        Self { enabled: false, extreme: false, cpu_cores: 1, background_cpu_cores: 1,
            background_memory_mb: 128, max_fps: 15, suspend_after_seconds: 5 }
    }
}

impl WebviewSettings {
    pub fn validate(&self) -> AppResult<()> {
        let ranges = [
            ("cpuCores", self.cpu_cores, 1, 64),
            ("backgroundCpuCores", self.background_cpu_cores, 1, 64),
            ("backgroundMemoryMb", self.background_memory_mb, if self.extreme { 16 } else { 128 }, 16384),
            ("maxFps", self.max_fps, if self.extreme { 1 } else { 15 }, 60),
            ("suspendAfterSeconds", self.suspend_after_seconds, if self.extreme { 1 } else { 5 }, 300),
        ];
        for (key, value, min, max) in ranges {
            if !(min..=max).contains(&value) {
                return Err(AppError::InvalidInput(format!("{key} must be between {min} and {max}")));
            }
        }
        Ok(())
    }
    pub fn from_general(value: &serde_json::Value) -> Self {
        value.get("webview").cloned().and_then(|v| serde_json::from_value::<Self>(v).ok())
            .filter(|v| v.validate().is_ok()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn low_limits_require_extreme_opt_in_even_when_disabled() {
        let mut policy = WebviewSettings::default();
        assert!(policy.validate().is_ok());
        policy.background_memory_mb = 16;
        assert!(policy.validate().is_err());
        policy.extreme = true;
        policy.cpu_cores = 1;
        policy.max_fps = 1;
        policy.suspend_after_seconds = 1;
        assert!(policy.validate().is_ok());
        policy.cpu_cores = 0;
        assert!(policy.validate().is_err());
    }
    #[test]
    fn invalid_saved_settings_do_not_apply_on_startup() {
        assert_eq!(WebviewSettings::from_general(&serde_json::json!({"webview": {"enabled":true}})), WebviewSettings::default());
        let policy = WebviewSettings::default();
        assert_eq!(WebviewSettings::from_general(&serde_json::json!({"webview":policy})), policy);
    }
}
