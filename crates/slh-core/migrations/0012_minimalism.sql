-- Keep the appearance option backward-compatible for databases created before
-- the minimalism toggle existed. SQLite stores the setting as JSON, so the
-- launcher can add the boolean without changing the settings table shape.
UPDATE settings
SET value_json = json_set(
    value_json,
    '$.minimalism',
    COALESCE(json_extract(value_json, '$.minimalism'), 0)
)
WHERE key = 'appearance';
