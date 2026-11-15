use sqlx::sqlite::SqlitePoolOptions;
use slh_core::settings::remember_section;
#[tokio::test]
async fn remembers_only_valid_settings_when_enabled_and_preserves_other_preferences() {
    let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO settings(key,value_json) VALUES ('general', '{\"rememberSettingsSection\":true,\"language\":\"ru-RU\"}')").execute(&pool).await.unwrap();
    remember_section(&pool,"settings:java").await.unwrap();
    let json: String = sqlx::query_scalar("SELECT value_json FROM settings WHERE key='general'").fetch_one(&pool).await.unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["lastSettingsSection"], "java");
    assert_eq!(value["language"], "ru-RU");
    assert!(remember_section(&pool,"settings:../secret").await.is_err());
    sqlx::query("UPDATE settings SET value_json = json_set(value_json, '$.rememberSettingsSection', json('false'))").execute(&pool).await.unwrap();
    remember_section(&pool,"settings:appearance").await.unwrap();
    let saved: String = sqlx::query_scalar("SELECT json_extract(value_json, '$.lastSettingsSection') FROM settings WHERE key='general'").fetch_one(&pool).await.unwrap();
    assert_eq!(saved,"java");
}
