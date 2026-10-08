ALTER TABLE instances ADD COLUMN last_launched_at TEXT;
UPDATE instances SET last_launched_at = (SELECT MAX(started_at) FROM launch_history WHERE instance_id = instances.id) ;
UPDATE settings SET value_json = json_set(value_json, '$.beautifulHome', json('true')) WHERE key = 'appearance' AND json_type(value_json, '$.beautifulHome') IS NULL;
