-- Design 94: persist the web login's verified attached sign-in credentials
-- (sorted composite like 'google', 'github+password'; NULL = not yet
-- captured / none derivable — never blocks auth). Additive + nullable.
-- signin_method_updated_at = Clerk user.updated_at of the observation
-- (snapshot version: stale-writer guard + never-observed discriminator).
ALTER TABLE clerk_users ADD COLUMN signin_method TEXT;
ALTER TABLE clerk_users ADD COLUMN signin_method_updated_at INTEGER;
