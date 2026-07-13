-- M10/billing: link accounts to their Stripe customer + subscription so the
-- webhook can keep accounts.plan authoritative and the portal can target the
-- right customer. Nullable — accounts without a paid sub stay 'free'.

ALTER TABLE accounts ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE accounts ADD COLUMN stripe_subscription_id TEXT;

-- Idempotency: remember processed webhook event ids so Stripe re-deliveries are
-- no-ops (events can arrive more than once).
CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,   -- Stripe event id (evt_…)
  type        TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
