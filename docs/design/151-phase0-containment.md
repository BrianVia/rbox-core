# 151 — Phase 0 containment: fail-closed CLI, bounded parsing, atomic credentials, GC observability

Status: **ALIGNED v7** — six review rounds (17→14→7→16-rescope→8→5; final
round MEDIUM-or-below, residuals ruled, applied, and self-certified per the
convergence rule; all rulings in `REVIEW-151.md` binding, the round-4 re-scope
superseding Unit 3's round-3 identity/lifecycle machinery). Units 1, 2, and 4
implement on this design alone; Unit 3's implementation is additionally gated
on design 155 reaching ALIGNED (founder do-it-right ruling, 2026-07-18) — U3
and 155 ship together as one behavior change.

Source: the 2026-07-17 product-core architecture audit
(`docs/audits/2026-07-17-product-core-architecture-audit.md`), findings 1–4,
adopted as Phase 0 containment. Audit finding 5 (blob-pack rollback floor) is
not in this design; it remains part of design 149's `meta_deploy_floor`
registry.

This is four implementation units developed in parallel worktrees but merged
through the ordered integration train in §Implementation shape. The units are
not independently mergeable. In particular, Unit 4 precedes Unit 3 because
both change `autostart-cmd.ts`, `uninstall-cmd.ts`, and their tests.

## Unit 1 — honest GC ceiling observability (audit F1 containment)

### Verified problem and bounds

The canonical GC first enumerates every row in `workspaces` with a
`LIMIT maxW + 1` sentinel (`apps/api/src/versions.ts:193-203`). It returns
before reachability when the sentinel is present, so neither that exit nor a
health handler can know the current unique-root cardinality. The root count
exists only in the later ephemeral `Set` built by
`reachableFromWorkspaces()` (`versions.ts:49-125`). `gc_state` is a generic
string KV and has no root sample today (`versions.ts:179-190`;
`apps/api/migrations/0024_gc_state.sql:5-8`). Every workspace row qualifies;
the table has no filtering column (`apps/api/migrations/0005_gc.sql:8-13`).

The two Worker service-subrequest formulas are distinct and both yield eight
rows:

- mark: `floor((800 - 10 - 3) / 90) = 8`;
- purge: `floor((800 - 10 - 5 - 3 - 1) / 90) = 8`.

The constants and purge formula are at `versions.ts:28-30,130-146,494`;
mark's formula is at `versions.ts:210`. The 75% thresholds are therefore six
rows and 562,500 roots. `MAX_UNIQUE_ROOTS` remains 750,000. No unverifiable
fleet-state claim is part of this design.

### Compatibility-preserving budget outcome

The existing budget exits are HTTP 200 and retain their phase-specific numeric
fields (`versions.ts:210-215,494-499`; `json()` defaults to 200 at
`apps/api/src/util.ts:61-62`). V2 adds typed fields without removing or
renaming old ones:

```ts
// mark
{
  marked: 0,
  budgetExceeded: true,
  ok: false,
  reason: "roots_budget_exceeded",
  rows: number,          // post-breach COUNT(*) observation, not sentinel length
  maxRows: 8,
  uniqueRoots: null,     // unknowable after the row gate fires
  maxRoots: 750_000
}

// purge
{
  purged: 0,
  opened: 0,
  budgetExceeded: true,
  ok: false,
  reason: "roots_budget_exceeded",
  rows: number,          // post-breach COUNT(*) observation, not sentinel length
  maxRows: 8,
  uniqueRoots: null,
  maxRoots: 750_000
}
```

The row count comes from a dedicated `SELECT COUNT(*) AS n FROM workspaces`
after the sentinel has selected the breach exit. It is an exact result for that
separate statement, but a post-breach observation: concurrent writes may make
it differ from the earlier sentinel snapshot. The observability field is not
transactionally coupled to that snapshot. The ninth-row sentinel continues to
bound the snapshot query and is never presented as the total. An in-budget
operation uses the complete snapshot length and pays no extra count
subrequest. Health uses its own count. The admin route already passes GC `Response`
objects through unchanged (`apps/api/src/routes/admin.ts:161-184`), so status
and compatibility are controlled at the GC operation.

`scripts/gc-drain.ts` is changed in the same unit. Both `execute` and `drain`
parse the typed body and terminate nonzero immediately when `ok === false` or
`budgetExceeded === true`; `drain` must not add numeric totals or retry that
terminal condition. This prevents the current `NaN`/nonterminating loop at
`scripts/gc-drain.ts:29-65` while retaining compatibility for other 2xx body
consumers.

### Observation schema and terminal coverage

`gc_state` gets exactly two GC-observation records:

- `gc_obs_mark`;
- `gc_obs_purge`.

Each value has this versioned envelope:

```ts
interface GcObservationV1 {
  v: 1;
  at: string; // ISO-8601 terminal timestamp
  outcome:
    | "success"
    | "roots_budget_exceeded"
    | "roots_cap_exceeded"
    | "zero_chunk"
    | "lease_busy"
    | "lease_lost"
    | "internal_500"
    | "thrown";
  stage?:
    | "count"
    | "snapshot"
    | "reachability"
    | "state_read"
    | "list"
    | "candidate_write"
    | "state_write"
    | "lease"
    | "execute"
    | "intent"
    | "release";
  status?: number;
  rows?: number;
  marked?: number;
  purged?: number;
  opened?: number;
  errorClass?: string; // never message/stack/account data
  rootsSample: null | {
    value: number;
    measuredAt: string;
    lowerBound?: true;
  };
}
```

Every terminal path records once: successful mark/purge; budget exit; purge
`zero_chunk`, `lease_busy`, `lease_lost`, and internal 500; plus count,
snapshot, reachability, list, lease, state, candidate, execute, intent, and
release failures. Failures the retained purge path CATCHES (renew, execute,
intent, state — returning its existing 500) record `internal_500` with the
relevant `stage`; only failures that ESCAPE the operation record `thrown` and
rethrow. Exceeding `MAX_UNIQUE_ROOTS` is not a generic reachability
throw: it records `outcome:"roots_cap_exceeded"`, `stage:"reachability"`, and
the lower-bound sample `{value:750_000, measuredAt:at, lowerBound:true}`. A
thrown operation records `errorClass` and rethrows; the existing purge
internal-error response remains a 500.

Release is the one cleanup-specific exception to record-and-rethrow.
`releaseLeaseWithRetry` returns a typed `{ok:true} | {ok:false,errorClass}`
outcome and never throws. `gcPurge` first determines the operation
response/exception, then runs release, then emits exactly one terminal
observation. On release failure that observation is
`outcome:"thrown", stage:"release"` with the release `errorClass`; it replaces
the would-be operation observation, but never the response or exception already
determined by the operation. Cleanup failure never replaces the operation
result.

The observation helper issues exactly this one monotonic statement. `?1` is
`gc_obs_mark` or `gc_obs_purge`; `?2` is the validated
`JSON.stringify(observation)` payload:

```sql
INSERT INTO gc_state (k, v)
VALUES (?1, json(?2))
ON CONFLICT(k) DO UPDATE SET v = json_set(
  CASE
    WHEN json_extract(excluded.v, '$.at') > json_extract(gc_state.v, '$.at')
      OR (
        json_extract(excluded.v, '$.at') = json_extract(gc_state.v, '$.at')
        AND json_extract(excluded.v, '$.outcome') = 'roots_cap_exceeded'
        AND json_extract(gc_state.v, '$.outcome') <> 'roots_cap_exceeded'
      )
    THEN excluded.v
    ELSE gc_state.v
  END,
  '$.rootsSample',
  json(CASE
    WHEN json_type(excluded.v, '$.rootsSample') = 'object'
      AND (
        json_type(gc_state.v, '$.rootsSample') <> 'object'
        OR json_extract(excluded.v, '$.rootsSample.measuredAt')
             > json_extract(gc_state.v, '$.rootsSample.measuredAt')
        OR (
          json_extract(excluded.v, '$.rootsSample.measuredAt')
            = json_extract(gc_state.v, '$.rootsSample.measuredAt')
          AND COALESCE(json_extract(excluded.v, '$.rootsSample.lowerBound'), 0) <> 1
          AND COALESCE(json_extract(gc_state.v, '$.rootsSample.lowerBound'), 0) = 1
        )
      )
    THEN json_extract(excluded.v, '$.rootsSample')
    ELSE json_extract(gc_state.v, '$.rootsSample')
  END)
)
WHERE
  json_extract(excluded.v, '$.at') > json_extract(gc_state.v, '$.at')
  OR (
    json_extract(excluded.v, '$.at') = json_extract(gc_state.v, '$.at')
    AND json_extract(excluded.v, '$.outcome') = 'roots_cap_exceeded'
    AND json_extract(gc_state.v, '$.outcome') <> 'roots_cap_exceeded'
  )
  OR (
    json_type(excluded.v, '$.rootsSample') = 'object'
    AND (
      json_type(gc_state.v, '$.rootsSample') <> 'object'
      OR json_extract(excluded.v, '$.rootsSample.measuredAt')
           > json_extract(gc_state.v, '$.rootsSample.measuredAt')
      OR (
        json_extract(excluded.v, '$.rootsSample.measuredAt')
          = json_extract(gc_state.v, '$.rootsSample.measuredAt')
        AND COALESCE(json_extract(excluded.v, '$.rootsSample.lowerBound'), 0) <> 1
        AND COALESCE(json_extract(gc_state.v, '$.rootsSample.lowerBound'), 0) = 1
      )
    )
  );
```

The `WHERE` admits a newer envelope or newer sample, and the two `CASE`
components merge independently. At equal `at`, the existing envelope wins
unless the incoming outcome is `roots_cap_exceeded` and the existing outcome
is not; cap severity then wins. At equal `measuredAt`, an incoming complete
sample (no `lowerBound:true`) replaces an existing lower bound, while the
existing sample wins every other tie. ISO timestamps are emitted by this
helper in the fixed UTC format whose lexical and chronological order agree.
There is no read-then-write. `rootsSample` normally updates only after a complete
per-workspace-consistent reachability traversal ending at `measuredAt`; the
cap outcome above is the explicit lower-bound exception. A later outcome that
did not finish traversal supplies no new sample, so the statement preserves the
prior one. The helper catches and privacy-safely logs its own write failure.
Observation failure can never alter a GC response, turn success into failure,
suppress an original exception, or prevent lease cleanup. An observation record
is operational metadata, not part of the deletion decision.

### Read-only health contract and warning semantics

Add the exact platform-gated route `GET /v1/admin/gc?phase=health`. It performs
the dedicated exact count and reads the two observation keys. It does not call
the roots collector and performs no write:

```ts
interface GcHealthV1 {
  ok: true;
  rows: number;
  maxRows: 8;
  uniqueRoots: null | {
    value: number;
    measuredAt: string;
    stale: true;
    lowerBound?: true;
  };
  maxRoots: 750_000;
  mark: GcObservationV1 | null;
  purge: GcObservationV1 | null;
  warn: boolean;
}
```

Health selects the newest available `rootsSample` from mark/purge. It is always
labelled `stale: true`: a non-lower-bound value came from a complete
per-workspace-consistent traversal ending at `measuredAt`, not a globally
point-exact snapshot, and this read does not prove it is current. With no sample
it returns `uniqueRoots: null`. A stale sample at or above 562,500 is sufficient
to warn, but a sample below threshold is never evidence that current roots are
below threshold. `warn` is true when the exact row count is at least six, the
last-known sample is at least 562,500, or either current phase observation has
`outcome:"roots_cap_exceeded"`. A cap outcome warns unconditionally and its
lower-bound sample retains `lowerBound:true` whenever selected.

Warning is level-triggered. At every hourly scheduled tick, a best-effort
health read emits the same structured privacy-safe warning while `warn` is
true. Repeated six-row ticks therefore repeat the warning; no persisted edge
state exists. Unknown roots do not suppress a row warning. Cron currently
ignores the returned mark/purge response (`apps/api/src/worker.ts:114-132`), so
the warning is emitted inside the scheduled GC/health path, not delegated to a
caller.

### Design 149 integration boundary

Design 149 Unit C is a fair-use history/prune-floor ledger, not a replacement
for canonical `gcMark`/`gcPurge`; canonical GC still reclaims objects made
unreachable by those floors. The actual overlap is design 149 Unit B: its roots
collector page/byte caps, `versions.ts` rollout, and admin roots-coverage
surface share Unit 1's seams.

Ordering is binding: 151 Unit 1 merges first as containment. Design 149 Unit B
then rebases over it, becomes the sole owner of collector caps, and extends the
health surface instead of creating a competing one. That order and ownership
must be recorded in both designs when 149-B is implemented. Unit 1 does not
change collector caps or any deletion/reachability decision.

### Unit 1 tests

1. Extend `apps/api/test/gc-purge.test.ts` with count cases for 8, 9, and
   more than 9 rows. The ninth row preserves `purged:0`, `opened:0`, HTTP 200,
   and returns the typed breach with the post-breach `rows` observation; no
   cursor/lease/mutation GC state is written except best-effort `gc_obs_purge`.
   A concurrent-write case proves `rows` may drift from the sentinel snapshot.
2. Add the equivalent mark coverage and prove the breach never enters
   `reachableFromWorkspaces()`.
3. Exercise every observation outcome and stage, including
   `roots_cap_exceeded` with its 750,000 lower-bound sample, injected observation
   write failure, and release failure that records `stage:"release"` without
   changing the operation's original response or exception.
4. Test health with no sample, a last-successful traversal sample, a later failed
   outcome retaining that sample, a cap outcome that warns unconditionally, and
   exact row counts well above the sentinel. Race out-of-order observation
   writers and prove both envelope `at` and sample `measuredAt` are monotonic.
   The SQL test names the reviewer's observations T1/T2/T3 and writes them in
   the adversarial order T1 → T3 → late T2: T3 has the newest envelope, while
   T2 has an older envelope but the newest sample. The final row must combine
   T3's envelope with T2's sample. Reverse and component-only arrival orders
   produce that same independent merge. Equal-`at` tests prove the existing
   envelope wins except for incoming `roots_cap_exceeded`; equal-`measuredAt`
   tests prove a complete sample outranks `lowerBound:true`.
5. Test level warnings at 5→6, repeated 6, and 6→5 rows, plus 562,499 and
   562,500 last-known roots. Every returned sample says `stale:true`.
6. Migrate direct body consumers in `apps/api/test/gc-purge.test.ts`,
   `apps/api/test/account-delete.test.ts`, and `apps/api/test/pack-gc.test.ts`.
7. Test `scripts/gc-drain.ts` success, lease retry, HTTP 500 retry, and the new
   immediate nonzero budget breach for both `execute` and `drain`.

## Unit 2 — bounded request parsing with protocol-compatible caps (audit F2)

### Verified problem and primitive

The blob implementation is `apps/api/src/blobs.ts`, not
`apps/api/src/routes/blobs.ts`. `blobsCheck` parses at
`blobs.ts:120-125`; the legacy D1 lookups still receive `shas` rather than the
already-deduplicated `uniq` at `:179-202`. `d1-batch` deliberately has no total
cap (`apps/api/src/d1-batch.ts:33-35`). Existing clients declare a 50,000-SHA
maximum (`src/cli/publish-pipeline/shared.ts:80`), the publish pipeline sends up
to 5,000 (`publish-pipeline/pipeline.ts:49,196-206`), and recovery has a
50,000-item chunk helper but calls the unchunked path outside full audit
(`src/cli/sync-recovery.ts:94-99,293-311`). Existing API tests require 5,600
valid SHAs in both receipt and legacy modes
(`apps/api/test/blob-check-batch.test.ts:5-24,58-61,69-135`).

`cappedJson` extends the existing `readBytesCapped()` /
`readBodyCapped()` implementation at `apps/api/src/util.ts:19-55`; it does not
create a second stream reader. It first rejects a finite decimal
`Content-Length` greater than `maxBytes`, then relies on the counting reader for
chunked, absent, false, or understated lengths. Peak retained body memory is
the cap plus at most one runtime chunk, followed by the existing
concatenation/UTF-8 decoding overhead; the table below accounts for that.
`cappedJson` decodes with `new TextDecoder("utf-8", {fatal:true})`; malformed
UTF-8 returns 400 `bad_request_shape`. This is a wrapper-layer rule only;
existing `readBodyCapped` consumers retain their current decoding behavior.

```ts
cappedJson<T>(
  req: Request,
  limits: { maxBytes: number },
  validate: (value: unknown) => T | null,
): Promise<
  | { ok: true; value: T }
  | { ok: false; response: Response }
>
```

The shared counting reader returns a discriminated terminal result so the RAW
Stripe path can distinguish a complete body, an overflow, and a read failure
without manufacturing size evidence:

```ts
type CappedReadResult =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "overflow"; bytesCounted: number }
  | { kind: "error"; bytesCounted: number; error: unknown };
```

`bytesCounted` is the number of raw stream bytes actually observed before the
overflow or error. `cappedJson` and existing text consumers translate the
discriminator into their declared response/legacy contracts; they never treat
an incomplete byte count as a body. A finite declared-oversize fast rejection
returns `kind:"overflow", bytesCounted:0` because no stream byte was read; the
separate `Content-Length` claim is never substituted for that count.
The existing `blob-pack` and `blob-batch` byte-reader consumers map `ok` to the
returned bytes, `overflow` to their existing legacy null/status response, and
`error` to a rethrow; a stream failure is never relabeled as overflow. The
concrete mappings are `apps/api/src/blob-pack.ts:300` and
`apps/api/src/blob-batch.ts:209`; `blob-batch`'s text wrapper at `:175` follows
the same discriminator policy through `readBodyCapped`.

Body overflow is 413 `{error:"body_too_large"}`. Invalid JSON, a non-object,
an array where an object is required, unknown keys, missing/wrong-type fields,
item overflow, strict field overflow, or structural format failure is 400
`{error:"bad_request_shape"}`. Display strings must additionally satisfy
`String.prototype.isWellFormed()`; JSON escapes can otherwise produce lone
surrogates after fatal UTF-8 decoding, and such ill-formed input returns the same
400. The named display fields `label` and `accountName` are the length
exception: after shape and well-formedness validation, the server truncates them
on a valid UTF-8 boundary at their documented byte maximum and never returns 400
merely because they exceed it. The enclosing body cap may still return 413. That
strict shape rejection and display-field truncation are intentional behavior changes;
authentication, authorization, and semantic validation after shape parsing
retain their existing status codes.

All `maxBytes` values count raw wire bytes inclusively. Every field maximum in
the next table is the inclusive `TextEncoder` UTF-8 byte count of the decoded
string, never JavaScript `.length`. “Exact object” means only the named keys
are accepted. “nat” means an integer in `0..Number.MAX_SAFE_INTEGER`.

### Normative appendix C.1 — exact per-route cap and validator table

| Method and exact route | `maxBytes` | Exact fields and validators; decoded UTF-8 maxima |
|---|---:|---|
| `POST /v1/blobs/check` | 16 MiB | Exact object; required `shas`: array, at most 250,000 items; each item exactly 64 B and `/^[0-9a-f]{64}$/`. |
| `POST /v1/web/session` | 128 KiB | Exact object; required `token`: compact JWT with three nonempty base64url segments, max 16,384 B; `verifyClerkJWT` remains the semantic validator. |
| `POST /v1/auth/device/start` | 8 KiB | Exact object; optional `label`: string, truncated on a UTF-8 boundary to 600 B. This is a new finite server truncation limit. |
| `POST /v1/auth/device/poll` | 1 KiB | Exact object; required `deviceCode`: exactly 64 B lowercase hex (`TOKEN_BYTES * 2`). |
| `POST /v1/auth/device/bootstrap` | 64 KiB | Exact object; required nonempty `secret`, strict max 4,096 B, then existing constant-time equality; optional `label`, truncated on a UTF-8 boundary to 600 B; optional nonempty `accountName`, truncated on a UTF-8 boundary to 600 B; optional `plan`, exact `solo | pro`. These finite string limits are new. |
| `POST /v1/auth/device/approve` | 1 KiB | Exact object; required `userCode`: exactly 9 ASCII B matching `/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/i`; handler retains uppercase normalization. |
| `POST /v1/auth/pair/create` | 1 MiB | Exact object; optional `mkWrap` and `admissionGrant`: strings, max 65,536 B each; optional `tokenId`: 16–64 ASCII B matching `/^[A-Za-z0-9_-]{16,64}$/`. |
| `POST /v1/auth/pair/redeem` | 8 KiB | Exact object; required `token`: 16–64 ASCII B token id or `rbox-pair_` plus that id (74 B maximum), existing regex after prefix removal; optional well-formed `label`: truncated on a UTF-8 boundary to 600 B before a 200-code-point display truncation. |
| `POST /v1/account/link/start` | 128 KiB | Exact object; required `clerkToken`: compact JWT, max 16,384 B, then existing `verifyClerkJWT`. |
| `POST /v1/account/link/confirm` | 128 KiB | Exact object; required `clerkToken`: compact JWT, max 16,384 B; required `pollKey`: exactly 36 ASCII B matching `/^plk_[0-9a-f]{32}$/`. |
| `POST /v1/account/link/redeem` | 1 KiB | Exact object; required `code`: 43 B base64url or `rbox-link_` plus it (53 B maximum), matching `/^[A-Za-z0-9_-]{43}$/` after prefix removal. |
| `POST /v1/keys/api` | 8 KiB | Exact object; required `tokenHash`: 64 B lowercase hex; required `deviceId`: 8–96 ASCII B matching `/^[A-Za-z0-9_-]{8,96}$/`; required integer `expiresAt` with existing future/TTL check; required well-formed `displayPrefix`: max 240 B then an 80-code-point sanitizer; optional well-formed `label`: truncated on a UTF-8 boundary to 600 B before a 200-code-point sanitizer; optional `enrolled`: boolean. |
| `POST /v1/keys/bootstrap` | 4 MiB | Exact object with exact nested `device`; required nonempty `recoveryWrap`, `recoveryWrapId`, `genesisRoster`, `genesisKeyState`, `device.deviceId`, `device.sigPubKey`, `device.encPubKey`, and `device.mkWrap`: max 65,536 B each; existing device-id equality remains semantic. |
| `POST /v1/keys/device` | 2 MiB | Exact object; required nonempty `deviceId`, `sigPubKey`, `encPubKey`, `mkWrap`: max 65,536 B each. |
| `POST /v1/keys/roster` | 512 KiB | Exact object; required `version`: nat; required nonempty `signed`: max 65,536 B. |
| `POST /v1/keys/admit` | 2 MiB | Exact object with exact nested `device` and `roster`; required nonempty `device.deviceId`, `device.sigPubKey`, `device.encPubKey`, `device.mkWrap`, `roster.signed`: max 65,536 B each; required `roster.version`: nat. |
| `POST /v1/keys/keystate` | 512 KiB | Exact object; required `accountEpoch`: nat; required nonempty `signed`: max 65,536 B. |
| `POST /v1/keys/workspace` | 1 MiB | Exact object; required nonempty `workspaceId` and `kekWrap`: max 65,536 B each; required `keyEpoch`: nat; existing ownership check remains semantic. |
| `POST /v1/stripe/webhook` | 1 MiB default | Public signature-verified RAW body, not a `cappedJson` shape: read with the discriminated counting byte reader up to `RBOX_STRIPE_WEBHOOK_MAX_BYTES`, preserve complete exact bytes for Stripe signature verification, return 413 on overflow, log exactly one structured overflow anomaly line, verify a complete body first, then perform the existing parse. |

The 64 KiB opaque limits replace the current code-unit checks at
`apps/api/src/keys.ts:17-25` and `auth/pairing.ts:46-50` with explicit UTF-8
byte semantics. Protocol-produced opaque values are ASCII JSON/base64 and keep
the declared 64 KiB capacity. A previously accepted multibyte string whose
encoded form exceeds 65,536 bytes is now rejected; this is a deliberate
security-boundary behavior change, not described as transparent compatibility.
Secrets and structured tokens retain strict rejection at their declared byte
caps. In particular, the 4,096 B bootstrap `secret` limit is a new strict,
documented limit on an operator-controlled input. `label` and `accountName`
instead preserve succeeding display-field semantics by truncating, never
rejecting, at 600 B. Their normative order is shape validation (including
`isWellFormed()`) → 600-byte UTF-8-boundary truncation → code-point-safe display
truncation. The last step counts Unicode code points, not UTF-16 code units; it
may split a grapheme cluster but never a surrogate pair. The unsafe
`.slice(0, 200)` at `apps/api/src/auth/pairing.ts:97` and the `.slice(0, max)`
inside `sanitizeWorkspaceName` at `apps/api/src/authz.ts:81` are the concrete
sites to fix. The latter also covers `displayPrefix` after its strict 240-byte
cap. The large body caps preserve space for JSON escaping while bounding
retained memory. JWT, label, secret, account-name, user-code, and poll-key
limits are new because the current server has no finite declared maximum for
those inputs.

### Blob behavior and client compatibility

For `blobs/check`, validation happens before allocation-heavy or D1 work. The
server immediately computes `uniq = [...new Set(shas)]` and passes `uniq` to
both receipt and legacy D1 lookups. `missing` continues to be filtered from
`uniq`, preserving first-occurrence response order and the successful response
shape (`apps/api/src/blobs.ts:141-167,179-207`). Only the legacy lookup input
changes from `shas` to `uniq`.

The server cap is five times the declared client item maximum and matches the
server accounted-ref ceiling at `apps/api/src/commit-accounting.ts:48`:
`maxItems = 250_000`, `maxBytes = 16 MiB`. At 250,000 items, approximately
250,000 × 67 B = 16.75 MB remains below 16 MiB. In the same unit, every
`sync-recovery` path uses `missingBlobsChunked` at 50,000 items, including the
currently unchunked non-full-audit call at `sync-recovery.ts:293-311`. This is a
coordinated client+server unit, not API-only.

### Scope boundary

The 19 rows above are the complete v6 scope. `POST /v1/keys/api/:id/revoke`,
`POST /v1/account/unlink`, and `POST /v1/workspaces` do not parse JSON and are
out. `GET` lookup/status/list routes are out. `POST /v1/blobs/:sha/multipart`
still parses JSON at `apps/api/src/blobs.ts:356` and is explicitly assigned to
the follow-up mechanical sweep, along with any other remaining `req.json()`
site. Workspace commits, diagnostics, telemetry, blob-pack, and blob-batch already use
the capped byte reader and are not reimplemented here. The Stripe webhook is
the sole RAW row and is exempt from `cappedJson` shape validation: it uses
`readBytesCapped`, verifies the signature over the exact received bytes, and
only then runs its existing JSON parse.

`RBOX_STRIPE_WEBHOOK_MAX_BYTES` is an optional string field on `Env`, parsed as
a base-10 positive safe integer. Absent or invalid values default to 1 MiB and
never disable the bound. Both the top-level
development `vars` and `env.production.vars` in `apps/api/wrangler.jsonc` set it
to `"1048576"`, so the default is explicit in both deployed environments.

The 1 MiB default Stripe bound ships without a pre-ship measurement gate. Overflow
emits exactly one privacy-safe structured anomaly line containing the normalized
finite `Content-Length` claim (nullable), `bytesCounted`, and
`signaturePresent`. It contains no body, signature, event id, or account data.
The line is an anomaly signal only: an incomplete count and a sender-controlled
length claim are never cap evidence, and this design creates no measured-evidence
stream or size distribution. Any cap change requires Stripe-side corroboration.
A reader error returns through the existing error path with its counted-byte
discriminator but is not mislabeled or logged as overflow. An overflowed body
is never verified or parsed, and 413 is not successful delivery.

The implementation adds a Stripe-webhook runbook entry to
`docs/DEPLOYMENTS.md`: after Stripe-side corroboration of a legitimate oversized
event, raise the cap through the existing environment/configuration surface,
deploy that configuration, and resend the event from Stripe's dashboard within
Stripe's 15-day manual resend window. Stripe already owns that resend capability.
This unit builds and claims no replay,
fetch-by-id, reconciliation, admin, or API surface.

### Unit 2 tests

1. `cappedJson` tests cover declared oversize fast rejection, absent/chunked and
   understated `Content-Length`, exact-boundary acceptance, reader cancellation,
   malformed UTF-8 decoding to 400 `bad_request_shape`, malformed JSON, strict
   object shape, and peak-reader behavior.
2. Table-driven route tests instantiate every table row at its legitimate
   maximum and one byte/item beyond it. Strict secrets and structured fields
   reject overflow; `label` and `accountName` overflow succeeds with UTF-8
   boundary-safe truncation. UTF-8 fixtures prove the byte—not code-unit—contract;
   astral characters at both truncation seams remain whole, and escaped lone
   high/low surrogates return 400 via `isWellFormed()`. Pairing and API-key
   tests exercise the fixed `pairing.ts:97` and `authz.ts:81` sites. The RAW
   webhook row has its separate signature-first assertions below.
3. `blobs/check` tests cover 250,000 items at the 16 MiB boundary, 250,001
   rejection, invalid item rejection, and existing 5,600 receipt/legacy cases.
4. A duplicate-amplification test proves one valid SHA repeated many times
   produces the same legacy D1 statement count as one occurrence, without
   changing ordered `{missing}`.
5. `src/cli/sync/sync.test.ts` keeps the `[50_000, 1]` chunk assertion and adds
   a non-full-audit recovery regression proving every path chunks at 50,000.
6. Auth semantic tests prove structurally valid but unauthorized tokens retain
   their current 401/403 behavior; only malformed shape becomes the declared 400.
7. Stripe webhook tests cover exact 1 MiB acceptance, overflow by one byte with
   413 before signature verification or parsing, absent/chunked and understated
   `Content-Length`, signature verification over the exact original bytes, and
   signature-before-existing-parse ordering. Reader tests assert each
   discriminated `{kind:"ok"}`, `{kind:"overflow"}`, and `{kind:"error"}`
   result and its exact count. Dedicated `blob-pack`/`blob-batch` tests prove
   ok→bytes, overflow→the existing null/status response, and error→rethrow.
   Declared and streaming overflow each emit exactly
   one anomaly line with the content-length claim, counted bytes, and signature
   presence and prove no body or signature material is logged. Tests forbid any
   measured-evidence/cap-evidence claim. A documentation check requires the
   validated `RBOX_STRIPE_WEBHOOK_MAX_BYTES` absent/invalid default and positive
   override, its declaration in `Env` and both Wrangler environments, plus the
   raise-config-then-Stripe-dashboard-resend runbook with its 15-day window, and
   forbids a local replay surface.

## Unit 3 — fail-closed destructive CLI semantics (audit F3)

### Consent boundaries

The dispatcher's automatic noninteractive confirmation has exactly one consumer:
untrack (`src/cli/main-dispatch.ts:161-172`). This design separates two consents:

- **Metadata deletion:** noninteractive `rbox untrack` without `--yes` exits 1,
  leaves `.rbox` and daemon runtime untouched, and prints the exact safe rerun.
  Interactive untrack still prompts unless `--yes` is present. `--force` never
  implies deletion consent.
- **Kill escalation:** `--force` authorizes signaling a recorded alive PID whose
  ownership cannot be classified and selects SIGKILL-after-timeout. Without it,
  either ambiguity or timeout is nonzero and preserves both the process and PID
  record. This applies to `rbox stop` and untrack; internal upgrade/uninstall
  policies are explicit below.

Help changes from the current combined untrack flag
(`src/cli/help-registry.ts:237-243`) to separate `--yes` (“confirm local
metadata deletion”) and `--force` (“allow signaling an unclassified recorded
PID and SIGKILL after the graceful deadline”).

### One escalation owner and exhaustive outcomes

`stopDaemon` becomes the sole TERM→timeout→SIGKILL escalation controller.
Rebind retains its existing independent no-escalation TERM + five-second +
`retry-later` path; it is not unified in this design.

```ts
type Escalation = "never" | "after-timeout";

type StopOutcome =
  | { kind: "no-pid"; record: "absent" | "unreadable"; confirmedDead: false; pid: null }
  | { kind: "stale-pid"; confirmedDead: true; pid: number }
  | {
      kind: "unknown";
      phase: "initial" | "before-term" | "before-kill";
      reason: "alive-unclassified" | "probe-failed" | "permission-denied";
      confirmedDead: false;
      pid: number;
    }
  | {
      kind: "esrch-at-signal";
      at: "term" | "kill"; // pairs phase and signal — term/SIGTERM, kill/SIGKILL; no other combination exists
      confirmedDead: true;
      pid: number;
    }
  | { kind: "graceful"; confirmedDead: true; pid: number }
  | { kind: "requested"; confirmedDead: false; pid: number }
  | { kind: "timed-out"; confirmedDead: false; pid: number }
  | { kind: "zombie-dead"; phase: "after-term" | "after-kill"; confirmedDead: true; pid: number }
  | { kind: "force-kill-confirmed"; confirmedDead: true; pid: number }
  | { kind: "kill-unconfirmed"; confirmedDead: false; pid: number }
  | { kind: "error"; errorClass: string; confirmedDead: false; pid: number | null; phase?: "before-term" | "after-term" | "after-kill" };

stopDaemon(root, {
  termTimeoutMs?: number, // default 60_000
  killTimeoutMs?: number,
  escalate: Escalation,
  overrideUnknown?: boolean, // true only for an explicit human --force
  quiet?: boolean
}): Promise<StopOutcome>;
```

Exactly five variants carry confirmation authority. Four mean the named PID was
observed absent by an `ESRCH`-definitive operation: `stale-pid` at the initial or
pre-TERM liveness probe, `graceful` after TERM or at the pre-KILL probe,
`force-kill-confirmed` after KILL, and `esrch-at-signal` when TERM or KILL itself
loses the race to process exit. `zombie-dead` means a post-signal persistent PID
was observed in zombie state: Linux reads state `Z` from `/proc/<pid>/stat`, and
macOS reads the leading `Z` from `ps -o state= -p <pid>`. A zombie cannot execute
and therefore is confirmed dead even though its PID remains until its parent
reaps it.
No command substring, workspace-root comparison, PID-record absence, or
foreign-process classification is death evidence. The liveness primitive and
wait loop must preserve `ESRCH`, `EPERM`, and other probe errors as distinct
results rather than collapse them into “not ours.”

The current command/root predicate may select a plausible daemon for signaling,
but it is not attestation. If the PID is alive and that predicate cannot classify
it, or the probe fails or returns `EPERM`, the result is `unknown` unless the
human supplied `--force`. Without `--force`, no signal, record cleanup,
desired-state write, replacement start, or deletion follows. Human output names
the PID and says, in substance:

> Cannot safely classify process PID; nothing was changed. Inspect it with
> `ps -p PID -o command=`, stop it manually and retry, or rerun with `--force`
> to authorize signaling that PID.

The rendered copy substitutes the numeric PID in every position. `--force` is
the human override for proceeding to signal that recorded PID despite
unclassifiable-alive evidence; it does not itself confirm death. Follow-on still
requires one of the five confirmed-dead terminal outcomes. Internal upgrade
and uninstall escalation policies do not set `overrideUnknown` and therefore
cannot silently exercise the human override.

`requested` remains a nonterminal dependency outcome so an injected/alternate
controller cannot accidentally authorize follow-on work. Every caller switches
exhaustively, and `assertNever` makes a new variant fail compilation. `no-pid`
also remains unconfirmed: without lifecycle serialization, an absent or
unreadable record cannot establish that no daemon is in the pre-publication
window. It exits nonzero at destructive boundaries with the record path and a
manual inspection/removal remedy.

Mapping to the current branches at `src/cli/daemon-control.ts:398-452` is
normative:

| Observation/branch | `StopOutcome` | Follow-on authority |
|---|---|---|
| PID record absent or unreadable | `no-pid` | unconfirmed; retain state and refuse destructive follow-on |
| initial direct liveness probe returns `ESRCH` | `stale-pid` | confirmed; clean only the same recorded PID |
| live PID fails command/root classification, probe fails, or returns `EPERM` | `unknown/initial` | unconfirmed; fail closed unless explicit human `--force` continues to the signal path |
| pre-TERM direct liveness probe returns `ESRCH` | `stale-pid` | confirmed; send no TERM |
| pre-TERM recheck becomes unclassifiable/fails/returns `EPERM` | `unknown/before-term` | same override rule; otherwise retain record and send no signal |
| TERM throws `ESRCH` | `esrch-at-signal`, `phase:"term"` | confirmed |
| post-TERM wait observes `ESRCH` | `graceful` | confirmed |
| post-TERM wait expires and the platform state probe reports zombie | `zombie-dead` | confirmed; send no KILL |
| post-TERM wait expires and the state probe reports non-zombie or is inconclusive, with `escalate:"never"` | `timed-out` | unconfirmed; retain record, no SIGKILL |
| pre-KILL direct liveness probe returns `ESRCH` | `graceful` | confirmed; send no KILL |
| pre-KILL recheck becomes unclassifiable/fails/returns `EPERM` | `unknown/before-kill` | unconfirmed; only the same explicit human override may continue |
| KILL throws `ESRCH` | `esrch-at-signal`, `phase:"kill"` | confirmed |
| post-KILL wait observes `ESRCH` | `force-kill-confirmed` | confirmed |
| post-KILL wait expires and the platform state probe reports zombie | `zombie-dead` | confirmed |
| post-KILL wait expires and the state probe reports non-zombie or is inconclusive | `kill-unconfirmed` | unconfirmed; retain record |
| any other signal/system exception | `error` with privacy-safe `errorClass` | unconfirmed; retain record and return to a nonzero command boundary |

Any confirmed-dead outcome permits cleanup only of the unchanged record that
named that PID. A replaced record is never adopted or removed. The result does
not claim process-incarnation identity or close a probe→signal PID-reuse race;
those lifecycle-integrity problems are extracted to design 155 below.

Untrack deletes its duplicate 5-second/2-second wait/kill layer
(`src/cli/untrack-cmd.ts:24,27-28,48-64`). It calls the escalation owner with
`termTimeoutMs:15_000`; `--force` alone selects `after-timeout` and
`overrideUnknown:true`. Default callers use 60 seconds. Output derives the
configured timeout rather than the currently hard-coded “60 seconds” line.

After a confirmed-dead stop and independent interactive/`--yes` deletion
consent, untrack acquires the **existing** workspace sync mutex before any
deletion and holds that single serialization order through both removals. It
adds no daemon-lifecycle lock and takes no second lock. Teardown is runtime
first and ordered: remove the daemon-runtime tree completely, then walk `.rbox`
post-order while excluding `.rbox/state/sync.lock` AND its ancestor directories
(`state`, `.rbox` itself) — every other entry is removed first. The terminal
phase is then: unlink `state/sync.lock` (the terminal lock release), `rmdir
state`, `rmdir .rbox`. Marker retention applies to PRE-release failures only: a
failure before the marker unlink stops the walk, retains `sync.lock`, and
reports exactly what remains. A failure in the two post-release `rmdir`s cannot
restore the marker; it is reported as named residue ("empty `.rbox` shell
remains — remove it manually") and untrack still exits successfully with that
warning. The untrack path must not call the generic post-delete release and
misreport ownership loss. A queued contender that was blocked on the marker
must, immediately before republishing, re-verify the binding identity — the
workspace config file exists and names the same workspace — and abort with the
workspace-gone message if it does not; it never republishes `sync.lock` into or
recreates `.rbox/state` under a torn-down root.
Contention, acquisition error, or the existing mutex's degraded-unlocked result
refuses deletion with the normal retry/stop guidance. Deletion never uses the
mutex's legacy unlocked fallback. Already completed
runtime-first deletions are not claimed to roll back.

### Caller policies

| Caller | Stop policy | Required result before follow-on |
|---|---|---|
| `rbox stop`, deprecated `rbox daemon stop`, front-door Pause through `stopDaemonAndRecordDesired` | 60 s; `never` normally; explicit `--force` selects `after-timeout` and the alive-unclassified human override | one of the five confirmed-dead outcomes before writing desired `stopped`; every unconfirmed outcome retains prior desired state and exits nonzero |
| direct untrack | 15 s; `never` normally; explicit `--force` selects `after-timeout` and the alive-unclassified human override | confirmed-dead outcome plus interactive/`--yes` deletion consent, then successful nondegraded acquisition of the existing sync mutex before runtime-first, ordered `.rbox` teardown |
| upgrade restart | 60 s, always `after-timeout`, never `overrideUnknown` | confirmed-dead outcome before start; never start on `no-pid`, `requested`, `timed-out`, `kill-unconfirmed`, `unknown`, or `error` |
| `uninstall --yes`, desired rows | 60 s, always `after-timeout`, never `overrideUnknown` | every daemon has a confirmed-dead outcome before autostart disable or any `~/.rbox` removal |
| `uninstall --yes`, legacy pidfiles | same escalation controller/deadlines, not raw SIGTERM | every recorded PID has a confirmed-dead outcome before removal |

Upgrade snapshots all desired rows before any stop, including stopped rows,
workspace identity, and `pullOnly` (`src/cli/upgrade-cmd.ts:52-59,79-98`). It
restarts only rows whose pre-stop desired state was running and passes the
snapshotted `pullOnly`. A failed or nonterminal stop, including `no-pid` or
`unknown`, marks upgrade restart failed; the same live process is never
misreported as restarted via `already-running`. This containment design makes
no stop→replacement serialization or desired-row revalidation claim.

Uninstall currently swallows desired-stop failure, raw-SIGTERMs legacy PID
files, then removes global state (`src/cli/uninstall-cmd.ts:61-88,111-118`). V2
routes both desired and legacy records through the same escalation state
machine. If any result lacks confirmed-dead authority, uninstall aborts
before disabling autostart or removing anything; `~/.rbox` remains intact. The
dry run remains nonmutating.

### Stop flags, JSON, and exits

`rbox stop` declares and dispatches `--force` and `--json`; the deprecated
`rbox daemon stop` forwards both through alias rewriting. This updates the
current no-flag help/dispatch seams (`src/cli/help-registry.ts:122-126`;
`main-dispatch.ts:125-127,339-341`; `deprecations.ts:48-52`).

`rbox stop --json` writes exactly one JSON object to stdout and no human stop
lines, including when `stopDaemon` returns `error`; no exception path bypasses
the object:

```ts
{
  ok: boolean;                 // identical to confirmedDead
  outcome: StopOutcome["kind"];
  confirmedDead: boolean;
  pid: number | null;
  escalated: boolean;           // OBSERVED: a SIGKILL was actually sent during this invocation — not the policy setting
  phase?: "initial" | "before-term" | "before-kill" | "term" | "kill";
  reason?: "alive-unclassified" | "probe-failed" | "permission-denied";
  signal?: "SIGTERM" | "SIGKILL";
  record?: "absent" | "unreadable";
  errorClass?: string;
}
```

Exit 0 is reserved for `confirmedDead:true`. `requested`, `timed-out`,
`kill-unconfirmed`, `unknown`, `error`, and absent/unreadable PID state exit 1.
Human mode prints the same distinction without emitting JSON. `rbox status --json`
continues to report current liveness; it is not stop-outcome persistence.

### Unit 3 tests

1. Expand `src/cli/daemon-stop.test.ts` to cover every simplified union variant,
   absent versus unreadable no-PID state, both escalation modes, retained/replaced
   PID records, configurable output deadline, and signal errors. Separate tests
   prove `stale-pid` only from initial/pre-TERM-probe ESRCH, `graceful` only from
   post-TERM/pre-KILL-probe ESRCH, `force-kill-confirmed` only from post-KILL
   ESRCH, and the named `esrch-at-signal` variant at both TERM and KILL seams;
   pre-signal ESRCH sends no following signal. Linux `/proc/<pid>/stat` and macOS
   `ps -o state=` fixtures prove post-TERM and post-KILL zombies return
   `zombie-dead`, while persistent non-zombies preserve `timed-out` or
   `kill-unconfirmed`. Alive-unclassifiable,
   probe-failed, and `EPERM` cases at every phase fail closed without `--force`,
   name the PID and remedies, and proceed to signal—but still do not confirm—when
   explicit human `--force` is present.
2. Migrate every injected stop stub from `Promise<void>` to `StopOutcome` in
   `autostart-cmd.test.ts`, `upgrade-daemons.test.ts`, and
   `uninstall-cmd.test.ts`; exhaustively test confirmed/unconfirmed, including
   `unknown`, follow-on gates.
3. Add the hung-upgrade regression: after timeout, KILL-unconfirmed, or
   `unknown`, no start is attempted and the snapshot (including `pullOnly`)
   remains the source of truth.
4. Add uninstall desired and legacy PID `no-pid`, timeout, KILL-unconfirmed, and
   `unknown` tests proving autostart is not disabled and `~/.rbox` is intact.
5. Add the noninteractive untrack cross-product: `--yes` ±, `--force` ±,
   responsive/hung/unclassifiable daemon. Only `--yes` supplies deletion consent
   and only `--force` supplies escalation/unknown-override consent. Add the
   interactive prompt to the TUI regression flow. Indeterminate-probe and
   replaced-record cases prove direct untrack retains `.rbox` and daemon runtime
   without ESRCH confirmation. Add ordering tests proving the existing sync
   mutex is acquired after confirmation and before either deletion; contention,
   acquisition failure, or degraded-unlocked mode retains both trees, while
   successful deletion removes daemon runtime first, performs the ordered
   `.rbox` walk, and consumes `state/sync.lock` terminally without a second lock.
   The named partial-failure test proves the marker and remaining `.rbox` entries
   survive an injected ordered-walk failure after runtime removal; the named
   queued-contender test proves a waiter cannot recreate `.rbox/state` after the
   terminal marker unlink.
6. Add a real default-wrapper routing test for front-door Pause and prove
   `stopDaemonAndRecordDesired` preserves prior desired state on every
   unconfirmed outcome, including `unknown`; an injected `pauseSyncing` action
   test alone is insufficient.
7. Add help, unknown-flag, dispatcher, deprecated-alias, human-output, JSON
   single-object, and exit-code tests for `stop --force/--json` and untrack
   `--yes/--force`. `rbox stop --json` covers every outcome, including `unknown`
   and `error` as exactly one JSON object with exit 1; `errorClass` is covered in
   both human and JSON modes.

This is a breaking headless behavior change for scripts relying on automatic
untrack consent or silent SIGKILL. Unit 3 adds a Changed/Breaking changelog
entry consistent with design 138's track/keyed-setup treatment.

### Extracted to design 155

Round 4 found that v4's identity/lifecycle machinery was expanding the design
surface faster than it closed Phase 0 containment risks. Daemon lifecycle
integrity is therefore its own design, 155. **Gating (founder ruling
2026-07-18, do-it-right):** Units 1, 2, and 4 align and implement on this
design alone; Unit 3's IMPLEMENTATION is additionally gated on design 155
reaching ALIGNED — U3 and 155 ship together as one behavior change, so users
never see an interim conservative-only stop/untrack. This document remains
U3's authoritative CONTRACT (consent split, `StopOutcome` union, fail-closed
`unknown`, caller policies, exits/JSON); 155 supplies the classifier and
serialization that produce those outcomes precisely. In particular, the
existing start spawn→PID-record-publication window and PID reuse while a live
process is being classified are pre-existing races, out of scope for 151 and
owned by 155. Finding 4 stays here and is resolved by untrack's
existing-sync-mutex serialization. The following Round-4 findings 1–3 and 5–9
are design 155's problem-statement pointers, reproduced verbatim (their
`design:` links are HISTORICAL, NON-RESOLVING references to the reviewed v4
revision — this file has since changed; resolve them against git history, not
the current text. They are exempt from the current-anchor ledger):

1. **BLOCKER — initial identity pinning can attest and kill the wrong rbox daemon.** The design requires definitive command/root matching before accepting a PID ([design:581](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/docs/design/151-phase0-containment.md:581)), but the cited implementation uses substring tests over textual `ps` output ([daemon-control.ts:211](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/src/cli/daemon-control.ts:211)). A stale PID for `/work/a` reused by an rbox daemon for `/work/a2` passes `cmd.includes(root)`; its current start time is then pinned, so all later observations agree and the wrong daemon is signalled. The record boot ID is not independently observed from that process. Require exact argv extraction/comparison or return `unknown`. This reopens round-3 ruling 1 with new evidence.

2. **HIGH — start releases the lifecycle lock before its desired-state write.** The start contract explicitly holds only through spawn and PID publication ([design:634](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/docs/design/151-phase0-containment.md:634), [design:699](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/docs/design/151-phase0-containment.md:699)), while `startDaemonAndRecordDesired` writes `desired.json` only after `startDaemon` returns ([autostart-cmd.ts:191](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/src/cli/autostart-cmd.ts:191)). A concurrent stop can acquire the lock, kill the daemon, and write `stopped`; the original start wrapper can then overwrite it with `running`. Start needs a lock-aware wrapper spanning desired-context validation through desired-record publication.

3. **HIGH — boot resume retains a stale read-to-act resurrection race.** It selects running desired rows before acquiring any root lifecycle lock, then calls raw `startDaemon` later ([autostart-cmd.ts:269](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/src/cli/autostart-cmd.ts:269)). A concurrent stop can change the row to `stopped`, after which boot resume starts the daemon anyway. The generic record reread at [design:645](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/docs/design/151-phase0-containment.md:645) does not specify caller-specific desired-row revalidation, and boot resume is absent from the lifecycle race tests.

5. **HIGH — upgrade and uninstall have no total lock order or stale-snapshot rule.** Upgrade holds `~/.rbox/upgrade.lock`, snapshots desired rows, and later takes per-root locks ([upgrade-cmd.ts:52](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/src/cli/upgrade-cmd.ts:52), [upgrade-cmd.ts:232](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/src/cli/upgrade-cmd.ts:232)). Uninstall instead holds lifecycle locks while deleting all of `~/.rbox` ([design:696](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/docs/design/151-phase0-containment.md:696), [uninstall-cmd.ts:111](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/src/cli/uninstall-cmd.ts:111)). It can remove the held upgrade-lock pathname and desired state, after which upgrade restarts from its stale `running` snapshot. Define global-lock → root-lock ordering and revalidate desired state under the root lock.

6. **HIGH — no lifecycle-lock location/canonicalization contract satisfies the promised deletion scopes.** The lock is merely “derived from the workspace root” ([design:614](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/docs/design/151-phase0-containment.md:614)). Untrack deletes workspace `.rbox` and daemon runtime; uninstall deletes global `~/.rbox`, so any obvious existing location destroys its own marker while authority is still required. An external namespace could work, but its path, ownership, permissions, cleanup, and uninstall behavior are unspecified. Additionally, current root keys use lexical `path.resolve`, not `realpath` ([rbox-paths.ts:30](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/src/cli/rbox-paths.ts:30)); path aliases can derive different locks for one physical workspace.

7. **HIGH — age-based crash recovery does not fence start's own mutation seams.** A live holder may be reaped at five minutes, but v4 explicitly requires ownership rechecks only before signals and caller follow-ons ([design:625](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/docs/design/151-phase0-containment.md:625)). Spawn, PID cleanup/publication, and heartbeat path updates are themselves critical mutations ([daemon-control.ts:379](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/src/cli/daemon-control.ts:379)). A paused holder can resume after displacement and publish a PID record unless exact ownership is required immediately before each seam. Heartbeat also needs handle/fence-bound `mtime` refresh so an old holder cannot touch a successor marker.

8. **HIGH — legacy-pid uninstall cannot derive the promised per-root lock from its inventoried state.** The current fallback has only a runtime-directory key and PID ([uninstall-cmd.ts:61](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/src/cli/uninstall-cmd.ts:61)), but the design requires a root-derived “corresponding lifecycle lock” ([design:616](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/docs/design/151-phase0-containment.md:616), [design:696](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/docs/design/151-phase0-containment.md:696)). Specify an exact argv/root recovery protocol, validate `workspaceKey(root)`, acquire locks in stable order, and reprobe—or fail closed and retain global state. Appendix A is therefore not a complete lifecycle-lock caller checklist.

9. **HIGH — `stopDaemon` is not actually the sole deadline controller.** V4 says it becomes the only TERM/KILL deadline owner ([design:535](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/docs/design/151-phase0-containment.md:535)), but Appendix A explicitly retains rebind's independent TERM-plus-five-second controller ([design:1081](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/docs/design/151-phase0-containment.md:1081)); that controller is concrete at [daemon-control.ts:342](/home/via/Development/Personal/rbox-core/.claude/worktrees/phase0-containment/src/cli/daemon-control.ts:342). Route rebind through a lock-aware no-escalation controller or narrow the exclusivity statement and separately specify its pinning/lock behavior.

## Unit 4 — atomic, typed credential persistence (audit F4)

### Versioned wire format and typed load

The current DTO is unversioned (`src/cli/credentials.ts:11-18`), every disk
read/parse failure becomes `undefined` (`:38-52`), and save writes the final
path before chmod (`:63-66`). V2 writes:

```ts
interface CredentialsV1 {
  v: 1;
  token: string;       // required, nonempty
  deviceId: string;    // required, nonempty
  remoteUrl: string;   // required, absolute http: or https: URL
  accountId?: string;  // when present, nonempty
}

type CredentialLoadResult =
  | { state: "absent"; path: string }
  | {
      state: "valid";
      source: "disk" | "env";
      credentials: CredentialsV1;
      legacy: boolean;
      extensions: Record<string, unknown>;
    }
  | { state: "corrupt"; path: string; detail: string; quarantinedTo?: string }
  | { state: "unreadable"; path: string; detail: string }
  | { state: "unsupported-version"; path: string; version: unknown; quarantinedTo?: string }
  | {
      state: "invalid-environment";
      variable: "RBOX_DEVICE_ID" | "RBOX_API" | "RBOX_ACCOUNT_ID";
      detail: string;
    };
```

`v` absent is the legacy document. A legacy file is accepted only if every
known field validates and is migrated on the next save, never as a load-side
write. `v === 1` is current. A present nonnumeric/malformed `v` is `corrupt`;
any other integer version is `unsupported-version`. Unknown fields do not make
an otherwise valid legacy/v1 document fail: load returns them in `extensions`
so they are preserved as observed evidence, while save explicitly serializes
only the five known v1 keys and drops extensions. Optional `accountId` is
validated when present.

`RBOX_TOKEN` remains an independent recovery/CI source. When nonempty, it
returns `state:"valid", source:"env"` before reading or quarantining disk;
`RBOX_DEVICE_ID`, `RBOX_API`, and `RBOX_ACCOUNT_ID` use today's fallbacks and
the same field validators (`credentials.ts:39-46`). Any explicitly supplied env
value that fails its validator returns `state:"invalid-environment"`; `variable`
and the privacy-safe `detail` name the offending variable. Invalid auxiliary
values are never silently ignored in favor of a fallback, and disk remains
unread and unquarantined. A later save after a valid env load still performs the
disk preflight below.

### Collision-proof quarantine and save preflight

Load quarantines readable `corrupt` and `unsupported-version` files before
returning their typed state. Every `saveCredentials` performs the same
classification/quarantine preflight, covering direct login paths that currently
save without loading (`src/cli/auth-cmd.ts:211-232,244-289`) and all other save
callers.

Both paths are serialized across processes by the sibling
`~/.rbox/credentials.lock`. Its bounded marker is
`{v:1,pid,processStart,acquiredAt,nonce}`. Marker publication is all-or-nothing:
create a sibling random temp with `O_CREAT|O_EXCL|O_NOFOLLOW` and mode 0600,
write the complete bounded marker, file-sync, close, hardlink temp→final, then
unlink the temp in `finally`. `EEXIST` means contention; unsupported hardlinks
or any other publication failure fail closed. This is the repository pattern at
`src/engine/git/lockfile.ts:709-733`, not a direct write to the final marker.
The holder keeps the identity-verified lock handle and refreshes its mtime at
least every 30 seconds and after each awaited filesystem step. Acquisition
precedes disk classification. Load-side
quarantine holds ownership through
classify→preserve→source removal; every save holds it through
classify→quarantine-if-needed→temp write→rename.

A lock younger than five minutes, measured from its `lstat` modification time,
is live regardless of its PID and causes bounded retry; retry exhaustion
returns typed `unreadable` on load and is fatal on save. A valid marker at five
minutes is eligible for age-based stale takeover; a malformed or future-dated
marker fails closed with operator recovery guidance rather than being reaped.
Because publication cannot expose a partial final marker, a malformed final
marker is reachable only through tampering or a non-rbox writer, not an rbox
crash seam.
The PID tag is diagnostic; neither PID death nor reuse changes the five-minute
predicate.

Takeover, every evidence/source publication or removal, final credential
rename, heartbeat, and release also take a short-lived
`credentials.lock.fence`. Its bounded marker includes PID, process-start
identity, and nonce and uses the same temp→file-sync→close→hardlink→temp-cleanup
publication; this applies to initial fence acquisition and every reacquisition.
The fence is never age-reaped: an abandoned fence is removed only after direct
proof that exact process incarnation is dead; an alive or indeterminate holder
blocks and fails closed. While holding the fence, an operation requires the
`credentials.lock` path, marker nonce, and opened-handle identity still to
match. A stale contender reopens and revalidates the five-minute-old lock,
removes that exact path identity, and installs its new `credentials.lock` with
the same hardlink publication before releasing the fence. A displaced holder
therefore fails its next fenced ownership check and performs no further write,
removal, or rename. Release runs in `finally` under the same fence and unlinks
only its still-matching handle/nonce; it cannot delete a successor.

`clearCredentials()` at `src/cli/credentials.ts:69` participates in this lock.
On the normal logout path it acquires `credentials.lock` under the same bounded
retry, heartbeat, fencing, and stale policy and holds ownership through the
credential unlink, closing an in-flight save's republish window. The sanctioned
logout-only **destructive-recovery override** activates on retry exhaustion,
malformed/future-marker refusal, or any post-acquisition fence acquisition,
reacquisition, publication, ownership-check, or release failure. The rule is:
**logout clears unless it cannot do so safely; every unsafe-path failure prints
the manual remedy.**

Before the override removes anything, it runs the same safe-chain/no-follow
validation used by save: `lstat` every directory component, reject symlinks and
non-directories, require the secret parent to be owned by the effective user and
not group/world writable, validate each present credential/lock/fence target as
the expected non-symlink type, and recheck the path/handle identity at the
deletion seam. Only a fully proved chain permits removal of the exact
`credentials.json`, `credentials.lock`, and `credentials.lock.fence` paths. If
any fact is unreadable, changes at the seam, or otherwise cannot be proved, the
override refuses deletion and prints a privacy-safe manual remedy naming those
paths and instructing the operator to verify they are not symlinks, stop any
rbox credential writer, and remove them manually. This is the bounded exception
to “always clears”; uncertainty never turns into a following unlink.

The override is intentionally racy recovery, belongs to logout alone, and is
unreachable from load, save, quarantine, login preflight, or any generic lock
helper; no other fence/credential policy may invoke it. Its warning names the
override, the failure class, and whether safe deletion succeeded or was refused,
never credential contents. After a safe override unlinks the three exact paths,
logout verifies that each is absent. Even an all-absent observation is
non-definitive because a concurrent sign-in can republish after the check, so
the override always prints the idempotent remedy: “cleared; if another rbox
process was signing in concurrently, run `rbox logout` again”. Only the normal
locked path is definitive.

This fencing makes age-based crash recovery compatible with cross-process
serialization even if an old process resumes. It is a cooperative-writer
contract: rbox is the only supported writer, under the same local trust model
as design 149. Non-rbox mutation is outside that trust model; identity drift
detected at any specified seam fails closed.

The quarantine algorithm is no-clobber:

1. Under `credentials.lock`, validate the directory chain and `lstat` the
   source; refuse a symlink or non-regular credential file. Open it without
   following symlinks, `fstat` the handle, and require device, inode, type, and
   size identity to match the `lstat` result.
2. Read and retain the exact original bytes from that identity-verified source
   handle, then re-`fstat` it and reject any identity/size drift.
3. Try `credentials.json.corrupt-<UTC timestamp>`, then `-1`, `-2`, … . Reserve
   a candidate with `open(..., "wx", 0o600)`; on `EEXIST`, increment and retry.
4. Write the exact bytes, file-sync, close, and enforce mode 0600. File open,
   write, sync, close, or preservation failure is fatal.
5. While the source handle remains the identity authority, `lstat` the source
   path again and require it still names that handle's device/inode/type before
   removal. Any replacement aborts without deletion. Remove the verified source
   and sync the directory best-effort. A crash between preservation and removal
   may leave both copies but never loses or overwrites evidence.

Concurrent quarantiners therefore cannot replace each other's destination.
An unreadable source cannot be preserved byte-for-byte; load returns
`unreadable`, and save preflight refuses to overwrite it until the operator
repairs/removes it. Quarantine/save error messages name the source and recovery
action but never include token contents.

### Atomic save and directory security

Reuse `writeFileAtomic` and `fsyncDirectory` from
`src/engine/fsutil.ts:10-67`, with a sibling temp opened `wx` at mode 0600:

1. validate/create `~/.rbox` as a real directory at 0700;
2. reject any symlink/non-directory component using an `lstat` walk (the current
   `ensureDirectoryChain` at `fsutil.ts:70-101` provides the base mechanic);
3. refuse if the secret parent `~/.rbox` is not owned by the effective user or
   `(mode & 0o022) !== 0`; ownership/mode applies to the secret parent, not
   system ancestors such as `/home` or `/Users`;
4. refuse a symlink or non-regular destination and run invalid-file quarantine
   preflight while holding `credentials.lock`;
5. write the whitelisted v1 JSON to the sibling temp, file-sync, close, recheck
   the safe parent/destination seam, atomically rename, then directory-sync and
   release `credentials.lock`.

Temp creation, file write/sync/close, safety checks, and rename failures are
fatal. Only directory-sync failures are best-effort and privacy-safely logged.
The sequence is supported on the released Apple Silicon macOS and Linux targets
and matches the repository's existing atomic-write mechanics. This is the
documented model for future local secret material; no other secret file migrates
in this unit.

### Caller-policy matrix

Callers consume the typed result; none may use truthiness or map a degraded
state to absence.

| Policy | Production surfaces | Required behavior |
|---|---|---|
| Strict authenticated/mutating | account link/status/unlink; billing subscribe/portal; usage; export; device and API-key operations; E2EE build/recovery; recover; track; init continuation; setup account detection/enrollment/polling/workspace mutation; autostart desired-state mutation | `valid` proceeds; `absent` retains today's signed-out/first-run guidance; `corrupt`, `unreadable`, `unsupported-version`, and `invalid-environment` stop before authenticated network or local mutation with path/variable, state, and recovery guidance. |
| First-run/guided | `runInit`, setup account detection/enrollment, workspace picker, polling | `absent` is normal first run; degraded is not absence and fails closed at the boundary. |
| Account summary/local status | `fetchAccountSummary`, `statusCmd` | return/render explicit `credential-degraded` and continue local status. Pass the one typed load into account summary and JSON helpers; remove `statusCmd`'s current double load at `status-cmd.ts:265,304` → `account-cmd.ts:68-69`. |
| Doctor | credential check plus remaining doctor checks | add an explicit credential file-state check and continue all safe checks. Indirect remote builders receive the already-loaded result and cannot relabel degradation as signed-out. |
| Autostart status | status read | render `credential-degraded`, never catch-to-absence. |
| Boot resume | login-time resume | `absent` logs not logged in; degraded logs the actionable state and starts zero daemons. |
| Uninstall risk probe | recovery-kit/key-risk warning | continue uninstall, but emit explicit “credential degraded; backup risk unknown” instead of treating catch/failure as no risk. Unit 3's daemon confirmation gate still applies. |
| Logout | `clearCredentials()` | clears without load unless it cannot do so safely. Normally acquires and holds `credentials.lock` through unlink and is definitive. Acquisition failure or any post-acquisition fence/publication failure enters the logout-only override, which reruns save's safe-chain/no-follow/ownership/mode/seam validation before deleting exact credential/lock/fence paths. Unprovable safety refuses with the manual remedy; safe override deletion verifies absence and prints the idempotent concurrent-sign-in remedy because it is non-definitive (`auth-cmd.ts:343-348`). |
| Login/save | bootstrap, device approval, pairing, keyed setup | may authenticate without prior load, but save preflight preserves invalid readable disk evidence and refuses unreadable/symlink/unsafe-parent overwrite. |
| Environment override | any caller with `RBOX_TOKEN` | typed valid env source independent of disk; invalid auxiliary values return `invalid-environment` naming the variable and fail closed in strict flows; no disk quarantine on load. |

The strict policy includes the local `auth-cmd.ts` `requireCreds()` wrapper at
`:351-355` and its device approve/list/pair/revoke consumers. Diagnostic helpers
keep their existing never-throw/offline contracts while adding
`credential-degraded` rather than silently returning `signed-out`.
`invalid-environment` is a degraded state everywhere the matrix says degraded;
diagnostic surfaces name its variable while strict flows fail closed.

### Unit 4 tests

1. Credential parser tests cover v1, every legacy unversioned shape, malformed
   `v`, future `v`, bad required/optional fields, tolerated extensions returned
   on read, and extensions dropped on save.
2. Typed state tests cover absent, truncated JSON, bad schema, future version,
   chmod-000/unreadable, symlink destination, non-regular destination, and each
   invalid auxiliary env variable as `invalid-environment` with no disk read or
   quarantine.
3. Quarantine tests assert exact original bytes, mode 0600, timestamp collision
   counter suffixes, separately spawned load/save process serialization, no
   overwrite, crash between copy and source removal, and save-preflight through
   direct `rbox login`. Lock tests cover fresh contention, five-minute stale
   takeover, heartbeat, PID/process-start/nonce markers, competing fenced
   takeovers, abandoned-fence dead-incarnation recovery, indeterminate-fence
   refusal, resumed stale holders, failure release, and refusal to remove a
   successor marker.
4. Atomic-save tests inject temp-write, file-sync, pre-rename, rename, and
   directory-sync failures; only directory sync may leave a successful save.
5. Directory tests cover unowned parent, group-writable and world-writable
   `0o022` bits, symlinked `~/.rbox` and ancestor components, seam swaps, and
   secure 0700 creation. Source tests inject `lstat`→open, open→`fstat`, and
   pre-removal identity swaps and prove no replacement is deleted.
6. Add a native macOS-focused atomic save/quarantine test in addition to Linux
   CI coverage.
7. Migrate all direct and injected load callers to the typed result. Table-driven
   caller tests prove strict fail-closed, diagnostic continuation,
   `credential-degraded`, boot-resume zero-start, uninstall unknown-risk warning,
   safe logout recovery/refusal, valid and invalid env override, and single-load
   status behavior.
8. Fault every main-lock and fence-marker publication seam before and after temp
   file sync, close, hardlink, and temp cleanup; the final path is always absent
   or a complete valid marker. Cover hardlink `EEXIST`, unsupported-link failure,
   takeover installation, fence reacquisition, and malformed-final-marker
   refusal as tampering rather than crash debris.
9. Logout tests prove normal contention waits and serializes through credential
   unlink with no in-flight-save republish, and stale takeover uses the normal
   policy. Retry exhaustion, malformed/future-marker refusal, and every
   post-acquisition fence acquisition/reacquisition/publication/ownership/release
   failure enter the sanctioned destructive-recovery override. A safe chain
   removes the exact lock/fence/credential paths, verifies absence, and emits the
   exact idempotent concurrent-sign-in remedy without claiming definitive cleanup;
   a concurrent-sign-in fixture republishes after override cleanup and proves a
   second `rbox logout` is a safe, successful remedy. Symlinked,
   unsafe-mode/unowned, unreadable, or seam-swapped chains remove
   nothing and print the manual remedy. Capability tests prove load, save,
   quarantine, login preflight, and generic lock code cannot call that override.

Unit 4 adds a user-visible changelog entry for typed corruption handling and
the refusal of unsafe credential paths.

## Non-goals

- publish-engine selection, upload coordinator, state-store replacement,
  daemon/git decomposition, and route registry (audit phases 1–3);
- blob-pack rollback floor (design 149);
- changing canonical GC reachability/deletion decisions or collector caps in
  Unit 1;
- replacing design 149 Unit B's eventual collector ownership;
- the bounded-body sweep beyond the exact 19-route Unit 2 table;
- daemon lifecycle integrity, including process-incarnation attestation and the
  spawn/publication and live-PID-reuse races extracted to design 155;
- migration of local secret files other than credentials.

## Implementation shape — parallel development, ordered integration

Implementation may proceed in four worktrees, but integration is ordered:

1. **151-U1 merges first.** It owns GC observation/health, compatibility fields,
   drain migration, and GC tests; it does not edit `util.ts` or collector caps.
   Design 149 Unit B must then rebase over U1 and extend this health contract.
2. **151-U2 integrates next but is behaviorally independent of U1.** It owns
   `util.ts` request parsing, the exact route migrations, blob legacy dedupe,
   client 50k chunking, and their tests. Any trivial changelog conflict is
   rebased.
3. **151-U4 merges before U3.** It lands the typed credential result and migrates
   every caller, including shared `autostart-cmd.ts`, `uninstall-cmd.ts`, and
   tests.
4. **151-U3 rebases over U4 and merges last.** It adds typed stop outcomes and
   destructive caller policies without reverting the credential-policy matrix.

Parallel branches never resolve shared-file conflicts by preserving the old
`Promise<void>` stop type or old credential truthiness. Each integration step
runs its unit tests, all affected API/CLI suites, repository full gates, then
the test rig (`bun run rig`) or a dev build on the local fleet as required by
repository workflow. After the ordered train is assembled, run the full gates,
`/simplify`, and `/antislop-codebase`; merge only with green CI.

Every unit may add its changelog entry while accepting the shared `[Unreleased]`
insertion point as a trivial ordered-rebase conflict. No claim of four
independently mergeable PRs remains.

## Normative appendix A — verified `stopDaemon` caller inventory

The following inventory from `REVIEW-151.md`, with the binding round-2 stub
range corrections, is a normative migration checklist. `stopDaemon` is the sole
**escalation** controller, not the sole TERM/deadline controller; rebind retains
the no-escalation path named in the inventory:

> Complete production `stopDaemon` inventory: direct untrack; the
> `stopDaemonAndRecordDesired` wrapper reached by `rbox stop`, deprecated
> `rbox daemon stop`, and front-door Pause; upgrade restart; uninstall desired rows.
> Rebind is *not* a caller: `startDaemon` has its own SIGTERM + 5-second +
> `retry-later`, explicitly no-SIGKILL path (`daemon-control.ts:330-356`). Daemon
> self-shutdown is separate and drains the pump
> (`src/cli/daemon/daemon.ts:650-693,2335-2362`). The dispatcher's automatic true
> confirmation has exactly one consumer: untrack (`main-dispatch.ts:161-172`).
> Direct `stopDaemon` tests are `src/cli/daemon-stop.test.ts:23-103`; injected
> stopper contracts are exercised by `autostart-cmd.test.ts:55-61,150-188`,
> `upgrade-daemons.test.ts:44-113`, and
> `uninstall-cmd.test.ts:26-36,48-96`. Those stubs currently resolve `void` and
> are part of the typed-outcome migration.

The inventory was reverified against the current tree. The concrete function
now spans `src/cli/daemon-control.ts:398-452`; the review's branch anchors remain
inside it. `front-door.test.ts:99-115` covers front-door choice/action dispatch
through an injected `pauseSyncing`; it does not exercise
`stopDaemonAndRecordDesired` or desired-state preservation. Unit 3 adds that
default-wrapper routing regression.

## Normative appendix B — verified `loadCredentials` caller inventory (verbatim)

The following inventory from `REVIEW-151.md` is incorporated verbatim and is a
normative migration checklist:

> The complete production import/wrapper inventory found is: direct imports in
> `account-cmd.ts`, `auth-cmd.ts`, `autostart-cmd.ts`, `doctor-cmd.ts`,
> `e2ee-client.ts`, `init-cmd.ts`, `key-cmd.ts`, `recover-cmd.ts`, `setup-cmd.ts`,
> `status-cmd.ts`, `track-cmd.ts`, and `uninstall-cmd.ts`; the
> `requireCredentials()` wrapper in `credentials.ts`; and its consumers in
> `account-cmd.ts`, `subscribe-cmd.ts`, `usage-cmd.ts`, and `export-cmd.ts`.
> Dependency-injected load sites in autostart, init, recover, setup, and track use
> `typeof loadCredentials` and therefore also change type. No other production
> caller was found.

This was reverified against current imports and injected declarations. In
addition to the file-level inventory, `auth-cmd.ts:351-355` has its own local
`requireCreds()` wrapper; it is included in Unit 4's strict policy. Nested loads
in doctor/recover/setup must receive or propagate the first typed result rather
than erasing a degraded state.

## Normative appendix C.2 — verified bounded-body route inventory (verbatim)

The following reviewer inventory is incorporated verbatim and is normative;
the exact cap/field contract is the 19-row table in Unit 2:

> The body-parsing routes
> apparently in scope are:
>
> - auth/device/pair: POST device start, poll, bootstrap, approve; pair create and
>   redeem (`apps/api/src/routes/auth.ts:10-20,26-30`;
>   `auth/device-code.ts:27,50,121`; `auth/bootstrap.ts:18`;
>   `auth/pairing.ts:47,91`);
> - account link: POST start, confirm, redeem (`apps/api/src/routes/account.ts:14-18,
>   28-30`; `apps/api/src/account-link.ts:46,139`);
> - keys: POST api, bootstrap, device, roster, admit, keystate, workspace
>   (`apps/api/src/routes/keys.ts:12-24`).
>
> GET lookup/status/list and API-key revoke do not parse JSON.

Round-1 ruling 6 added authenticated `POST /v1/blobs/check` and public
unauthenticated `POST /v1/web/session`. Round-2 ruling 6 adds public,
signature-verified `POST /v1/stripe/webhook` as row 19; it is the RAW-body
exception to `cappedJson`. Current dispatch is verified at
`routes/blobs.ts:12-13`, `routes/web.ts:4-8`, and
`apps/api/src/routes/billing.ts:5-9`; the handlers are
`apps/api/src/blobs.ts:120-207`, `apps/api/src/clerk.ts:110-115`, and
`apps/api/src/stripe.ts:128-173`.

## Anchor verification ledger

All anchors used above were checked against the current worktree on 2026-07-17:

- **Unit 1:** root cap/traversal `apps/api/src/versions.ts:28-30,49-125`;
  formulas/snapshot/state `:130-146,179-215,488-500`; purge terminal paths
  and release helper `:287-301,500-540`; admin pass-through
  `apps/api/src/routes/admin.ts:159-184`; cron
  `apps/api/src/worker.ts:114-141`; drain `scripts/gc-drain.ts:19-89`.
- **Unit 2:** counting reader `apps/api/src/util.ts:19-55`; blob parser and
  branches `apps/api/src/blobs.ts:120-207`; accounted-ref ceiling
  `apps/api/src/commit-accounting.ts:43-49`; no-total-cap helper
  `apps/api/src/d1-batch.ts:33-35`; Stripe dispatch/handler
  `apps/api/src/routes/billing.ts:5-9`, `apps/api/src/stripe.ts:128-173`;
  client caps/chunking
  `src/cli/publish-pipeline/shared.ts:80`,
  `src/cli/publish-pipeline/pipeline.ts:49,196-206`, and
  `src/cli/sync-recovery.ts:94-99,293-311`; route/validator anchors are preserved
  verbatim in Appendix C and expanded by the Unit 2 table; unsafe display
  slicing sites `apps/api/src/auth/pairing.ts:97` and
  `apps/api/src/authz.ts:81`.
- **Unit 3:** process probe, PID record, and stop controller
  `src/cli/daemon-control.ts:202-268,398-452`; untrack
  `src/cli/untrack-cmd.ts:24-73,81-102`; existing sync mutex acquisition and
  release behavior `src/cli/sync-mutex.ts:125-183`; wrapper
  `src/cli/autostart-cmd.ts:197-202`; front-door default routing
  `src/cli/front-door.ts:71-82`; upgrade
  `src/cli/upgrade-cmd.ts:52-104`; uninstall
  `src/cli/uninstall-cmd.ts:61-88,99-118`; registry/dispatch/alias
  `src/cli/help-registry.ts:122-126,237-243`,
  `src/cli/main-dispatch.ts:125-172,339-341`, and
  `src/cli/deprecations.ts:48-52`.
- **Unit 4:** DTO/load/save `src/cli/credentials.ts:11-18,38-70`; login/logout
  `src/cli/auth-cmd.ts:211-289,343-355`; status double load
  `src/cli/status-cmd.ts:265,304` plus `src/cli/account-cmd.ts:68-89`; doctor
  `src/cli/doctor-cmd.ts:452-478`; atomic helpers
  `src/engine/fsutil.ts:10-67` and safe-chain base `:70-101`; current direct
  clear `src/cli/credentials.ts:69`, bigint marker observation
  `src/engine/git/lockfile.ts:518`, and temp+fsync+hardlink publication
  `src/engine/git/lockfile.ts:709`.
