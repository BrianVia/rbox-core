# Design 117 — Account identity in CLI banners and status

## Goal

Implement `SPEC.md` without adding network work to the bare-command or enrolled
setup paths. The authenticated account-status response becomes the sole source of
the verified email and sign-in method; successful explicit status fetches refresh a
small non-secret local display cache.

## Server contract

`GET /v1/account/status` continues to read `clerk_users` from the directory plane
and `accounts.plan` from the account-data plane. Its existing `clerk_users` point
read also selects `email`, and the JSON response always includes
`email: row?.email ?? null`. There is no Clerk request, schema change, migration,
or logging. Worker tests pin a linked row's cached email and the unlinked `null`
case.

## Local profile cache

Add `src/cli/account-profile.ts`, following `update-check.ts`'s local-state pattern:

```ts
interface AccountProfile {
  accountId: string;
  email: string | null;
  signInMethod: string | null;
  updatedAt: number;
}
```

The path is `~/.rbox/account-profile.json`, using the same `RBOX_HOME || homeDir()`
base convention as the update-check cache. Reads catch missing-file, I/O, JSON, and
shape errors and return `undefined`. A read for an expected account id also returns
`undefined` when the stored id differs. Writes create the directory with mode 0700,
write the file with mode 0600, and re-chmod best-effort. One exported scheduler
serializes writes on a module-local promise chain and absorbs I/O failures. Callers
enqueue but do not await the write, so cache I/O cannot delay or change a successful
network result. A flush seam makes completion deterministic in tests. Clear is
ordered after all earlier queued writes, then removes the file, so a write already
started in the same process cannot recreate PII after logout; it remains
missing-file tolerant. Logout clears credentials and awaits that ordered clear.

Both `fetchAccountSummary` and `accountStatus` normalize the successful response to
the extended account-status shape and invoke the one exported profile scheduler with
the response account id, nullable email/method, and current time. Older APIs with
an absent email or method are cached as null. Failed fetches never modify the cache.

`identityLabel(accountId)` performs only the validated, account-keyed cache read. It
returns `undefined` without a non-empty cached email; otherwise it returns the email
in stderr cyan followed, when present, by the method in dim parentheses. Shape
validation requires a non-empty account id, nullable non-empty email/method strings,
a finite timestamp, and rejects terminal control characters before anything is
rendered. It never loads credentials and never performs network I/O.

## Rendering

`AccountStatus` gains `email?: string | null`. Text `rbox account status` and the
ACCOUNT formatter retain their existing account-id, plan, and linked information,
and add `signed in as: <email> (<method>)` when email is present. The existing
method-only line remains the fallback when a method exists without an email. JSON
includes `email` when non-null and omits null/absent values, matching the existing
optional sign-in-method convention. Tests pin cyan to only the email and dim to only
the optional parenthesized method when color is forced.

`runUntrackedMenu` accepts an injectable identity lookup. It awaits that local-only
lookup before writing either the exact current id banner or
`Signed in as <label>. This directory isn't tracked yet.` The enrolled setup notice
uses a small exported writer with injectable lookup/output, producing either
`Signed in as <label> — skipping account setup.` or the exact current id notice.
This seam tests both variants without filesystem or network access.

## Tests and validation

- Worker coverage: linked cached email and unlinked null.
- Account-profile coverage: successful-fetch write, failed-fetch no-write,
  mismatched id, corrupt/control-character file, nullable/missing label matrix,
  permissions/shape as appropriate, and ordered logout clear (both profile and
  credentials, including an already-missing cache).
- CLI render coverage: account text/JSON/ACCOUNT email plus method, and both banner
  variants through injected dependencies.
- Run natively: `bun test ./src/cli/`, `cd apps/api && npx vitest run`, and
  `bun run typecheck`.

Every cache-writing CLI test, including pre-existing account-status and JSON tests,
sets a temporary `RBOX_HOME`, flushes scheduled writes before teardown, and removes
the temporary tree. This prevents tests from touching the developer's real profile.

No module under the sync-engine ownership trees changes, so `docs/CODEMAP.md` does
not require an update.
