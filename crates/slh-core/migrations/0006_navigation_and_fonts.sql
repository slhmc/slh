UPDATE settings
SET value_json = json_set(
    value_json,
    '$.fontFamily', COALESCE(json_extract(value_json, '$.fontFamily'), 'pixeloid'),
    '$.customFontPath', COALESCE(json_extract(value_json, '$.customFontPath'), NULL)
)
WHERE key = 'appearance';

UPDATE settings
SET value_json = json_set(
    value_json,
    '$.visibleNavigation', COALESCE(
        json_extract(value_json, '$.visibleNavigation'),
        json('["home","library","discover","mods","servers","settings"]')
    )
)
WHERE key = 'general';
