UPDATE settings
SET value_json = json_set(
    value_json,
    '$.offlineFallbackWhenOffline', COALESCE(
        json_extract(value_json, '$.offlineFallbackWhenOffline'),
        json('true')
    )
)
WHERE key = 'general';
