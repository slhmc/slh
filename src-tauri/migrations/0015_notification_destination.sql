UPDATE settings
SET value_json = json_set(value_json, '$.destination', 'launcher')
WHERE key = 'notifications'
  AND json_extract(value_json, '$.destination') IS NULL;
