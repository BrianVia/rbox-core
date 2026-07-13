-- Design 22 (slice 1) — the `/devices` dashboard surface.
--
-- Two covering indexes for the new account-scoped, keyset-paginated list endpoints
-- (`GET /v1/account/devices|workspaces`). Both order by `created_at` within an
-- account, so the leading column is `account_id` and the range column trails it.
--
-- For devices the gate also filters on `expires_at` (durable `IS NULL` vs a live
-- web session), so `expires_at` sits 2nd — that makes `expires_at IS NULL` a clean
-- index seek rather than a residual predicate after the account scan.
--
-- NB: never name `rowid` as an index column (SQLite errors `no such column:
-- rowid`); the implicit rowid tiebreaker rides along with the primary key for free.
CREATE INDEX IF NOT EXISTS idx_devices_account_exp_created ON devices (account_id, expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_workspaces_account_created ON workspaces (account_id, created_at);
