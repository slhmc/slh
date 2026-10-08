UPDATE settings
SET value_json = json_set(value_json, '$.cardClickAction', 'summary')
WHERE key = 'bedrock' AND json_extract(value_json, '$.cardClickAction') IS NULL;
