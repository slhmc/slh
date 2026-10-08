PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
    icon_path TEXT,
    minecraft_version TEXT NOT NULL,
    loader_type TEXT NOT NULL DEFAULT 'vanilla',
    loader_version TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_played_at TEXT,
    playtime_seconds INTEGER NOT NULL DEFAULT 0,
    java_path TEXT,
    memory_min_mb INTEGER NOT NULL DEFAULT 512,
    memory_max_mb INTEGER NOT NULL DEFAULT 4096,
    game_dir TEXT NOT NULL,
    config_schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL,
    provider_uuid TEXT NOT NULL,
    username TEXT NOT NULL,
    avatar_cache_path TEXT,
    auth_status TEXT NOT NULL,
    last_auth_at TEXT,
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(provider, provider_uuid)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_one_active
ON accounts(active) WHERE active = 1;

CREATE TABLE IF NOT EXISTS launch_history (
    id TEXT PRIMARY KEY NOT NULL,
    instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_seconds INTEGER,
    exit_code INTEGER,
    result TEXT NOT NULL,
    log_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS downloads (
    id TEXT PRIMARY KEY NOT NULL,
    source TEXT NOT NULL,
    url TEXT NOT NULL,
    destination TEXT NOT NULL,
    status TEXT NOT NULL,
    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS content_cache (
    cache_key TEXT PRIMARY KEY NOT NULL,
    source TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    etag TEXT,
    expires_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sync_mappings (
    id TEXT PRIMARY KEY NOT NULL,
    category TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_ids_json TEXT NOT NULL DEFAULT '[]',
    direction TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    source_relative_path TEXT NOT NULL,
    target_relative_path TEXT NOT NULL,
    safety_level TEXT NOT NULL,
    last_sync_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sync_snapshots (
    mapping_id TEXT NOT NULL REFERENCES sync_mappings(id) ON DELETE CASCADE,
    instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    shared_hash TEXT,
    instance_hash TEXT,
    shared_modified_at TEXT,
    instance_modified_at TEXT,
    last_direction TEXT,
    synced_at TEXT NOT NULL,
    PRIMARY KEY(mapping_id, instance_id, relative_path)
);

CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY NOT NULL,
    mapping_id TEXT REFERENCES sync_mappings(id) ON DELETE SET NULL,
    instance_id TEXT REFERENCES instances(id) ON DELETE SET NULL,
    backup_type TEXT NOT NULL,
    source_path TEXT NOT NULL,
    backup_path TEXT NOT NULL,
    size_bytes INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO settings(key, value_json) VALUES
    ('general', '{"language":"en-US","viewMode":"grid","rememberSection":true,"lastSection":"library","doubleClickLaunch":false,"closeBehavior":"ask","hideOnLaunch":false,"restoreOnExit":true}'),
    ('appearance', '{"background":"#1f2226","surface":"#292d32","surface2":"#343a40","border":"#454c54","text":"#ffffff","textMuted":"#aeb6bf","accent":"#cd491e","accentHover":"#e15828","accentPressed":"#ae3916","radius":10,"density":"comfortable"}'),
    ('minecraft', '{"javaMode":"auto","javaPath":null,"memoryMinMb":512,"memoryMaxMb":4096,"resolutionWidth":1280,"resolutionHeight":720,"jvmArgs":[]}'),
    ('downloads', '{"concurrency":6,"retries":3,"bandwidthLimitKbps":null}'),
    ('privacy', '{"telemetry":false,"crashReporting":false}'),
    ('sync', '{"backupRetention":10,"worldsEnabled":false}'),
    ('onboarding', '{"completed":false}');

