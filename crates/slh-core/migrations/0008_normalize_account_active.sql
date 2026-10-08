-- Some early portable builds stored the active marker in a non-canonical
-- SQLite representation. Keep at most one active account while preserving
-- the first account that was already marked active.
UPDATE accounts
SET active = CASE
    WHEN id = (
        SELECT id
        FROM accounts
        WHERE LOWER(TRIM(CAST(active AS TEXT))) IN ('1', 'true', 'yes', 'on')
        ORDER BY created_at ASC, id ASC
        LIMIT 1
    ) THEN 1
    ELSE 0
END;

-- A database with accounts but no marker should still have a selectable
-- identity after upgrading.
UPDATE accounts
SET active = 1
WHERE id = (
    SELECT id FROM accounts ORDER BY created_at ASC, id ASC LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM accounts WHERE active = 1);
