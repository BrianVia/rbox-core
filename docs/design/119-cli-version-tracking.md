# Design 119 — Last-seen CLI version per device

## Goal

Implement the locked `SPEC.md` contract as additive metadata: every request made
through `RemoteContext` identifies the running CLI version, authenticated device
rows retain only a strictly validated version, and device-list surfaces expose it.
Old clients remain compatible and a missing version header never erases a version
previously observed from another process sharing the device token.

## Client transport

`src/cli/version.ts` exports `rboxVersion()`, returning the same resolved
`RBOX_VERSION` used by existing version surfaces. `RemoteContext.auth` adds
`x-rbox-version: rboxVersion()`. Every other authenticated header builder derives
from `auth` (`protoAuth`, `authDownload`, and `batchPutAuth`), so ordinary,
receipt-protocol, download-grant, upload-grant, and refresh requests carry the
header without an additional request or conditional branch.

Tests pin the header on both the base auth and protocol-auth paths so a future
header-builder split cannot silently drop it.

## Storage and authentication write policy

Migration `apps/api/migrations/0026_device_last_seen_version.sql` contains only:

```sql
ALTER TABLE devices ADD COLUMN last_seen_version TEXT;
```

`authenticate()` selects the nullable column with the existing device row. Header
classification has three states:

- missing: do not change `last_seen_version`;
- valid: length at most 48 and exact match for
  `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.+-]{0,32})?$`; store the original value;
- present but invalid: use `NULL`, never attacker-controlled bytes.

The existing best-effort update runs when `last_seen_at` is absent/stale, or when a
present header's normalized value differs from the stored value. The one statement
always refreshes `last_seen_at`; it assigns `last_seen_version` only for a present
header (using a SQL `CASE` flag), preserving the stored value for old clients. This
gives immediate upgrade/malformed-header visibility while retaining the ten-minute
write throttle for an unchanged value. Authentication success remains independent
of the best-effort metadata write.

API tests cover a first valid version, an unchanged value inside the throttle,
immediate valid-version change, malformed/overlong values becoming `NULL`, and a
missing header preserving the prior value.

## Read surfaces

Both existing device-row JSON contracts gain the additive nullable camel-case
field `lastSeenVersion`:

- `GET /v1/auth/devices`, consumed by `rbox device list`;
- `GET /v1/account/devices`, consumed by the authenticated web/admin device list.

The platform `GET /v1/admin/overview` route currently returns aggregates only and
has no account/device rows to extend; no unrelated cross-account row listing is
invented. The account device-list route is the repository's existing administrative
device-row surface. Route tests pin the new field and continue to ensure internal
columns and other accounts do not leak.

`rbox device list --json` maps the server field to `lastSeenVersion`. Text output
adds a version column/value after the existing label and renders the Unicode em dash
`—` when the field is null or absent, retaining compatibility with older servers.
CLI tests cover known and unknown versions in text plus the additive JSON field.

## Ownership and deployment

`src/cli/remote/context.ts` retains its existing transport ownership, so
`docs/CODEMAP.md` does not change. Migration 0026 is additive and nullable; it will
auto-apply before the production Worker deploy according to `docs/DEPLOYMENTS.md`.
No deployment is performed in this worktree.

## Acceptance

Run natively and require green results:

1. `bun test ./src/cli/`
2. `cd apps/api && npx vitest run`
3. `bun run typecheck`

Then inspect the diff for unnecessary duplication and scope. Do not commit.
