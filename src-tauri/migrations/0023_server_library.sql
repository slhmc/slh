CREATE TABLE server_collections (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES server_collections(id),
 source_path TEXT UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0, collapsed INTEGER NOT NULL DEFAULT 0,
 deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE server_library_entries (
 server_id TEXT PRIMARY KEY REFERENCES local_servers(id), collection_id TEXT REFERENCES server_collections(id),
 manual_group INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
 origin TEXT NOT NULL DEFAULT 'created', readiness TEXT NOT NULL DEFAULT 'ready', note TEXT,
 icon_json TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO server_collections(id,name,parent_id,source_path) SELECT id,name,parent_id,path FROM local_server_groups;
INSERT INTO server_library_entries(server_id,collection_id) SELECT id,group_id FROM local_servers;
INSERT OR IGNORE INTO settings(key,value_json) VALUES ('serverLibrary','{}');
