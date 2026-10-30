CREATE TABLE server_content (
 server_id TEXT NOT NULL REFERENCES local_servers(id), provider TEXT NOT NULL,
 project_id TEXT NOT NULL, version_id TEXT NOT NULL, name TEXT NOT NULL,
 filename TEXT NOT NULL, sha1 TEXT NOT NULL,
 PRIMARY KEY(server_id,provider,project_id)
);
