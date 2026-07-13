# D1 migrations

- Files are `NNNN_snake_case.sql`, applied in lexicographic filename order by
  `wrangler d1 migrations apply`.
- **Filenames are append-only.** wrangler records applied migrations *by
  filename* in each environment's `d1_migrations` table — renaming an applied
  file makes it look unapplied and re-runs it. Never rename; only add.
- Pick the next free number, and re-check after rebasing — number collisions
  from parallel worktrees have happened (the frozen `0014`/`0016` pairs below).
  A config-time guard in `../vitest.config.ts` fails the test suite on any new
  collision.
- Frozen legacy duplicates (applied everywhere, lexicographic order matched
  apply order, verified against prod + dev `d1_migrations` 2026-07-10 — do not
  rename): `0014_account_linking.sql` / `0014_upload_receipts.sql`,
  `0016_cap_bytes_insert_materialize.sql` / `0016_device_notifications.sql`.
- Rollouts must be non-breaking (read-before-write): additive nullable columns,
  readers tolerate missing data. See standing rules in `docs/STATUS.md`.
