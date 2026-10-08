use serde_json::{Map, Value};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

use crate::error::AppResult;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
use crate::models::{Account, Instance, InstanceGroup};
use crate::portable::PortablePaths;

// A few pre-release builds shipped migration 0001 with a different checksum
// even though the database schema was identical. SQLx quite correctly refuses
// to start when an applied migration changes, but rejecting these known legacy
// hashes would strand existing portable profiles. Keep this allowlist narrow:
// only the immutable initial migration is repaired, and only for hashes that
// were produced by SLH builds before migration files were stabilized.
const LEGACY_INITIAL_MIGRATION_CHECKSUMS: &[&str] = &[
    "07330E88D83056215B0E05D8C2DB7C4968BAC7ACB3E17BB6C66775AE764344FC45BFB45FEAE6DB8EC9DEEE450C353E4E",
    "CE903526FB9DEA4BDA9C2E6DD1669AB65ED324E123CE8A0DB70A58CE8C265ABC5A166912F1DAAFFC4E25CE043C7AABD5",
    // Databases created by the 0.1.1 development migration set used this
    // checksum before the initial SQL was finalized.
    "3E4C29665C2688240E60AC0B4BB1B57739F44A5464FC0DB36A57C53B94F37C2FEDF47F66AACBB76C8B44254BBABEEABA",
];

fn checksum_hex(checksum: &[u8]) -> String {
    checksum.iter().map(|byte| format!("{byte:02X}")).collect()
}

async fn repair_legacy_initial_migration(pool: &SqlitePool) -> AppResult<bool> {
    let Some(expected) = MIGRATOR.iter().find(|migration| migration.version == 1) else {
        return Ok(false);
    };
    let Some(actual): Option<Vec<u8>> =
        sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = 1")
            .fetch_optional(pool)
            .await?
    else {
        return Ok(false);
    };
    if actual.as_slice() == expected.checksum.as_ref() {
        return Ok(false);
    }
    let actual_hex = checksum_hex(&actual);
    if !LEGACY_INITIAL_MIGRATION_CHECKSUMS
        .iter()
        .any(|known| known.eq_ignore_ascii_case(&actual_hex))
    {
        return Ok(false);
    }

    sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = 1")
        .bind(expected.checksum.as_ref())
        .execute(pool)
        .await?;
    tracing::warn!(
        previous_checksum = %actual_hex,
        "repaired checksum for a legacy initial migration"
    );
    Ok(true)
}

pub async fn connect(paths: &PortablePaths) -> AppResult<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(paths.database())
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;
    match MIGRATOR.run(&pool).await {
        Ok(()) => {}
        Err(sqlx::migrate::MigrateError::VersionMismatch(1))
            if repair_legacy_initial_migration(&pool).await? =>
        {
            MIGRATOR.run(&pool).await?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(pool)
}

pub async fn all_settings(pool: &SqlitePool) -> AppResult<Value> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, value_json FROM settings")
        .fetch_all(pool)
        .await?;
    let mut map = Map::new();
    for (key, value) in rows {
        map.insert(key, serde_json::from_str(&value)?);
    }
    Ok(Value::Object(map))
}

pub async fn setting(pool: &SqlitePool, key: &str) -> AppResult<Value> {
    let value: String = sqlx::query_scalar("SELECT value_json FROM settings WHERE key = ?")
        .bind(key)
        .fetch_one(pool)
        .await?;
    Ok(serde_json::from_str(&value)?)
}

pub async fn set_setting(pool: &SqlitePool, key: &str, value: &Value) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO settings(key, value_json) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    )
    .bind(key)
    .bind(serde_json::to_string(value)?)
    .execute(pool)
    .await?;
    Ok(())
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        return std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(0x08000000)
            .output()
            .ok()
            .is_some_and(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
            });
    }
    #[cfg(unix)]
    {
        return std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|status| status.success());
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        false
    }
}

pub async fn recover_interrupted_launches(pool: &SqlitePool) -> AppResult<Vec<(String, u32)>> {
    let now = chrono::Utc::now().to_rfc3339();
    let rows: Vec<(String, String, Option<i64>)> = sqlx::query_as(
        "SELECT instance_id, id, process_id FROM launch_history \
         WHERE result = 'running' AND ended_at IS NULL ORDER BY started_at DESC",
    )
    .fetch_all(pool)
    .await?;
    let mut active = std::collections::HashMap::<String, (String, u32)>::new();
    for (instance_id, launch_id, process_id) in rows {
        let Some(process_id) = process_id.and_then(|value| u32::try_from(value).ok()) else {
            continue;
        };
        if !active.contains_key(&instance_id) && process_is_alive(process_id) {
            active.insert(instance_id, (launch_id, process_id));
        }
    }
    sqlx::query("UPDATE instances SET status = 'installed' WHERE status = 'running'")
        .execute(pool)
        .await?;
    sqlx::query(
        "UPDATE launch_history SET ended_at = ?, result = 'interrupted' \
         WHERE result = 'running' AND ended_at IS NULL",
    )
    .bind(now)
    .execute(pool)
    .await?;
    for (instance_id, (launch_id, _)) in &active {
        sqlx::query("UPDATE instances SET status = 'running' WHERE id = ?")
            .bind(instance_id)
            .execute(pool)
            .await?;
        sqlx::query("UPDATE launch_history SET ended_at = NULL, result = 'running' WHERE id = ?")
            .bind(launch_id)
            .execute(pool)
            .await?;
    }
    Ok(active
        .into_iter()
        .map(|(instance_id, (_, pid))| (instance_id, pid))
        .collect())
}

/// Installation work runs inside the SLH process. If Windows terminates that
/// process while a package is downloading or being registered, there is no
/// worker left that can finish the operation or move the row to `error`.
/// Reset those orphaned claims on the next startup so the instance can be
/// repaired or deleted normally.
pub async fn recover_interrupted_installations(pool: &SqlitePool) -> AppResult<u64> {
    let affected =
        sqlx::query("UPDATE instances SET status = 'created' WHERE status = 'installing'")
            .execute(pool)
            .await?
            .rows_affected();
    if affected > 0 {
        tracing::warn!(
            count = affected,
            "reset interrupted Minecraft installations"
        );
    }
    Ok(affected)
}

pub async fn groups(pool: &SqlitePool) -> AppResult<Vec<InstanceGroup>> {
    Ok(sqlx::query_as::<_, InstanceGroup>(
        "SELECT id, name, sort_order, collapsed, created_at FROM groups ORDER BY sort_order, name",
    )
    .fetch_all(pool)
    .await?)
}

pub async fn instances(pool: &SqlitePool) -> AppResult<Vec<Instance>> {
    Ok(sqlx::query_as::<_, Instance>(
        "SELECT id, name, group_id, icon_path, folder_name, icon_key, icon_background, icon_foreground, \
         minecraft_version, loader_type, loader_version, \
         status, created_at, last_played_at, last_launched_at, playtime_seconds, java_path, memory_min_mb, \
         memory_max_mb, game_dir, config_schema_version, bedrock_profile_mode FROM instances ORDER BY name COLLATE NOCASE ASC, id ASC",
    )
    .fetch_all(pool)
    .await?)
}

pub async fn accounts(pool: &SqlitePool) -> AppResult<Vec<Account>> {
    Ok(sqlx::query_as::<_, Account>(
        "SELECT id, provider, provider_uuid, xbox_xuid, username, avatar_cache_path, auth_status, \
         last_auth_at, active, created_at FROM accounts ORDER BY created_at ASC, id ASC",
    )
    .fetch_all(pool)
    .await?)
}

pub async fn instance(pool: &SqlitePool, id: &str) -> AppResult<Instance> {
    Ok(sqlx::query_as::<_, Instance>(
        "SELECT id, name, group_id, icon_path, folder_name, icon_key, icon_background, icon_foreground, \
         minecraft_version, loader_type, loader_version, \
         status, created_at, last_played_at, last_launched_at, playtime_seconds, java_path, memory_min_mb, \
         memory_max_mb, game_dir, config_schema_version, bedrock_profile_mode FROM instances WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await?)
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn beautiful_home_migrates_legacy_history_without_changing_existing_preferences() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for migration in super::MIGRATOR
            .iter()
            .filter(|migration| migration.version < 18)
        {
            sqlx::raw_sql(migration.sql.clone())
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO instances(id,name,minecraft_version,game_dir,folder_name) VALUES ('java','Java','26.2','java','java'), ('bedrock','Bedrock','1.26','bedrock','bedrock')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO launch_history(id,instance_id,started_at,result,log_path) VALUES ('a','java','2026-10-01T10:00:00Z','success',''), ('b','bedrock','2026-10-01T12:00:00Z','running','')").execute(&pool).await.unwrap();
        sqlx::query("UPDATE settings SET value_json = json_set(value_json,'$.beautifulHome',json('false')) WHERE key='appearance'").execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../migrations/0018_beautiful_home.sql"))
            .execute(&pool)
            .await
            .unwrap();
        let java = super::instance(&pool, "java").await.unwrap();
        let bedrock = super::instance(&pool, "bedrock").await.unwrap();
        assert_eq!(
            java.last_launched_at.as_deref(),
            Some("2026-10-01T10:00:00Z")
        );
        assert_eq!(
            bedrock.last_launched_at.as_deref(),
            Some("2026-10-01T12:00:00Z")
        );
        assert_eq!(
            super::setting(&pool, "appearance").await.unwrap()["beautifulHome"],
            false
        );
        assert_eq!(java.playtime_seconds, 0);
    }
    #[tokio::test]
    async fn beautiful_home_defaults_to_enabled_for_existing_settings() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        super::MIGRATOR.run(&pool).await.unwrap();
        assert_eq!(
            super::setting(&pool, "appearance").await.unwrap()["beautifulHome"],
            true
        );
    }
    #[test]
    fn immutable_initial_migration_uses_stable_lf_bytes() {
        let migration = include_bytes!("../migrations/0001_initial.sql");
        assert!(!migration.contains(&b'\r'));
        assert!(migration.ends_with(b"\n"));
    }
}

pub async fn active_account(pool: &SqlitePool) -> AppResult<Option<Account>> {
    Ok(sqlx::query_as::<_, Account>(
        "SELECT id, provider, provider_uuid, xbox_xuid, username, avatar_cache_path, auth_status, \
         last_auth_at, active, created_at FROM accounts \
         WHERE LOWER(TRIM(CAST(active AS TEXT))) IN ('1', 'true', 'yes', 'on') \
         ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?)
}
