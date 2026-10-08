use std::path::{Component, Path};

use regex::Regex;

use crate::error::{AppError, AppResult};

pub fn validate_relative_path(path: &Path) -> AppResult<()> {
    // Imported archives and sync manifests can come from another OS. Recognize
    // Windows roots and separators even when the host's Path parser is Unix.
    let text = path.to_string_lossy();
    let bytes = text.as_bytes();
    let drive_prefix = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if path.as_os_str().is_empty() || path.is_absolute() || text.starts_with('\\') || drive_prefix {
        return Err(AppError::Security(
            "Path must be a non-empty relative path".into(),
        ));
    }
    if text.split(['/', '\\']).any(|part| matches!(part, "." | "..")) {
        return Err(AppError::Security(format!("Unsafe path component in {}", path.display())));
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(AppError::Security(format!(
                "Unsafe path component in {}",
                path.display()
            )));
        }
    }
    Ok(())
}

pub fn redact_secrets(input: &str) -> String {
    static PATTERNS: std::sync::OnceLock<[Regex; 2]> = std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| [
        r"(?i)(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]+",
        r#"(?i)(access_token|refresh_token|client_secret|password|auth_code|api_key|x-api-key)(\"?\s*[:=]\s*\"?)[^\s\",&]+"#,
    ].map(|pattern| Regex::new(pattern).expect("redaction regex is valid")));
    patterns.iter().fold(input.to_owned(), |text, pattern| {
        pattern.replace_all(&text, "${1}${2}[REDACTED]")
            .into_owned()
    })
}

#[cfg(windows)]
pub fn encrypt_for_current_user(plain: &[u8]) -> AppResult<Vec<u8>> {
    dpapi::protect(plain)
}

#[cfg(windows)]
pub fn decrypt_for_current_user(cipher: &[u8]) -> AppResult<Vec<u8>> {
    dpapi::unprotect(cipher)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn encrypt_for_current_user(plain: &[u8]) -> AppResult<Vec<u8>> {
    let identity = uuid::Uuid::new_v4().to_string();
    let entry = keyring::Entry::new("org.smilelauncher.SLH", &identity)
        .map_err(|e| AppError::Unavailable(format!("Credential store: {e}")))?;
    entry
        .set_secret(plain)
        .map_err(|e| AppError::Unavailable(format!("Credential store: {e}")))?;
    // Only an opaque reference is stored in the account file. No plaintext fallback.
    Ok(format!("SLH-KEYRING-v1:{identity}").into_bytes())
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn decrypt_for_current_user(cipher: &[u8]) -> AppResult<Vec<u8>> {
    let reference = std::str::from_utf8(cipher)
        .ok()
        .and_then(|v| v.strip_prefix("SLH-KEYRING-v1:"))
        .ok_or_else(|| {
            AppError::Security("Credential belongs to another platform; sign in again".into())
        })?;
    let identity = uuid::Uuid::parse_str(reference)
        .map_err(|_| AppError::Security("Invalid credential reference".into()))?;
    keyring::Entry::new("org.smilelauncher.SLH", &identity.to_string())
        .and_then(|entry| entry.get_secret())
        .map_err(|e| AppError::Unavailable(format!("Credential store: {e}")))
}
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub fn encrypt_for_current_user(_plain: &[u8]) -> AppResult<Vec<u8>> {
    Err(AppError::Unavailable(
        "No secure credential store on this platform".into(),
    ))
}
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub fn decrypt_for_current_user(_cipher: &[u8]) -> AppResult<Vec<u8>> {
    Err(AppError::Unavailable(
        "No secure credential store on this platform".into(),
    ))
}

#[cfg(windows)]
mod dpapi {
    use std::ffi::{OsStr, c_void};
    use std::os::windows::ffi::OsStrExt;

    use crate::error::{AppError, AppResult};

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            data_in: *const DataBlob,
            description: *const u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            data_in: *const DataBlob,
            description: *mut *mut u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn GetLastError() -> u32;
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    pub fn protect(input: &[u8]) -> AppResult<Vec<u8>> {
        transform(input, true)
    }

    pub fn unprotect(input: &[u8]) -> AppResult<Vec<u8>> {
        transform(input, false)
    }

    fn transform(input: &[u8], protect: bool) -> AppResult<Vec<u8>> {
        if input.len() > u32::MAX as usize {
            return Err(AppError::Security("Secret payload is too large".into()));
        }
        let mut owned = input.to_vec();
        let input_blob = DataBlob {
            cb_data: owned.len() as u32,
            pb_data: owned.as_mut_ptr(),
        };
        let mut output_blob = DataBlob {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };
        let description: Vec<u16> = OsStr::new("SLH protected secret")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let result = unsafe {
            if protect {
                CryptProtectData(
                    &input_blob,
                    description.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output_blob,
                )
            } else {
                CryptUnprotectData(
                    &input_blob,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output_blob,
                )
            }
        };
        if result == 0 {
            let code = unsafe { GetLastError() };
            return Err(AppError::Security(format!(
                "Windows DPAPI failed with code {code}"
            )));
        }
        let output = unsafe {
            std::slice::from_raw_parts(output_blob.pb_data, output_blob.cb_data as usize).to_vec()
        };
        unsafe {
            LocalFree(output_blob.pb_data.cast());
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        assert!(validate_relative_path(Path::new("mods/config.json")).is_ok());
        assert!(validate_relative_path(Path::new("../secret.txt")).is_err());
        assert!(validate_relative_path(Path::new(r"C:\Windows\System32")).is_err());
        assert!(validate_relative_path(Path::new(r"C:relative.txt")).is_err());
        assert!(validate_relative_path(Path::new(r"\\server\share\file")).is_err());
        assert!(validate_relative_path(Path::new(r"mods\..\secret.txt")).is_err());
        assert!(validate_relative_path(Path::new("/etc/passwd")).is_err());
    }

    #[test]
    fn redacts_common_secret_shapes() {
        let text = "Authorization: Bearer abc.def access_token=secret password=hello";
        let redacted = redact_secrets(text);
        assert!(!redacted.contains("abc.def"));
        assert!(!redacted.contains("secret"));
        assert!(!redacted.contains("hello"));
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip() {
        let cipher = encrypt_for_current_user(b"slh-token").unwrap();
        assert_ne!(cipher, b"slh-token");
        assert_eq!(decrypt_for_current_user(&cipher).unwrap(), b"slh-token");
    }
}

pub fn delete_credential_reference(cipher: &[u8]) -> AppResult<()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let Some(reference) = std::str::from_utf8(cipher)
            .ok()
            .and_then(|v| v.strip_prefix("SLH-KEYRING-v1:"))
        else {
            return Ok(());
        };
        let identity = uuid::Uuid::parse_str(reference)
            .map_err(|_| AppError::Security("Invalid credential reference".into()))?;
        match keyring::Entry::new("org.smilelauncher.SLH", &identity.to_string())
            .and_then(|entry| entry.delete_credential())
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Unavailable(format!("Credential store: {e}"))),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = cipher;
        Ok(())
    }
}
