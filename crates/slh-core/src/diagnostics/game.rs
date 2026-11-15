//! Local, bounded launch-log rules. A match is evidence of a category, never proof
//! that a particular mod is at fault. This module performs no repairs.
use serde::{Deserialize, Serialize};
use std::{io::{Read, Seek, SeekFrom}, path::Path};

const LOG_BYTES: u64 = 48 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameDiagnosis {
    pub kind: String,
    pub evidence: Vec<String>,
}

pub fn diagnose_game_log(log: &str) -> GameDiagnosis {
    // Specific failures precede general loader failures. Exit codes alone are
    // deliberately not an input: code 1 does not identify a cause.
    let rules: &[(&str, &[&str])] = &[
        ("jvmArguments", &["multipleargumentsforoptionexception", "unrecognized vm option", "unrecognized option:", "improperly specified vm option"]),
        ("java", &["unsupportedclassversionerror", "compiled by a more recent version of the java runtime"]),
        ("memory", &["outofmemoryerror", "could not reserve enough space", "there is insufficient memory for the java runtime environment to continue", "native memory allocation (malloc) failed"]),
        ("duplicateMods", &["duplicate mods found", "duplicate mod id", "duplicatemodsfoundexception"]),
        ("dependencies", &["which is missing!", "which is missing", "requires mods that are missing", "missing mandatory dependencies", "missing or unsupported mandatory dependencies"]),
        ("graphics", &["glfw error", "failed to create window", "wgl: the driver does not appear to support opengl", "pixel format not accelerated"]),
        ("mods", &["incompatible mods found", "modresolutionexception", "mod resolution failed", "mixin apply failed", "mixinapplyerror", "mixintransformererror", "invalidinjectionexception"]),
    ];
    let log = crate::security::redact_diagnostic(log);
    for (kind, needles) in rules {
        let mut evidence = Vec::new();
        for line in log.lines() {
            let lower = line.to_ascii_lowercase();
            if needles.iter().any(|needle| lower.contains(needle)) {
                let line: String = line.trim().chars().take(400).collect();
                if !evidence.contains(&line) { evidence.push(line); }
                if evidence.len() == 5 { break; }
            }
        }
        if !evidence.is_empty() {
            return GameDiagnosis { kind: (*kind).into(), evidence };
        }
    }
    GameDiagnosis { kind: "unknown".into(), evidence: vec![] }
}

/// Read only this launch's captured stdout/stderr. Never inspect arbitrary
/// crash-report paths mentioned by mods or reuse a previous launch's report.
pub async fn diagnose_game_log_file(path: &Path) -> GameDiagnosis {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let read = || -> std::io::Result<String> {
            let mut file = std::fs::File::open(path)?;
            let start = file.metadata()?.len().saturating_sub(LOG_BYTES);
            file.seek(SeekFrom::Start(start))?;
            let mut bytes = Vec::new();
            file.take(LOG_BYTES).read_to_end(&mut bytes)?;
            let bytes = if start > 0 {
                bytes.iter().position(|byte| *byte == b'\n').map_or(&[][..], |index| &bytes[index + 1..])
            } else { &bytes };
            Ok(String::from_utf8_lossy(bytes).into_owned())
        };
        diagnose_game_log(&read().unwrap_or_default())
    }).await.unwrap_or_else(|_| diagnose_game_log(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specific_causes_win_over_generic_loader_failure() {
        assert_eq!(diagnose_game_log("Incompatible mods found!\njava.lang.UnsupportedClassVersionError: mod\n").kind, "java");
        assert_eq!(diagnose_game_log("Incompatible mods found!\nMod 'Example' requires version 1 of fabric-api, which is missing!\n").kind, "dependencies");
        assert_eq!(diagnose_game_log("joptsimple.MultipleArgumentsForOptionException: gameDir").kind, "jvmArguments");
        assert_eq!(diagnose_game_log("Exit code: 1\nLoaded 200 mods\nGLFW initialized successfully").kind, "unknown");
    }

    #[test]
    fn known_categories_and_unknown_have_no_invented_mod_culprit() {
        for (log, kind) in [
            ("java.lang.OutOfMemoryError: Java heap space", "memory"),
            ("Duplicate mods found", "duplicateMods"),
            ("GLFW error 65542: WGL: The driver does not appear to support OpenGL", "graphics"),
            ("Mixin apply failed example.mixins.json", "mods"),
            ("Unrecognized VM option 'BadOption'", "jvmArguments"),
            ("", "unknown"),
        ] { assert_eq!(diagnose_game_log(log).kind, kind); }
    }

    #[test]
    fn evidence_is_redacted_before_truncation_and_bounded_by_characters() {
        let log = format!("OutOfMemoryError --accessToken secret-token {}\n", "я".repeat(1000)).repeat(20);
        let result = diagnose_game_log(&log);
        assert_eq!(result.evidence.len(), 1);
        assert!(!result.evidence[0].contains("secret-token"));
        assert!(result.evidence[0].chars().count() <= 400);
    }

    #[tokio::test]
    async fn reads_current_tail_and_handles_unreadable_logs() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("launch.log");
        assert_eq!(diagnose_game_log_file(&path).await.kind, "unknown");
        std::fs::write(&path, format!("UnsupportedClassVersionError\n{}\nOutOfMemoryError\n", "x".repeat(60 * 1024))).unwrap();
        assert_eq!(diagnose_game_log_file(&path).await.kind, "memory");
    }
}
