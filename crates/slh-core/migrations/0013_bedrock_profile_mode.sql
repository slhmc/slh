ALTER TABLE instances
    ADD COLUMN bedrock_profile_mode TEXT NOT NULL DEFAULT 'shared'
    CHECK (bedrock_profile_mode IN ('isolated', 'shared'));

-- Existing Bedrock instances may already point at the user's live Store data.
-- Keep them shared on upgrade; new Bedrock instances explicitly choose
-- isolated in the create path.
UPDATE instances
SET bedrock_profile_mode = 'shared'
WHERE loader_type = 'bedrock';
