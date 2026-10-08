ALTER TABLE accounts
    ADD COLUMN xbox_xuid TEXT;

CREATE INDEX IF NOT EXISTS idx_accounts_xbox_xuid
    ON accounts(xbox_xuid)
    WHERE xbox_xuid IS NOT NULL;
