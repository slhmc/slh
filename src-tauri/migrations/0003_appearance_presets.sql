UPDATE settings
SET value_json = json_set(
    value_json,
    '$.activePresetId', 'slh-orange',
    '$.presets', json('[]')
)
WHERE key = 'appearance'
  AND json_extract(value_json, '$.activePresetId') IS NULL;
