# Diagnostics — `rbox doctor` and the opt-in support report

Design 56 §10 P3. Two codex design rounds (5 BLOCKERs closed) + adversarial impl
review. The support flow this replaces: eyeballing files under
`~/.rbox/daemons/<key>/` and pasting chunks into Slack.

## For users

### Local health check (always available; no diagnostic data leaves the machine)

```
rbox doctor
```

✓/✗ checklist with fix-it hints, exit 1 on any ✗: credentials, E2EE enrollment
and device identity, daemon state, remote reachability, version and local
sync-state sanity, crypto workers, workspace locking, the functional Git
transaction capability, and manifest-chain health.

### Support report (ships OFF — double opt-in)

The upload capability is **disabled by default** in distributed builds. Enabling
it is the first opt-in; every upload still requires a second, per-upload consent.

```
rbox doctor --report --diagnostics        # enable for this invocation
RBOX_DIAGNOSTICS=1 rbox doctor --report   # or via env
```

Without the flag/env, `--report` refuses before workspace resolution and before
any diagnostic data leaves the machine:

> diagnostics upload is off by default; re-run with --diagnostics (or set
> RBOX_DIAGNOSTICS=1) to enable for this invocation

(A `diagnostics:` key in `rbox.yml` is reserved as a third enablement path for
when design 51 ships.)

**What the report contains** (JSON, client-capped ≤ 512 KiB): rbox/bun version +
platform, the doctor checklist results, bounded tails merged from this workspace's
daily operational log, concurrent crash sink, and any legacy in-workspace source,
whitelisted counts-only sync counters (`metrics.json`, including
the integer `lockStarved` episode count), daemon heartbeat/halt state
(`activity.json`), and workspace shape (file count + total bytes). Never file
contents, lock markers, UUIDs, holder keys, tokens, or the private starvation
episode record. Git-family log lines are reduced to closed reason classes;
lock warnings are accepted only in the exact closed form `lock starved:
reason=<foreign|identity-drift|stale-owned|fence> age=<15m|1h|1d>`. Forged
prefixes, controls, paths, credential URLs, and raw error details are dropped.
Other non-Git daemon records can still contain relative operational paths or
error text, which is why the full preview and per-upload consent remain
mandatory.

**Consent flow**: the CLI prints the ENTIRE bundle verbatim plus a plain-language
notice (stored **unencrypted**, 30-day auto-delete) and asks before uploading.
Non-interactive callers must pass `--yes`, and in that mode the preview is
written to a 0600 file under `~/.rbox` (path printed) instead of being dumped
into CI logs. If the workspace's daemon binding is stale (bound to a previous
workspace), the entire daemon-owned section — log tail, activity, metrics — is
excluded so a report can never carry another workspace's data.

Success prints the report id + auto-delete date.

## For the operator

- **Index**: D1 table `diagnostics_reports` (migration `0020_diagnostics.sql`) —
  `id, account_id, device_id, created_at, status (pending|stored), r2_key,
  bytes, sha256`. Recent reports:

  ```
  cd apps/api && bunx wrangler d1 execute rbox-prod-db --remote \
    --command "SELECT id, account_id, created_at, status, bytes FROM diagnostics_reports ORDER BY created_at DESC LIMIT 10"
  ```

- **Payload**: R2 at `diagnostics/<accountId>/<reportId>.json` in the blobs
  bucket (outside the content-addressed `blobs/` prefix; never enters blob_refs
  or GC accounting):

  ```
  bunx wrangler r2 object get "rbox-prod-blobs/diagnostics/<accountId>/<reportId>.json" --remote --file report.json
  ```

  (Dev: `rbox-dev-db` / `rbox-dev-blobs`.)

- **Server contract**: `POST /v1/diagnostics`, device principals only (web
  session tokens → 403), 600 KiB body cap (413), strict top-level + nested key
  allowlist (400 `bad_shape`). The legacy six checks remain required;
  `device`, `crypto`, `locking`, `git`, and `chain` are optional for backward
  compatibility, and `lockStarved` is the only new metric key. **5 reports per
  account per rolling 24h** (429,
  enforced atomically; a failed R2 write releases its quota slot).

- **Lifecycle**: rows are written pending-first, then the R2 object, then marked
  `stored` — orphans in either direction are reaped by the hourly cron sweep
  (expired reports after 30 days; stale `pending` rows after 1h; LIMIT 200/tick
  with an AE metric for backlog). Account deletion (design 37) purges the
  account's reports (R2-delete before row-delete, retried) before `finishD1`.

## In the test bench

The rig (design 56) runs every device with `RBOX_DIAGNOSTICS=1` so the exact
user-facing report path is exercised continuously against the dev worker while
the shipped default stays off — dev coverage without touching user privacy.
