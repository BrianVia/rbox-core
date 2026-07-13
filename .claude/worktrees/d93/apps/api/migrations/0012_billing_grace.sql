-- Design 13: downgrade grace period. On a paid→free transition we stamp
-- grace_until = now + 30d; while it's in the future, retention does NOT prune
-- (all version history is preserved). NULL = no grace (free-from-start accounts).
-- Only consulted when plan='free'; ignored while paying.
ALTER TABLE accounts ADD COLUMN grace_until INTEGER;
