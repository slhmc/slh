ALTER TABLE instances ADD COLUMN folder_name TEXT NOT NULL COLLATE NOCASE DEFAULT '';
ALTER TABLE instances ADD COLUMN icon_key TEXT NOT NULL DEFAULT 'cube';
ALTER TABLE instances ADD COLUMN icon_background TEXT;
ALTER TABLE instances ADD COLUMN icon_foreground TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_folder_name
ON instances(folder_name) WHERE folder_name <> '';

UPDATE settings
SET value_json = json_set(value_json, '$.scalePercent', 100)
WHERE key = 'appearance'
  AND json_extract(value_json, '$.scalePercent') IS NULL;

INSERT OR IGNORE INTO settings(key, value_json) VALUES
    ('notifications', '{"enabled":true,"maxVisible":3,"durationMs":5000,"showInfo":true,"showSuccess":true,"showErrors":true}');
