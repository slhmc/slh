CREATE TABLE IF NOT EXISTS installed_content (
    instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    project_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    project_type TEXT NOT NULL,
    display_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_sha1 TEXT NOT NULL,
    installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY(instance_id, provider, project_id)
);

CREATE INDEX IF NOT EXISTS idx_installed_content_file
ON installed_content(instance_id, file_path);
