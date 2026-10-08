INSERT OR IGNORE INTO settings(key, value_json)
VALUES ('bedrock', '{"enabled":true,"defaultProfileMode":"shared","showPreviewVersions":false}');

UPDATE settings
SET value_json = json_set(
  value_json,
  '$.settingsNavigationVisible',
  json(json_insert(COALESCE(json_extract(value_json, '$.settingsNavigationVisible'), '[]'), '$[#]', 'bedrock'))
)
WHERE key = 'general'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(value_json, '$.settingsNavigationVisible') WHERE value = 'bedrock'
  );
