-- Validation note #21: the dashboard has no way to know whether an active
-- subscription is on the monthly or annual cadence, so it always renders the
-- monthly price. Store the interval alongside `plan` so the usage endpoint
-- (and the dashboard) can show the price the account actually pays.
-- Nullable + additive (read-before-write, apps/api/migrations/README.md):
-- existing rows stay NULL and readers treat NULL as "unknown → default to
-- monthly display."
ALTER TABLE accounts ADD COLUMN billing_interval TEXT;
