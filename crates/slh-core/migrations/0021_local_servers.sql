CREATE TABLE local_server_groups (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    parent_id TEXT REFERENCES local_server_groups(id), data_relative TEXT
);
CREATE TABLE local_servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    group_id TEXT REFERENCES local_server_groups(id), data_relative TEXT,
    config_json TEXT NOT NULL, plan_json TEXT, status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE managed_artifacts (
    path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, source TEXT NOT NULL,
    owner_id TEXT, completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO settings(key,value_json) VALUES ('servers','{}');
UPDATE settings SET value_json=json_insert(value_json,'$.visibleNavigation[#]','localServers')
 WHERE key='general' AND json_type(value_json,'$.visibleNavigation')='array'
 AND NOT EXISTS (SELECT 1 FROM json_each(settings.value_json,'$.visibleNavigation') WHERE value='localServers');
UPDATE settings SET value_json=json_set(value_json,'$.navigationOrder',json((
 SELECT json_group_array(value) FROM (
   SELECT value, CAST(key AS INTEGER)*2 AS position FROM json_each(settings.value_json,'$.navigationOrder')
   UNION ALL SELECT 'localServers', COALESCE((SELECT CAST(key AS INTEGER)*2+1 FROM json_each(settings.value_json,'$.navigationOrder') WHERE value='discover'),999)
   ORDER BY position
 )
))) WHERE key='general' AND json_type(value_json,'$.navigationOrder')='array'
 AND NOT EXISTS (SELECT 1 FROM json_each(settings.value_json,'$.navigationOrder') WHERE value='localServers');
UPDATE settings SET value_json=json_insert(value_json,'$.settingsNavigationVisible[#]','servers')
 WHERE key='general' AND json_type(value_json,'$.settingsNavigationVisible')='array'
 AND NOT EXISTS (SELECT 1 FROM json_each(settings.value_json,'$.settingsNavigationVisible') WHERE value='servers');
