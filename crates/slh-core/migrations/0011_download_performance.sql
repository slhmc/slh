-- Older databases were created with a conservative six-transfer default.
-- Raise only that untouched default; an explicitly customised value remains
-- under the user's control and is still clamped by the downloader.
UPDATE settings
SET value_json = json_set(value_json, '$.concurrency', 16)
WHERE key = 'downloads'
  AND json_extract(value_json, '$.concurrency') = 6;
