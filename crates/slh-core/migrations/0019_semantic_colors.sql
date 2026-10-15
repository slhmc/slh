-- Only stock palettes gain explicit defaults. Custom colors remain derived until saved.
UPDATE settings SET value_json = json_set(value_json,
 '$.success', coalesce(json_extract(value_json,'$.success'), '#78c48c'),
 '$.warning', coalesce(json_extract(value_json,'$.warning'), '#e6b85c'),
 '$.error', coalesce(json_extract(value_json,'$.error'), '#f08078'),
 '$.info', coalesce(json_extract(value_json,'$.info'), '#9bc8ff'))
WHERE key='appearance' AND json_extract(value_json,'$.activePresetId')='slh-orange'
 AND json_extract(value_json,'$.background')='#1f2226' AND json_extract(value_json,'$.accent')='#cd491e';
UPDATE settings SET value_json = json_set(value_json,
 '$.success', coalesce(json_extract(value_json,'$.success'), '#28703d'),
 '$.warning', coalesce(json_extract(value_json,'$.warning'), '#805800'),
 '$.error', coalesce(json_extract(value_json,'$.error'), '#ae302a'),
 '$.info', coalesce(json_extract(value_json,'$.info'), '#2869a4'))
WHERE key='appearance' AND json_extract(value_json,'$.activePresetId')='light'
 AND json_extract(value_json,'$.background')='#ffffff' AND json_extract(value_json,'$.accent')='#d44b1e';
