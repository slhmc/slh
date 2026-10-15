-- 0.2.0 appended Bedrock to an absent list, hiding all other sections.
-- Preserve every explicitly customized list except the known broken singleton.
UPDATE settings
SET value_json = json_set(value_json, '$.settingsNavigationVisible',
  json('["general","appearance","minecraft","java","bedrock","accounts","storage","downloads","notifications","sync","console","privacy","advanced"]'))
WHERE key = 'general'
  AND json_extract(value_json, '$.settingsNavigationVisible') = '["bedrock"]';
