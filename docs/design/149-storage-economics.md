# 149 — Storage economics: O(change) commits and fair-use enforcement (v5)

v5 after review round 4 (CHANGES-REQUIRED, 5 substantive findings plus three
editorials — REVIEW-149.md). All round-4 orchestrator rulings are binding.
This revision makes encoding overrides independent per axis, states the
bounded concurrent-mutation overshoot as product semantics, bounds marginal
release work through a materialized per-SHA relation, accounts for every
commit mode for the full semaphore lifetime, and specifies the executable
production roots-format deploy floor. The next
free D1 migration is `apps/api/migrations/0029_storage_economics.sql` (the
current tail is `0028_fleet_alert_state.sql`); Unit A's index and Unit C's
ledger/`fairuse_sha_last` tables plus `meta_deploy_floor` share that one
append-only migration.

## Problem, with field evidence

The founder account hit its 250GiB cap on 2026-07-16 with 4.3GiB of active
data. The design-142 storage-truth measurement (2026-07-17, partition exact
at 940,446/940,446 entitlement rows; digest in Appendix A) decomposed it:

- **~181 GiB = encrypted manifests.** 4,344 blobs in the 10–100MB band vs
  4,780 retained sequences (`commits` D1 count for `ws_2b6e15da…`). Every
  commit stores the complete manifest as raw JSON (39–41MB at ~112k refs,
  `CHANGELOG.md:446-455`) encrypted with a fresh random nonce
  (`src/engine/e2ee/manifest-crypto.ts:42`) — deliberately non-convergent.
- **~10 GiB = refset sidecars.** 5,320 blobs in the 1–10MB band. At
  ≥`SIDECAR_THRESHOLD` (4,000) unique refs the client uploads the complete
  canonical `(encSha,size)` set, `18 + 40×count` bytes
  (`src/engine/refset.ts:25-27,47-49`), before every commit
  (`src/cli/e2ee-remote.ts:703-720`). High-entropy bytes; compression
  cannot help.
- Git bundles are a minor term: incremental chains ship default-on
  (bound at `src/engine/manifest-validate.ts:19,318-325`, writer decision
  `src/cli/sync-git/shared.ts:136-137`); file encryption is convergent
  (`src/engine/crypto.ts:141-143`).

Design 84 built the manifest fix (snapshots 24× smaller + O(change)
deltas), merged 2026-07-12, write-gated behind `RBOX_MDE_SNAPSHOT` /
`RBOX_MDE_DELTA` (`src/cli/e2ee-remote.ts:73-80`). v1.7.1 flipped the
snapshot default using a MANUAL device-inventory check (PR #309) — valid
only while every device can be enumerated by hand. No delta encoding
exists for refset sidecars.

**Target end-state: steady-state storage growth proportional to bytes
actually changed, bounded by a floor-adjusted fair-use multiple of active
data.**

## Scope

1. **Unit A — capability-gated envelope defaults** (replaces the v1.7.1
   manual check; also carries delta default-on).
2. **Unit B — refset sidecar delta encoding**, client AND server.
3. **Unit C — fair-use history enforcement** with a durable scan ledger,
   plus the retention grace read fix.

Non-goals unchanged from v1: git-plane bundle retention (recon archived in
REVIEW-149 context; smallest term), commit debouncing (§8 rider), pack-gc
execute mode, pricing/tier changes. DROPPED from v1 per F16: clearing
`grace_until` on paid upgrade (would fork admin vs Stripe state machines
and reopen the anti-extension rule, `apps/api/src/stripe.ts:175-182`).

## Unit A — capability-gated envelope defaults

Review F1/F2 killed the v1 gate: `last_seen_version` is telemetry (a
headerless request refreshes `last_seen_at` while preserving the old
version, `apps/api/src/auth/authenticate.ts:56-75`), and a value first
seen in the commit RESPONSE cannot gate the commit already uploaded
(`src/cli/e2ee-remote.ts:789-806`).

### A1 — workspace capability generation (server)

Authentication already reads request-current `x-rbox-version` but drops it
from `Principal`; its telemetry write is throttled, best-effort, and preserves
an old value on a headerless request (`apps/api/src/auth/authenticate.ts:56-77`,
`apps/api/src/authz.ts:7-15`). `Principal` therefore gains
`requestVersion: string | null`, validated as strict SemVer; `null` means
absent, malformed, or invalid. This fact, never `last_seen_version`, is the
authority for the process making this request.

For every authenticated workspace contact (`latest`, `commits`, historical
manifest read, commit, receipt redemption, and initial WebSocket connect),
the Worker deletes client-supplied copies and sets these trusted internal
headers, extending the existing account/epoch forwarding seam at
`apps/api/src/routes/sync.ts:28-45`:

```text
x-rbox-capability-principal: <Principal.deviceId>
x-rbox-capability-fact: base64url(JCS({kind:"device"|"api_key"|"web",version:string|null}))
x-rbox-capability-summary: base64url(JCS({
  complete:boolean,
  populationCount:integer,
  floors:{mdeSnapshot:boolean,mdeDelta:boolean,refsetDelta:boolean}
}))
```

The WorkspaceSync DO creates these internal SQLite tables during its lazy
bootstrap (the existing DO tables are created at
`apps/api/src/workspace-sync.ts:197-203`):

```sql
CREATE TABLE IF NOT EXISTS capability_principals (
  principal_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('device','api_key')),
  version TEXT,
  mde_snapshot_incapable_at INTEGER,
  mde_delta_incapable_at INTEGER,
  refset_delta_incapable_at INTEGER,
  last_contact_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS capability_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  gen INTEGER NOT NULL,
  mde_snapshot INTEGER NOT NULL,
  mde_delta INTEGER NOT NULL,
  refset_delta INTEGER NOT NULL,
  mde_snapshot_lowered_gen INTEGER NOT NULL,
  mde_delta_lowered_gen INTEGER NOT NULL,
  refset_delta_lowered_gen INTEGER NOT NULL
);
```

Bootstrap inserts singleton generation 1 with all three floors false and all
lowered-generation counters 0; there is never an implicit all-true state.

Before dispatching the requested DO action, a `device`/`api_key` fact updates
`version` and `last_contact_at`. For each floor that this request-current
version cannot read, it also sets that floor's `*_incapable_at=now`; a null
version sets all three. A capable contact MUST NOT clear or refresh any
`*_incapable_at`, because an old daemon and new CLI can share one `deviceId`
(`apps/api/src/auth/authenticate.ts:61-68,77`). Only a new incapable contact
refreshes the affected timestamp. Each timestamp remains sticky until
`now - *_incapable_at >= CAP_STICKY_HOURS*60*60*1000`, with
`CAP_STICKY_HOURS=24`, then expires during recompute. Timestamps are per-floor:
a refset-incapable contact cannot accidentally refresh an older manifest
incapability. `web` is ignored.

Effective floors are the component-wise AND of the complete Worker summary
and every unexpired sticky incapable observation. Any tuple change increments
`gen`; each TRUE→FALSE transition records its `*_lowered_gen`. The 24-hour
sticky window is independent of the 30-day directory population/exclusion
window below.

The production early-stale optimization cannot skip contact. Every commit
first commits its observation update and preliminary floor recompute in a
small `transactionSync` before any `earlyStaleReject` call. It may then return
the existing stale-head 409. A non-stale commit re-reads authoritative floors
and generation and applies the declaration check inside the final head-CAS
`transactionSync` at exactly `workspace-sync.ts:669-695`; no external I/O is
inside that transaction. Thus
`RBOX_COMMIT_EARLY_REJECT` changes I/O only, not capability observation
(`apps/api/src/workspace-sync.ts:501-517,565,640,649,669-695`; production flag
at `apps/api/wrangler.jsonc:102-106,184`).

Failure is fail-closed: directory query error/overflow forwards
`complete:false` and all-false floors; missing/malformed fact marks the named
principal incapable; missing/malformed summary forces all floors false. If
the Worker cannot deliver the contact to the DO, keys/latest/write returns
`503 {"error":"capability_unavailable"}` and no capability is issued or head
published.

Population and constants are pinned, rather than left to implementation:

| Item | Executable contract |
|---|---|
| Population | `kind IN ('device','api_key')`, `revoked=0`, `last_seen_at >= now-30d`, and `expires_at IS NULL OR expires_at>now`; `web` excluded |
| Bound | `CAPABILITY_POPULATION_MAX=1024`; query `LIMIT 1025`, with row 1025 making the summary incomplete/all-false |
| Sticky incapable observation | `CAP_STICKY_HOURS=24`; capable contacts never clear or refresh it |
| `MDE_SNAPSHOT_MIN_VERSION` | `1.1.0` |
| `MDE_DELTA_MIN_VERSION` | `1.1.0` |
| `REFSET_DELTA_MIN_VERSION` | `1.8.0`, reserved as the first release containing B readers/base reconstruction |

The Worker uses `dirDb`, parses versions in code (never SQL lexical order),
and runs the following bounded covering-index query. Credentials are on the
directory plane while the DO is account-data plane
(`apps/api/src/db.ts:13-25`); API keys are real `kind='api_key'` sync
principals (`apps/api/src/auth/api-keys.ts:45-55`,
`apps/api/src/worker.ts:421-439`).

```sql
-- apps/api/migrations/0029_storage_economics.sql
CREATE INDEX IF NOT EXISTS idx_devices_capability_population
ON devices(account_id,kind,last_seen_at,expires_at,last_seen_version,device_id)
WHERE revoked=0 AND kind IN ('device','api_key');

SELECT device_id,kind,last_seen_version
FROM devices INDEXED BY idx_devices_capability_population
WHERE account_id=? AND revoked=0 AND kind IN ('device','api_key')
  AND last_seen_at>=? AND (expires_at IS NULL OR expires_at>?)
ORDER BY kind,last_seen_at,expires_at,last_seen_version,device_id
LIMIT 1025;
```

These are real `devices` columns from migrations 0004, 0010, 0022, and 0026;
the current index covers only `(account_id,expires_at,created_at)`
(`apps/api/migrations/0015_device_management.sql:3-13`).

### A2 — pre-write pinning (client) and admission (server)

Direct push has no pre-encoding `/latest`; the unconditional round trip is
the account-key refresh at `src/cli/e2ee-remote.ts:661-671,886-892` (workspace
KEKs may be cache hits at `:912-929`). New sync code therefore calls:

```text
GET /v1/keys/account?workspaceId=<urlencoded>&projectId=<urlencoded>
```

The Worker authorizes that workspace, performs the capability contact, and
splices this into the existing keys body (`apps/api/src/keys.ts:80-104`):

```text
POST https://do/capability?ws=<urlencoded>&proj=<urlencoded>
```

That fixed, Worker-internal DO request carries the three trusted headers from
A1, runs normal lazy workspace bootstrap, and returns only the capability
object. A non-2xx/malformed response becomes `capability_unavailable`; this
is an internal subrequest, not a new client round trip.

```json
{"recoveryWrap":"... or null","recoveryWrapId":"... or null",
 "rosters":["..."],"keyStates":["..."],
 "devices":[{"deviceId":"...","sigPubkey":"... or null",
             "encPubkey":"... or null","mkWrap":"... or null"}],
 "capability":{"gen":17,"floors":{"mdeSnapshot":true,
   "mdeDelta":true,"refsetDelta":false}}}
```

Calls without both query fields retain the old setup/admission response;
new sync code treats a missing capability as all-false. `/latest` carries
the same object in both exact existing shapes, with the grant still an
optional Worker splice (`apps/api/src/routes/sync.ts:57-75`,
`workspace-sync.ts:1187-1193`):

```json
{"sequence":0,"commit":null,"capability":{"gen":17,"floors":{
  "mdeSnapshot":true,"mdeDelta":true,"refsetDelta":false}},"grant":"optional"}
{"sequence":42,"commit":{"body":"...","commitHash":"...","sig":"..."},
 "capability":{"gen":17,"floors":{"mdeSnapshot":true,
  "mdeDelta":true,"refsetDelta":false}},"grant":"optional"}
```

The client pins that response before encoding. `CommitBodyBase` gains signed
canonical fields (JCS signing is at `src/engine/e2ee/commit.ts:123-145`):

```ts
capabilityGen?: number;
manifestEncoding?: "raw" | "snapshot" | "delta";
refsetEncoding?: "full" | "delta";
manifestOverride?: true;
refsetOverride?: true;
```

New writers always send a nonnegative safe-integer `capabilityGen` plus
`manifestEncoding` and `refsetEncoding` together. An explicit manifest
force-on sends `manifestOverride:true`; an explicit refset force-on sends
`refsetOverride:true`. Each field describes and bypasses only its own axis.
The Worker view at
`apps/api/src/commit-envelope.ts:53-64` gains the same fields. The fields are
independent, so every cross-product is legal, including a force-raw manifest
with a delta refset.

This is a cooperative compatibility protocol for well-behaved clients, NOT
a security, authorization, content-proof, or enforceable encoding boundary.
The authenticated client already controls its own opaque signed data; the
harm model is self-account cross-device breakage, never cross-account access.
The DO JSON-parses a few visible fields but neither decrypts the manifest nor
verifies the commit signature/canonical form
(`apps/api/src/workspace-sync.ts:105-109,441-465`;
`apps/api/src/commit-envelope.ts:45-64`). In particular, raw and snapshot both
have an empty chain before encryption
(`src/cli/e2ee-remote.ts:751-755,783-788`), so the server cannot prove their
actual class. The signed declaration is an honest-client promise that peers
verify, and admission applies compatibility floors to that promise.

Whenever either declaration is present, both MUST be present and
`capabilityGen` MUST be a nonnegative safe integer no greater than current
`gen`, including raw/full and per-axis override commits. Admission is the
cross-product of these independent rows:

| Axis | Declared value | Floors ordinarily required | Permitted override and exact effect |
|---|---|---|---|
| manifest | `raw` | none | none; `manifestOverride` is invalid |
| manifest | `snapshot` | `mdeSnapshot` | `manifestOverride:true` bypasses only this row's manifest floor/lowered-generation tests |
| manifest | `delta` | `mdeSnapshot`, `mdeDelta` | `manifestOverride:true` bypasses only this row's manifest floor/lowered-generation tests |
| refset | `full` | none | none; `refsetOverride` is invalid |
| refset | `delta` | `refsetDelta` | `refsetOverride:true` bypasses only this row's refset floor/lowered-generation test |

For every non-overridden relied-on floor, its current value must be true and
`capabilityGen >= *_lowered_gen`. A manifest override never bypasses a refset
test, and a refset override never bypasses a manifest test. Neither override
bypasses the generation bound or B's independently verifiable refset framing,
hash, entitlement, count, and accounting checks. Unknown enum values, only one
declaration, either override encoded as `false`, an override on a raw/full row,
or any override without both declarations are 400. A visible refset declaration
must agree with the B descriptor (`full` for inline/legacy/RSD-full, `delta`
for RSD-delta); that proves the refset wire form, not the encrypted manifest
class. Manifest-chain shape is retained and validated for ordinary protocol
safety but is not treated as proof of the declared raw/snapshot/delta class.
A failed compatibility gate is
`409 {"error":"capability_stale","capability":{"gen":18,"floors":{...}}}`;
the transport must distinguish it from today's generic conflict collapse at
`src/cli/remote/commits.ts:311-320`, re-pin through account keys, and encode
again before uploading.

**Legacy-absence rule and v1.7.1 transition.** If both declarations are
absent, admit permanently without a generation and regardless of floors. If
the visible `manifestChain` is nonempty, admit and log exactly
`legacy_chain_commit`; the only known writers with this shape are force-on
fleets. There is no structural raw/snapshot classification and no floor-off
branch on this path. If only one declaration is absent, reject 400 rather
than guessing. This exception is required because released v1.7.1 emits no
declarations and raw and snapshot are indistinguishable ciphertext today
(`src/cli/e2ee-remote.ts:783-795`). v1.7.1 remains on its manual inventory
gate until the new declaring client ships; new founder force-on clients send
both actual declarations plus only the override field(s) for the force-on
axis or axes. The gate can never brick the released fleet.

### A3 — defaults and flag seams

- With floors true, writers default to snapshot AND delta in the same
  release (founder default-on ruling 2026-07-18: the floor mechanism IS
  the bake gate — a floor that is satisfiable graduates immediately;
  staging an extra release adds delay without adding safety, since both
  encodings share the identical Phase-B reader floor).
  Env flags become tri-state overrides at BOTH seams — `mdeWriteCaps()`
  (`src/cli/e2ee-remote.ts:73-80`) and push's deltaBase selection
  (`src/cli/sync/push.ts:629-636`): `RBOX_MDE_SNAPSHOT="0"` is the emergency
  kill switch and wins over every other manifest flag: it forces raw and
  disables delta even when `RBOX_MDE_DELTA="1"`. That contradictory pair is
  accepted, logs warning `mde_delta_ignored_snapshot_kill_switch`, and sends no
  manifest override. Otherwise `RBOX_MDE_DELTA="1"` forces delta ELIGIBILITY
  (and therefore snapshot) with `manifestOverride:true` — design 84's
  no-base/economic fallback still emits its actual `snapshot` declaration
  (with `manifestOverride:true`) when it degrades; `RBOX_MDE_SNAPSHOT="1"` with delta
  not force-on emits snapshot with `manifestOverride:true`; delta `"0"`
  disables delta without disabling a snapshot; and each unset flag is
  floor-driven unless the other manifest flag has selected a forced class.
  This prevents a snapshot-only force-on from silently overriding a
  floor-driven `mdeDelta` check. Refset full/delta has its own independent
  `RBOX_REFSET_DELTA` tri-state: `"0"` force-full/reanchor, `"1"` force-delta
  with `refsetOverride:true` when verified base evidence exists, unset →
  `refsetDelta` floor-driven.
  Manifest force-raw neither disables nor reanchors a valid refset delta.

### A4 — the exclusion ruling and day-31 semantics (explicit, per F3/F4)

- **Product ruling (amends design 84's open compat window, requires
  founder sign-off at review exit):** a device absent for
  > `CAP_WINDOW_DAYS` days no longer holds back the workspace's floors.

**Day-31 semantics per surface for an excluded pre-Phase-B device:**

- **pull/sync**: decrypt succeeds, JSON.parse of the envelope fails →
  the generic manifest-validation error, NOT a friendly message
  (design 84 records pre-B readers have no envelope handling,
  `84:1063-1076`). Accepted: pre-B binaries cannot be taught new error
  text retroactively. Mitigation: the release notes and site FAQ carry
  the "upgrade rbox" translation; Phase-B+ devices (v1.1.0+, all known
  real devices) get the typed fail-closed error already shipped.
- **push**: the stale device may upload a raw-v0 manifest and win a
  legacy-absent commit (which always admits), re-entering the recent set
  and lowering floors via A1's recompute — the system heals toward the
  most conservative live population automatically. A new declaring raw
  commit still needs a valid generation but no floor. An orphaned uploaded
  manifest blob from a lost race is reclaimed by Phase 1 as unrooted.
- The v1.7.1 manual flip remains in force until A ships; A replaces it.

## Unit B — refset sidecar deltas

Review F6–F10: the server is a full sidecar READER (admission expansion
`apps/api/src/workspace-sync.ts:556-580`, GC roots
`apps/api/src/versions.ts:95-109`, commit-delta admission
`apps/api/src/commit-delta.ts:40-94`), and one hash cannot be both the
carrier address and the reconstructed-set identity. v4 wire contract:

### B1 — two identities, both signed

- `carrierSha = sha256(envelopeBytes)` is the R2 address; it is omitted
  from the header to avoid a circular hash. `resultSha =
  sha256(canonicalFullBytes)` identifies the reconstructed full set. The
  canonical full serialization remains today's byte-locked
  `rbox-refset-v1` (`src/engine/refset.ts:1-17,25-27,45-60,94-111`).
- The compatible signed descriptor name is retained but extended to
  `blobRefset:{sidecarSha,resultSha,count,totalBytes,chain}`. Here
  `sidecarSha` is the current `carrierSha`; `chain` contains parent carrier
  SHAs oldest→newest, excludes the current carrier, has no duplicates, and
  has length ≤15 (≤16 total carriers). The engine and Worker validators at
  `src/engine/e2ee/commit.ts:24-33,90-99` and
  `apps/api/src/commit-envelope.ts:53-96` accept the extended form.

Exact envelope layout:

```text
offset  size       value
0       10         ASCII "rbox-rsd1\n"
10      4          H, unsigned u32 big-endian
14      H          UTF-8 JCS(header)
14+H    remainder  kind-specific binary body
```

`1 <= H <= 4096`; the header must be an exact UTF-8/JCS round trip, have
exactly the keys for its kind, use lowercase 64-hex hashes and safe integer
counts/sizes, and leave no trailing body bytes.

- **Full:** exact header
  `{chain:[],count,kind:"full",resultSha,totalBytes}`;
  `parentCarrierSha` is forbidden. Body is the complete existing
  `rbox-refset-v1` bytes (14-byte magic, u32be count, then
  `count × (sha256[32] || size u64be)`). Therefore
  `resultSha=sha256(body)`.
- **Delta:** exact header
  `{chain,count,kind:"delta",parentCarrierSha,resultSha,totalBytes}`;
  chain is nonempty and `parentCarrierSha===chain.at(-1)`. Body is
  `u32be(addedCount) || addedCount×(sha256[32]||size u64be) ||
  u32be(removedCount) || removedCount×sha256[32]`. Both lists are strictly
  ascending and duplicate-free; they are disjoint; every removal exists in
  the parent, every addition is absent, and a SHA's size cannot mutate.
  Remove then add, serialize the result as `rbox-refset-v1`, and derive
  result/count/total from those bytes.

Legacy compatibility is explicit: a stored/current descriptor containing
only `{sidecarSha,count,totalBytes}` plus raw `rbox-refset-v1` bytes is an
implicit full anchor. Its `carrierSha` and `resultSha` are both
`sha256(rawFullBytes)`, its chain is empty, and it remains readable forever.
Only an `rbox-rsd1` descriptor may carry `resultSha/chain`; new full and delta
writers always emit the extended signed descriptor.

For a signed chain `[c0..c(n-1)]` and current `cn=sidecarSha`, fetch
oldest→current. The hash of link `i` is `ci`; its header chain is exactly
`[c0..c(i-1)]`; link 0 is full; every later link is delta whose parent is
`c(i-1)`. At client pull and server admission, header chain/result/count/
total MUST equal the signed descriptor; folded count and sum(size) equal
both copies; hash(canonical folded full) equals both result SHAs; and the
current envelope hash equals signed `sidecarSha`. Unknown/extra/missing
fields or any mismatch reject.

Golden vectors are structural so no hash is fabricated:

| Vector | Header JCS | Body bytes / derived values | Signed descriptor |
|---|---|---|---|
| Full A=`00×32,size=1`, B=`ff×32,size=258` | `{"chain":[],"count":2,"kind":"full","resultSha":"<sha256(fullBody)>","totalBytes":259}` | prefix `72626f782d727364310a || <u32be(utf8HeaderLength)> || <utf8(header)>`; fullBody `72626f782d7265667365742d7631 || 00000002 || (00×32) || 0000000000000001 || (ff×32) || 0000000000000102`; fullBody length 98 | `{sidecarSha:"<sha256(envelope)>",resultSha:"<sha256(fullBody)>",count:2,totalBytes:259,chain:[]}` |
| Delta: remove A, add C=`11×32,size=3` | `{"chain":["<baseCarrierSha>"],"count":2,"kind":"delta","parentCarrierSha":"<baseCarrierSha>","resultSha":"<sha256(canonicalChildFull)>","totalBytes":261}` | `00000001 || (11×32) || 0000000000000003 || 00000001 || (00×32)`; length 80; child order C,B | `{sidecarSha:"<sha256(deltaEnvelope)>",resultSha:"<sha256(canonicalChildFull)>",count:2,totalBytes:261,chain:["<baseCarrierSha>"]}` |

### B2 — server fold and verification (per F7/F9)

- Admission entitlement-gates the current and every parent carrier before
  R2 access, extending `apps/api/src/sidecar.ts:100-137`, then folds using
  B1's exact order and equalities. The publication/accounting union is the
  unique set `[encManifestSha,currentCarrier,...parentCarriers,
  ...manifestChain,...reconstructedDataRefs]`. Thus every parent goes
  through `validateCommitRefs` and `commitAccounting`, including the
  `blob_ref_candidates` and active-delete fences at
  `apps/api/src/commit-accounting.ts:95-145,204-218`; this replaces the
  current two-carrier union at `workspace-sync.ts:556-580`.
- Error taxonomy is stable: current carrier missing/unentitled/R2-missing
  remains 422 `unsatisfied_blobs`; the first parent missing, unentitled,
  R2-missing, or returned by validation/accounting because it is fenced is
  `422 {"error":"sidecar_parent_gone","parentCarrierSha":"...",
  "reanchor":"full"}`. The writer discards the delta attempt and retries
  a full anchor. Present but corrupt hash/framing/order/linkage/cross-field/
  fold result is `400 {"error":"bad_sidecar","message":"<stable reason>"}`.
  An active `gc_candidates.deleting_at` remains fenced even with a receipt;
  it must finish before a full retry can republish that object
  (`apps/api/migrations/0024_gc_state.sql:17-45`). Never collapse a 422
  recovery condition into corrupt-400.
- Consumers (admission expansion, GC roots, storage-truth, commit-delta
  fast path) consume the reconstructed canonical representation. The commit-delta
  parent/child fixed-layout optimization is DISABLED for delta-carried
  commits in the first release (correctness first; reinstated against
  reconstructed buffers as a follow-up if measurement demands).

Fold and writer limits are executable:

| Budget | Limit / action |
|---|---|
| Total carriers | 16 current-inclusive; signed parent chain ≤15 |
| Cumulative R2 bytes | 32 MiB across full anchor and all deltas; sum R2-reported sizes before each allocation and stream/fold one carrier at a time |
| Reconstructed data refs | `dataRefCap = 250000 - |N|`, where `N` is the unique non-data set defined below; no global limit increase |
| Fold subrequests | ≤1 batched D1 entitlement check + ≤16 R2 GETs = 17, excluding existing bounded downstream accounting batches |
| Pure parse/fold CPU | `SIDECAR_FOLD_CPU_MS=500`; accumulate synchronous time after every carrier and every 5,000-record merge chunk |

CPU excess fails closed with 503 `sidecar_fold_budget` before accounting/head
move. Depth/byte/protocol excess is 400 `bad_sidecar`. The writer emits full
when projected chain bytes exceeds 32 MiB, total depth would exceed 16,
`deltaBytes >= 0.5*fullBytes`, threshold direction changes, or verified base
evidence is absent.

The 250,000 ceiling applies to the unique **whole accounting union**, not
data alone. Let `N` be the unique SHA set
`{encManifestSha,currentCarrier,...parentCarriers,...manifestChain}` and `D`
the reconstructed data-ref SHA set. The exact admission condition is
`|D ∪ N| <= MAX_REFS_PER_COMMIT=250000`, equivalently
`|D \ N| <= dataRefCap` where `dataRefCap=250000-|N|`. The client chooses
both chains, encodes and hashes the candidate carrier in memory to derive
`currentCarrier`, computes the exact union cap, and only then uploads. The
Worker recomputes it after fold and before validation/accounting and returns 413
`too_many_refs` on excess. Duplicate non-data SHAs count once. The global
limit is not raised.

Peak isolate memory is a protocol budget, not an inference from the 32 MiB
cumulative carrier limit. Replace the module-wide `isolateFoldActive` guard
at `workspace-sync.ts:736-744` with one shared `isolateHeavyFoldActive`
semaphore used by roots alarms, admission folds, and fair-use folds. The
commit route acquires it before decoding every commit request and holds it
until commit accounting has completed and every wire, parsed, fold, and
accounting allocation for that request has been released. Inline mode has no
early release. Thus the mode need not be known before gating and no two
admission requests, nor an admission and roots/fair-use fold, can overlap in
one isolate. Contenders in any DO instance fail/requeue before body allocation;
every success and error path releases in one `finally` after allocation
cleanup.

All modes use the bounded streaming request decoder. It compacts the capped
wire body/receipts directly into an at-most-8-MiB binary parsed slab and
releases the wire buffer; inline mode does not retain the deployed
`JSON.parse` object graph. The sidecar path additionally hashes and parses each
R2 stream in fixed chunks, merges binary `sha256[32]||size[8]` records, and
releases each Response/chunk and the prior canonical buffer as soon as
consumed. No mode materializes a 250,000-element string array/Set. SHA hex
strings exist only for one bounded accounting chunk and are released per
chunk.

With aggregate gated concurrency exactly one, the worst-case accounted live
set per isolate is:

| Live allocation | Sidecar maximum | Inline maximum |
|---|---:|---:|
| old canonical 250k set | 10,000,018 B | 0 B |
| merge output 250k set | 10,000,018 B | 0 B |
| compact parsed request/receipts | 8 MiB | 8 MiB |
| incremental decoder/parser/hash window | 1 MiB | 1 MiB |
| one accounting chunk | 1 MiB | 1 MiB |
| binary index, allocator, and JS/runtime allowance | 18,000,000 B | 18,000,000 B |
| concurrent gated operations | 1 | 1 |
| **mode total** | **48,485,796 B (<48 MiB)** | **28,485,760 B (<28 MiB)** |

Allocation high-water instrumentation enforces this model; inability to stay
within it fails 503 `sidecar_fold_budget` before head movement. Cumulative
R2 bytes, 17 fold subrequests, and 500 ms CPU remain independent limits.

### B3 — rooting (per F8 — the liveness blocker)

`seq_roots` is DO SQLite, not D1 (`workspace-sync.ts:197-203`), so its
normalized companion is created there, not in migration 0029:

```sql
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS seq_root_chains (
  seq INTEGER NOT NULL,
  ord INTEGER NOT NULL CHECK(ord>=0 AND ord<16),
  carrier_sha TEXT NOT NULL CHECK(length(carrier_sha)=64),
  PRIMARY KEY(seq,ord),
  FOREIGN KEY(seq) REFERENCES seq_roots(seq) ON DELETE CASCADE
) WITHOUT ROWID;
```

New objects create `seq_roots` with
`coverage_generation INTEGER NOT NULL DEFAULT 1`. Legacy objects run
`PRAGMA table_info(seq_roots)` once under the bootstrap single-flight and,
when absent, execute
`ALTER TABLE seq_roots ADD COLUMN coverage_generation INTEGER NOT NULL
DEFAULT 1` before creating the foreign-key child.

Rows are oldest→current (signed descriptor chain followed by current
`sidecarSha`); inline sequences have none. `seq_roots.carrier_sha` remains
during rollout as a current-carrier cache and MUST equal the last chain row.
Pre-RSD1 sidecars are full anchors, so bootstrap may seed their obvious
chain rows idempotently (this optimization does not mark coverage ready):

```sql
INSERT OR IGNORE INTO seq_root_chains(seq,ord,carrier_sha)
SELECT seq,0,carrier_sha FROM seq_roots WHERE carrier_sha IS NOT NULL;
```

The bounded authoritative backfill uses KV `roots_coverage_cursor`, initially
`pruneFloor+1`. Each alarm processes at most
`ROOTS_COVERAGE_SEQS_PER_ALARM=50` and 25 ms synchronous CPU: for each
retained `seq:*`, require and parse that authoritative record (legacy full,
RSD full/delta, or inline), then child-delete/non-delete-upsert its one
`seq_roots` parent and insert the normalized chain rows, set that row's
coverage=2, and advance the cursor in the same storage transaction. Missing
`seq:*`, parse failure, or a conflicting parsed sequence aborts without cursor
advance; a missing `seq_roots` row is created by the UPSERT.
Crash retries the same chunk. Concurrent new folds write coverage 2 and
their full chain from birth. When the cursor passes a freshly-read head, the
final transaction requires `index_state='ready'`, `index_synced_seq=head`,
exactly `head-pruneFloor` `seq_roots` rows in the retained range, and no row
below coverage 2; only then does it set KV
`roots_format_coverage_generation=2`. A missing cursor or generation means
generation 1, fail-closed.

For every new fold, the same transaction that writes `seq_roots` and
`index_synced_seq` executes this exact order: (1) `DELETE FROM
seq_root_chains WHERE seq=?`; (2) non-deleting `INSERT INTO seq_roots ... ON
CONFLICT(seq) DO UPDATE SET manifest_sha=excluded.manifest_sha,
carrier_sha=excluded.carrier_sha,coverage_generation=excluded.coverage_generation`;
(3) insert the replacement child rows oldest→current. Backfill, fold, and
rebuild use the same child-first replacement in one transaction. They MUST
NOT use SQLite `INSERT OR REPLACE` at the current write sites
(`workspace-sync.ts:775,812`), whose delete half would cascade children.
Raw-gap construction
reads the signed chain plus current carrier. A retained child consequently
roots every ancestor even after the ancestor's own sequence is pruned.

The platform-admin surface adds `GET` and `POST
/v1/admin/roots-coverage`, protected by `isPlatform` at the existing admin
routing seam (`apps/api/src/routes/admin.ts:130-134`). Both keyset-enumerate
the authoritative D1 `workspaces` table by
`(account_id,created_at,workspace_id,project_id)` with `LIMIT 51` (50 results plus an
overflow row) and return an exclusive opaque `nextCursor`. For each result,
the Worker dispatches to a dedicated internal DO `/roots-coverage` method
that runs normal lazy bootstrap—never the deliberately pre-bootstrap
`/roots-inspect` path at `workspace-sync.ts:138-144` (normal mutating paths
bootstrap at `:152-156`)—and returns
`{workspaceId,projectId,coverageGeneration,cursor,head,indexSyncedSeq,state}`.
`GET` reports status; `POST` also initializes/arms the bounded backfill. A
caller exhausts D1 pages; rollout is complete only when a fresh full pass has
no overflow/error and every authoritative workspace reports generation 2,
`state:"ready"`, and `indexSyncedSeq===head`. This also migrates cold DOs.

`/roots` and `/roots-inspect` sequence entries are additive
`{seq,manifestSha,carrierSha,chain:[oldest..current]}`; gap entries retain
their existing fields and add the same `chain`. `carrierSha` is retained
permanently with its exact deployed meaning—the current sidecar carrier,
equal to `chain.at(-1)` when a chain exists—not renamed, repurposed, or
removed. Inline sequences have no carrier and an empty chain.

The deployed four-page/20,000-sequence behavior and endpoint page caps remain
unchanged until both the GC collector (`apps/api/src/versions.ts:25-30,76-79,
91-109`) and storage-truth adapter (`scripts/storage-truth-live.ts:298-315,
514-529`) that understand additive `chain` and exhaust byte-bounded paging
are deployed and verified. Only then does the server enable the following
byte-bounded page contract; this activation still precedes every RSD1 writer.
`ROOTS_CHAIN_PAGE_BYTES=512*1024` bounds the exact UTF-8 JSON contribution
in addition to the 20,000-sequence ceiling: query ordered `(seq,ord)`, never
split a sequence, always emit at least one valid bounded sequence, and return
exclusive `nextSeq=last emitted`. The collector unions every `chain` SHA via
the existing deduper (`apps/api/src/versions.ts:49-55,90-109`) and replaces
the old four-pages×20k assumption with exact synchronous collector caps:
`MAX_CHAIN_ROOT_PAGES_PER_WORKSPACE=64`,
`MAX_CHAIN_ROOT_BYTES_PER_WORKSPACE=32*1024*1024`, and at most 64 chain-page
DO subrequests per workspace (the existing dropped-page cap remains 16).
Crossing any cap aborts the whole GC reachability pass fail-closed with
`chain-roots-page-cap` or `chain-roots-byte-cap`; it never returns a partial
root set.

Sweep/rebuild deletes parent `seq_roots` rows and uses FK `ON DELETE CASCADE`
to delete only those sequences' chain rows; tests also exercise explicit
child-first deletion if the DO runtime cannot enable foreign keys. The
current sweep site is `workspace-sync.ts:844-847`. Never delete a carrier
globally: duplicate rows under surviving sequences keep shared parents
rooted.

### B4 — writer state and thresholds (per F10)

Extend the verified global state slot at `src/cli/config.ts:132-143,177-220`
with optional, independently validated:

```ts
interface GlobalRefsetMeta {
  parentCarrierSha: string;
  parentResultSha: string;
  count: number;
  totalBytes: number;
  depth: number;
  chain: string[]; // ancestors only; excludes parentCarrierSha
  chainBytes: number;
}
```

Require `depth===chain.length+1<=16`, valid unique hashes, safe counts/sizes,
and `chainBytes<=32MiB`. Add `refsetMeta` beside `manifestMeta` in
`SyncState`, `StateSavePacket.global`, and `StateSource`; `validRefsetMeta`
fails closed, legacy-state projection clears it, and the existing atomic
global write (`config.ts:574-581`) saves/clears both evidence objects.

On a second device's first sidecar-bearing pull, verify the commit chain,
fetch/fold the signed descriptor chain, enforce B1, decrypt the manifest,
derive `serializeRefset(blobRefsForManifest(manifest))`, and require its
hash/count/sum to equal the signed result. Only then atomically save the
applied manifest and `GlobalRefsetMeta` (`src/cli/sync/pull.ts:272-277`). A
next writer derives base refs from that applied manifest and uses
`[...meta.chain,meta.parentCarrierSha]` as the new parent chain. Failure saves
no evidence and the next write is full. Inline pull clears it; crossing
`SIDECAR_THRESHOLD` in either direction is always a full re-anchor.

### B5 — rollout (per F10/F18)

Collectors deploy FIRST: GC and storage-truth accept both the old response and
the additive `chain`, preserve `carrierSha`, and exhaust the future byte/page
cursors while the server still emits the old format and caps. After those
collectors are verified, server codec+streaming fold+normalized rooting may
deploy and enable additive chain/byte-bounded pages. The admin coverage driver
then proves generation 2 for every D1-enumerated workspace. Client B readers
and base evidence ship in reserved v1.8.0 with writers still off; writer
default-on ships at least one release later behind Unit A's `refsetDelta`
floor. RSD1 writing is forbidden until collector verification, server reader
deployment, and roots coverage are all true. An old Worker rejects the new
magic fail-closed, but no capable writer exists before every Worker reads it.

## Unit C — fair-use history enforcement

### C1 — invariant (renamed per F13)

At quiescence, per account: `historyBytes ≤ 5 × max(activeBytes, 1 GiB)` —
the **floor-adjusted fair-use bound**, allowance account-global. Acceptance
uses this exact formula (a 100MiB-active account legitimately retains up to
5 GiB of history).

Concurrent account mutation deliberately has bounded, honest overshoot
semantics rather than a cross-DO serialization guarantee. A completed scan
may become stale after its full pre-batch re-probe and before the target DO
transaction. In that race, fair-use enforcement may prune at most one extra
batch: no more than 500 non-head sequences from the single globally oldest
eligible workspace, never a head and always drawn from the oldest retained
history within the plan's retention window. The successful movement retires
the epoch, so another batch requires a fresh scan. The re-probe keeps the stale
interval to the seconds needed to read at most 64 DO pins and dispatch one
target mutation; oldest-first puts any overshoot in the least-valuable retained
history.

### C2 — durable scan ledger (per F11)

Migration `0029_storage_economics.sql` adds the following account-data-plane
ledger beside Unit A's directory index. Its shape deliberately follows the
design-142 runner's durable workspace/pin/stream/root relations and atomic
page+cursor checkpoints (`scripts/storage-truth.ts:251-263,277-293,376-470`),
not v2's insufficient single cursor.

```sql
CREATE TABLE IF NOT EXISTS fairuse_scans (
  account_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>0),
  status TEXT NOT NULL CHECK(status IN (
    'capture_pins','materialize_roots','classify_entitlements','complete',
    'pruning','converged','aborted_pins','paused_grace',
    'invalidated_plan','paused_kill')),
  plan_snapshot TEXT NOT NULL,
  grace_until_snapshot INTEGER,
  roots_format_generation INTEGER NOT NULL,
  workspace_set_snapshot TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  workspace_cursor_created_at INTEGER,
  workspace_cursor_id TEXT,
  workspace_cursor_project TEXT,
  entitlement_cursor_sha TEXT,
  verify_cursor_id TEXT,
  verify_cursor_project TEXT,
  release_checkpoint TEXT,
  pending_prune_request TEXT,
  active_bytes INTEGER NOT NULL DEFAULT 0 CHECK(active_bytes>=0),
  history_bytes INTEGER NOT NULL DEFAULT 0 CHECK(history_bytes>=0),
  bound_bytes INTEGER NOT NULL DEFAULT 0 CHECK(bound_bytes>=0),
  pruning_active INTEGER NOT NULL DEFAULT 0 CHECK(pruning_active IN (0,1)),
  PRIMARY KEY(account_id,epoch)
);
CREATE INDEX IF NOT EXISTS idx_fairuse_scans_latest
ON fairuse_scans(account_id,completed_at DESC,epoch DESC)
WHERE completed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS fairuse_workspace_streams (
  account_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  pin_head INTEGER NOT NULL CHECK(pin_head>=0),
  pin_floor INTEGER NOT NULL CHECK(pin_floor>=0),
  pin_generation INTEGER NOT NULL CHECK(pin_generation>=0),
  pin_roots_format_generation INTEGER NOT NULL,
  roots_cursor TEXT,
  materialize_cursor TEXT,
  roots_done INTEGER NOT NULL DEFAULT 0 CHECK(roots_done IN (0,1)),
  pins_verified INTEGER NOT NULL DEFAULT 0 CHECK(pins_verified IN (0,1)),
  root_rows INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,epoch,workspace_id,project_id)
);
CREATE INDEX IF NOT EXISTS idx_fairuse_workspace_pending
ON fairuse_workspace_streams(account_id,epoch,roots_done,workspace_id,project_id);

CREATE TABLE IF NOT EXISTS fairuse_root_membership (
  account_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  head INTEGER NOT NULL CHECK(head IN (0,1)),
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  committed_at INTEGER,
  timestamp_gap INTEGER NOT NULL DEFAULT 0 CHECK(timestamp_gap IN (0,1)),
  PRIMARY KEY(account_id,epoch,workspace_id,project_id,sha256,head,sequence)
);
CREATE INDEX IF NOT EXISTS idx_fairuse_roots_membership
ON fairuse_root_membership(account_id,epoch,sha256,head);
CREATE INDEX IF NOT EXISTS idx_fairuse_roots_candidate
ON fairuse_root_membership(
  account_id,epoch,workspace_id,project_id,head,sequence,sha256
);

CREATE TABLE IF NOT EXISTS fairuse_sha_last (
  account_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  last_ws TEXT NOT NULL,
  last_proj TEXT NOT NULL,
  last_seq INTEGER NOT NULL CHECK(last_seq>=0),
  in_head INTEGER NOT NULL CHECK(in_head IN (0,1)),
  PRIMARY KEY(account_id,epoch,sha256)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_fairuse_sha_last_release
ON fairuse_sha_last(
  account_id,epoch,in_head,last_ws,last_proj,last_seq,sha256
);

CREATE TABLE IF NOT EXISTS fairuse_materialize_refs (
  account_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
  PRIMARY KEY(account_id,epoch,workspace_id,project_id,sequence,sha256)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS fairuse_leases (
  account_id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fairuse_scheduler (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  account_cursor TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fairuse_account_queue (
  account_id TEXT PRIMARY KEY,
  next_run_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fairuse_queue_due
ON fairuse_account_queue(next_run_at,account_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_account_scan
ON workspaces(account_id,created_at,workspace_id,project_id);

CREATE TABLE IF NOT EXISTS meta_deploy_floor (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

No foreign keys is intentional: account deletion adds explicit deletes for
these account-owned tables, and old epoch cleanup transactionally deletes
materialization rows, membership, `fairuse_sha_last`, workspace streams, then
the scan row by `(account_id,epoch)`. `meta_deploy_floor` is global deployment
metadata and is not account-owned.

Global scheduling is also bounded. `fairuse_scheduler` starts at
`(1,NULL,now)`. Each scheduled invocation keyset-reads at most one account
`WHERE id>account_cursor ORDER BY id LIMIT 1`, advances/wraps that cursor in
the same D1 batch that `INSERT OR IGNORE`s its queue row, and processes at
most `FAIRUSE_ACCOUNTS_PER_TICK=1` due queue row ordered
`(next_run_at,account_id)`. Workspace/account creation and plan changes also
upsert that account's queue row. An account with no live scan allocates
`epoch=COALESCE(MAX(epoch),0)+1`; incomplete work sets `next_run_at=now`,
terminal work schedules the next hourly observation. Queue mutation and
scan work are guarded by that account's lease. Thus neither discovering
previously absent accounts nor requeueing scans performs an unbounded
`accounts` sweep (the current retention cross-account enumeration is at
`apps/api/src/retention.ts:35-45` and is not copied here).

The checkpoint machine is exact:

1. Epoch allocation first reads the authoritative account workspace set
   (query defined in C3's selector, `FAIRUSE_MAX_WORKSPACES=64`); row 65
   fails closed with `fairuse_workspace_limit` and no complete/prunable
   epoch. Otherwise the
   exact ordered tuple list, not merely its count or hash, is stored as
   canonical `workspace_set_snapshot`. `capture_pins` then walks that saved
   list in slices of eight. One D1 batch inserts each stream row with DO
   `{head,pruneFloor,indexGeneration,rootsFormatGeneration}` and advances the
   scan cursor. Workspace create/delete after the initial read is detected by
   the required set-equality checks below. `fairuse_workspace_limit` is an
   error/metric, not a scan status; the queue backs off to the next hourly
   observation while enforcement remains fail-closed.
2. `materialize_roots` pages `/roots-inspect`, inserts
   `fairuse_root_membership`, and advances that workspace's opaque
   `roots_cursor/roots_done` in the same D1 batch. This is the durable
   membership relation the current endpoint does not provide
   (`apps/api/src/workspace-sync.ts:1018-1122`). `roots_cursor` remains the
   endpoint-page cursor. A separate durable `materialize_cursor` is canonical
   JSON with exactly `{seq,carrierOrd,pageToken}`: `seq` is the retained
   sequence being expanded, `carrierOrd` is the zero-based carrier currently
   resumed (and advances only after its terminal token) in the authenticated
   oldest→current chain, and codec-issued `pageToken` is a
   pin/result/carrier-bound continuation within that carrier or the final
   folded-output stream; it is never client-chosen.

   The fold incrementally applies full/delta record pages to
   `fairuse_materialize_refs`. Each transaction commits the working-set
   inserts/deletes and the next `materialize_cursor` together. After the last
   carrier it validates count/total/resultSha by keyset-streaming the durable
   set. The output phase handles at most 200 ordered SHAs: in one transaction
   it inserts that membership page, upserts the same SHAs into
   `fairuse_sha_last`, deletes exactly that page with one sequence/`lastSha`
   range statement, and checkpoints the output page token. The per-SHA row ORs
   `in_head` across all membership and keeps the last retained non-head
   reachability under the selector's exact
   `(committed_at,workspace_id,project_id,sequence)` order, where
   `committed_at` is the mirrored `commits.created_at`; a SHA with only head
   membership stores that deterministic head location as an inert last tuple
   and has `in_head=1`. A `timestamp_gap=1` membership sorts after every
   timestamped membership (then by workspace/project/sequence), conservatively
   making that SHA unreleasable in this epoch. Because the compact last row
   does not duplicate timestamps, its upsert recovers the prior
   `committed_at,timestamp_gap` (skipped — treated as absent — when the
   stored inert tuple is head-only) with an exact correlated point lookup into
   `fairuse_root_membership INDEXED BY
   sqlite_autoindex_fairuse_root_membership_1` using the stored
   account/epoch/SHA/last-workspace/last-project/`head=0`/last-sequence tuple,
   then compares that evidence with the incoming membership before
   replacement. Thus a later target occurrence, another
   workspace occurrence, or any head prevents an earlier cut from releasing
   the SHA. Membership, `fairuse_sha_last`, working-set deletion, and cursor
   advance are atomic, so a crash cannot expose a last-location row ahead of
   membership or resume without it.
   Intermediate pages neither advance `roots_cursor` nor delete un-emitted
   rows; only the final empty-page proof advances it and marks the outer page
   done. Fold working-set mutation and membership output are separate ticks:
   fold ticks admit 600 logical records, output ticks 200, and both remain
   within one 64-statement budget, never two allowances.
   Abort/plan-invalidation cleanup uses the same ≤600-row keyset paging. A
   crash resumes at the exact carrier/page token without duplicating/omitting
   records or refolding all parents. One 250,000-ref sequence therefore spans ticks.
   Every current or parent R2 range GET is charged before it starts; a tick
   stops/checkpoints before exceeding 16 carrier GETs, 32 MiB carrier bytes,
   600 row mutations, 64 statements, or B's 500 ms fold CPU deadline.
3. `classify_entitlements` keyset-pages the account's `blob_refs.sha256`,
   joins `blobs.size_bytes` to materialized membership, and atomically adds
   active bytes when any `head=1` membership exists or history bytes when
   only non-head membership exists, while advancing
   `entitlement_cursor_sha`.
4. At terminal cursor, re-enumerate the authoritative D1 workspace set with
   the same `LIMIT 65` query and require exact ordered equality with both
   `workspace_set_snapshot` and the stream-row set. Then re-read every
   workspace pin. Only an exact match sets
   `pins_verified=1` and advances `(verify_cursor_id,verify_cursor_project)`
   in the same batch, in slices of eight. A mismatch aborts immediately.
   Once every pin row is verified, the guarded completion UPDATE itself
   rechecks `COUNT(*)<=64` and uses symmetric `NOT EXISTS` differences between
   current `workspaces`, parsed `workspace_set_snapshot`, and stream rows. It
   sets `completed_at=now,status='complete'` and
   `bound_bytes=5*max(active_bytes,1073741824)` only if exact set equality is
   still true at that transition. Any mismatch deletes only
   that epoch's partial membership/`fairuse_sha_last`/streams, sets
   `aborted_pins` with `completed_at=NULL`, and the next tick allocates
   `MAX(epoch)+1`.
   Verification slices are not a cross-DO transaction; therefore completion
   is not itself authority to mutate. The pre-batch whole-account set+pin
   re-probe in C3 is mandatory immediately before every `/prune` dispatch.

No prune may derive from a row with `completed_at IS NULL`. Per-tick limits
are hard counters checked before starting the next unit; the cursor and work
are committed together, then the account is requeued:

| Phase | Pages/tick and page size | DO/R2 subrequests | D1 subrequests | D1 statements | synchronous CPU deadline |
|---|---|---:|---:|---:|---:|
| `capture_pins` | 1 page, 8 workspaces | ≤8 DO pin reads | ≤2 | ≤16 | 25 ms |
| `materialize_roots` | 1 page, ≤600 fold rows or ≤200 output SHAs/600 physical row mutations, plus endpoint byte cap | ≤17 (1 DO + ≤16 carrier reads) | ≤2 | ≤64 | 500 ms B-fold deadline |
| `classify_entitlements` | 1 page, 2,000 refs | 0 | ≤3 | ≤8 | 25 ms |
| verify/complete | 1 slice, 8 workspaces | ≤8 DO pin reads | ≤2 | ≤16 | 25 ms |
| pre-prune re-probe + selector/enforce | exact set + all pins, one release page, or one pending move | ≤65 DO (≤64 pin reads + ≤1 prune) | ≤16 (at most one release-page query per tick) | ≤40 | 25 ms outside DO/B fold |

This is stricter than the current Phase-1 subrequest ceiling
(`apps/api/src/gc-phase1.ts:7-13`). A `409 prune_deferred` preserves and
retries the same pending request; it never selects another move from that
epoch. Membership inserts use at most 11 nine-bind rows per statement (≤99 D1
parameters). An output tick therefore uses at most 19 membership statements
plus 19 `fairuse_sha_last` upsert statements for 200 SHAs; with one 200-row
working-set range delete that is at most 600 physical row mutations and leaves
25 of the 64-statement budget for cursor, lease, queue, and other checkpoint
work. A fold-only tick retains the existing ≤55 working-set statements for
600 rows and nine statements of overhead. D1's 100-bind constraint is
documented at `apps/api/src/commit-accounting.ts:26-29`. Inserts use
`ON CONFLICT(account_id,epoch,workspace_id,project_id,sha256,head,sequence)
DO UPDATE SET committed_at=CASE
WHEN fairuse_root_membership.committed_at IS NULL THEN excluded.committed_at
WHEN excluded.committed_at IS NULL THEN fairuse_root_membership.committed_at
ELSE MAX(fairuse_root_membership.committed_at,excluded.committed_at) END,
timestamp_gap=MAX(fairuse_root_membership.timestamp_gap,
excluded.timestamp_gap)`, retaining
the latest non-null timestamp exactly as the runner does at
`scripts/storage-truth.ts:382-387`.

### C3 — enforcement pass (per F12/F14/F15)

- Runs under a value-CAS lease, mirroring the shipped GC mechanics at
  `apps/api/src/versions.ts:247-289,308-336`. `fairuse_leases.value` is
  canonical JSON `{owner,epoch,acquired,expires}` with a 10-minute TTL and
  30-minute takeover quiescence. Acquire uses `INSERT OR IGNORE`; a loser
  reads the exact prior string, fails closed if missing/malformed, and may
  take over only after quiescence with
  `UPDATE ... SET value=? WHERE account_id=? AND value=?`. Renew and release
  likewise compare the exact old value. `plan_snapshot` is immutable canonical
  JSON of the resolved plan inputs (resolved plan, grace stamp, and relevant
  storage-plan fields) captured at epoch creation. Every scan cursor,
  aggregate, release checkpoint, status, pending-request, dispatch, result,
  and queue transition
  is one guarded update with all three predicates: the exact unexpired lease
  value exists, `status=<expected status>`, and
  `plan_snapshot=<expected snapshot>`. Renew before five minutes and again
  immediately before the pre-prune guard. Zero changed rows for any predicate
  means ownership/snapshot was lost and work stops without a DO mutation.
- **Grace qualification (F12)**: resolve the plan FIRST; if
  `resolvedPlan === "none"` and `now < grace_until`, the account is
  skipped entirely — the locked-account contract (all history preserved
  during grace, `apps/api/migrations/0012_billing_grace.sql`) dominates
  fair-use.
- **Whole-account pre-batch re-probe:** immediately before EACH fair-use prune
  batch, query authoritative D1 workspaces ordered by
  `(created_at,workspace_id,project_id) LIMIT 65`. More than
  `FAIRUSE_MAX_WORKSPACES=64`, or any exact tuple-set difference from both
  `workspace_set_snapshot` and the epoch stream rows, aborts the epoch. If the
  set matches, issue one bounded DO pin probe to every workspace and require
  exact equality of all saved
  `{head,pruneFloor,indexGeneration,rootsFormatGeneration}` tuples. Any target
  or non-target drift tri-predicate-transitions to `aborted_pins`, clears the
  pending request, and allocates a fresh epoch; no `/prune` is sent. This full
  set+pin re-probe is repeated before every retry/batch, not cached from scan
  completion. One recovery exception cannot create a mutation: if a saved
  pending request's only mismatch is the target `pruneFloor`, replay that
  exact body to retrieve an already-saved DO fence result. The DO returns an
  identical saved result before pin comparison; without such a result the old
  target pin rejects it, so it cannot move the floor. A positive saved result
  is recorded and retires the epoch; a miss aborts it. Any workspace-set,
  non-target, head, or generation drift aborts without replay. This result
  reconciliation is not a new prune batch or target selection.
  This serial set+pin re-probe is a bounded-staleness check, not account-wide
  serialization: an already-probed non-target DO can mutate before the target
  transaction. C1's product contract therefore permits only the one selected
  ≤500-sequence batch to overshoot under that race. A positive target movement
  retires the epoch, while head exclusion, the retained plan window, and the
  target DO's local pin/CAS remain hard guards.

  **Rejected alternative:** an authoritative account-wide generation or
  global cross-DO mutation lock covering workspace set, head, floor, and index
  changes would close this TOCTOU interval. It is rejected here because the
  system deliberately has no cross-DO transaction/serialization primitive;
  introducing one would put every ordinary workspace mutation on a new
  account-global coordination path, disproportionate to the bounded
  oldest-history overshoot. The re-probe keeps the stale window to seconds and
  the single-batch retirement rule prevents compounding it.
- Ordering is one account-global tuple from the D1 commits mirror:
  `(created_at,workspace_id,project_id,sequence)` ascending. A
  `(workspace_id,project_id)` whose next candidate sequence lacks a mirror
  timestamp is SKIPPED this pass (fail closed, no cross-workspace guessing
  — F14) and logged; no later sequence from that pair jumps the gap.
  The query is bounded by the 64-workspace set: one statement joins each
  stream row to the `commits` primary key at exactly `pin_floor+1` and returns
  at most 64 next tuples; after choosing a workspace, one primary-key range
  read returns at most its next 500 sequences. The Worker merge-orders those
  bounded rows, so no account-wide commit sort or new unindexed sweep exists.
- Floor targets are derived from exact membership, never estimated from
  per-sequence bytes. For account `A`, epoch `E`, target workspace `(W,P)`,
  saved floor `F`, and candidate `T`, the materialized relation makes the
  release predicate executable: a SHA is released exactly when `in_head=0`,
  `last_ws=W`, `last_proj=P`, and `F < last_seq <= T`. The selector's
  global-oldest contiguous-prefix rule is a precondition of this reduction:
  no earlier occurrence in another workspace can be skipped. A later target
  occurrence, another workspace's later occurrence, or any head therefore
  contributes zero. Increasing `T` only admits additional last-location rows,
  so `release(T)` remains nondecreasing and binary search remains valid.

  `release(T)` is the sum of bounded pages from this pinned range query; the
  Worker adds the returned `size_bytes` values using checked integers:

```sql
SELECT s.last_seq, s.sha256,
       (
         SELECT b.size_bytes
         FROM blob_refs AS r INDEXED BY sqlite_autoindex_blob_refs_1
         JOIN blobs AS b INDEXED BY sqlite_autoindex_blobs_1
           ON b.sha256=r.sha256
         WHERE r.account_id=:A AND r.sha256=s.sha256
       ) AS size_bytes
FROM fairuse_sha_last AS s INDEXED BY idx_fairuse_sha_last_release
WHERE s.account_id=:A AND s.epoch=:E AND s.in_head=0
  AND s.last_ws=:W AND s.last_proj=:P
  AND s.last_seq<=:T
  AND (s.last_seq,s.sha256)>(:afterSeq,:afterSha)
ORDER BY s.last_seq,s.sha256
LIMIT :pageLimitPlusOne;
```

  `FAIRUSE_RELEASE_PAGE_ROWS=2000`, so `pageLimitPlusOne=2001`. The extra row
  is lookahead and is never added to the page sum. Both named autoindexes are
  the existing primary-key indexes from migrations 0006 and 0001; every
  access path is therefore pinned with `INDEXED BY`, and the release index
  supplies range order without a DISTINCT/temp B-tree. A null `size_bytes`,
  duplicate row, order violation, or checked-sum overflow invalidates the
  epoch fail-closed.

  The initial keyset cursor is exactly `(afterSeq,afterSha)=(F,'')`; resumed
  cursors must satisfy `F<=afterSeq<=T`. The row-value predicate is mandatory:
  SQLite must seek the release index at that tuple rather than restart at `F`
  and filter an OR expression across the already-aggregated prefix.

  One query may report at most `FAIRUSE_RELEASE_ROWS_READ_MAX=8192` through D1
  result metadata and one enforcement tick issues at most one such query. A
  lookahead row, rows-read-budget hit, or CPU deadline persists canonical
  `release_checkpoint={candidateT,afterSeq,afterSha,partialRelease,low,high}`
  in the guarded scan row and requeues; `after*` names the last included row,
  never the lookahead. Resume repeats the same pinned query strictly after
  that tuple. Even when a page appears terminal, a budget hit checkpoints and
  a later empty page proves exhaustion. Each `release(T)` evaluation can span
  ticks; only after its empty-page proof may binary search update `low/high` or
  persist the final prune request. Plan invalidation, pin abort, or epoch
  cleanup clears the checkpoint.
- The selector merge-orders each workspace's next sequence by
  `(created_at,workspace_id,project_id,sequence)`. It chooses the global oldest
  workspace, then forms only that workspace's contiguous prefix before the
  next-oldest tuple from another workspace, capped at
  `min(pin_head-1,F+500)`. Since candidates start at the saved retained floor
  `F`, the batch is drawn from the oldest history still inside the plan's
  retention window; fair use may shorten that retained window but never
  crosses the head. A missing timestamp stops that pair as specified above.
  Let `excess=max(0,history_bytes-bound_bytes)`. Evaluate the exact
  monotone `release(T)` at the prefix end; if it reaches excess, binary-search
  with the same resumable evaluation for the smallest such `T` (at most 10
  completed evaluations for a 500-sequence prefix); otherwise choose the
  prefix end. Atomically clear `release_checkpoint` and persist that exact
  `{floor:T,maxDelta:T-F,...}` request before the whole-account re-probe.
  The selector cannot jump an older tuple in another workspace and cannot
  guess about shared bytes.
- There is at most ONE successful floor movement total from a completed
  epoch (therefore at most one per workspace per epoch). After a positive DO
  result, retire the epoch and run a fresh complete scan before any further
  movement. This also follows mechanically from the next pre-batch re-probe:
  the moved workspace's saved `pruneFloor` no longer matches. A
  `409 prune_deferred` retries only the identical pending request and does not
  select another workspace or target.
- Convergence is intentionally multi-epoch. For initial excess `E0` and a
  corpus whose successful selected batches each have exact marginal release
  at least `batchRelease>0`, the number of positive-release epochs is
  `<= ceil(E0/batchRelease)`. The synthetic 45× acceptance corpus is small,
  has no zero-release prefix, defines `batchRelease=min(release(T_i))`, and
  asserts that bound after a fresh scan following every move. In a general
  corpus, zero-release prefix advances are additionally finite (floors are
  monotone and each consumes at least one retained sequence) and are tested
  separately rather than hidden in the positive-release bound.
- Crash between floor movement and ledger update is safe: floors are
  monotonic and the next scan epoch recomputes truth from authoritative
  state.

`POST /prune` extends today's unbounded `{floor}` body
(`workspace-sync.ts:1125-1143`) to:

```ts
{
  floor: number;
  scanEpoch?: number;
  pins?: {head:number;pruneFloor:number;indexGeneration:number;
          rootsFormatGeneration:number};
  maxDelta?: number;
}
```

Fair-use MUST send all three optional fields; retention omits `scanEpoch`
and `pins`. `maxDelta` is an integer 1..500 and defaults to 500. Immediately
before its storage transaction the DO compares fair-use pins with live
state; mismatch is
`409 {error:"stale_scan_epoch",current:{...}}`. KV
`fairuse_scan_fence={epoch,pins,requestHash,result}` rejects a lower epoch or
the same epoch with different request material; an identical retry returns
the saved result **before** comparing its now-old `pruneFloor` pin, and a
higher exact epoch supersedes it. For a fresh request, live-pin validation,
≤500 sequence-key deletion, `pruneFloor` update, and fence/result write are
one `transactionSync`, so a crash exposes either no mutation/fence or the
complete replayable result. Effective target is
`min(floor,head-1,currentFloor+maxDelta)`, so the current synchronous delete
loop can never exceed 500. Response is
`{pruned,pruneFloor,requestedFloor,scanEpoch?}`. The existing
`target>=index_synced_seq` check and typed `prune_deferred` remain.

**Roots-format coverage is a mutation invariant, not rollout convention.**
New-object DDL and the idempotent legacy `PRAGMA table_info`/`ALTER TABLE`
migration are specified in B3. Set `ROOTS_FORMAT_REQUIRED_GENERATION=2`;
missing KV `roots_format_coverage_generation` means 1. B3's checkpointed
backfill writes each sequence's full chain and coverage=2 atomically; its
final transaction re-reads head and proves no retained row below 2 before
publishing KV generation 2. New folds write generation 2 from birth. Rebuild
clears chains and resets coverage to 1. Central `/prune`
therefore gates BOTH fair-use and `retentionPrune`: before moving a floor it
requires KV generation ≥2 and no crossed `seq_roots` row below generation 2,
otherwise `409 {error:"roots_coverage_incomplete",requiredGeneration:2,
coverageGeneration,maxSafeFloor}`. Partial deployment/backfill therefore
fails closed while coverage-aware code remains deployed.

The Worker env adds `RBOX_HISTORY_PRUNE_DISABLED?: string`; exact `"1"`
disables **both** retention and fair-use DO dispatch while scans continue.
Both callers check it before any floor move; fair-use also CAS-clears
`pruning_active` to `paused_kill`. Set it to `1` through schema/backfill and
before any emergency server rollback. Once any RSD1 object exists, however,
rollback below the B codec/rooting server is prohibited: old `/roots` cannot
root parent carriers and old `/prune` ignores both coverage and this new env.
Migration 0029's `meta_deploy_floor` makes that production prohibition
executable. Its contract is:

- Key `roots_format_generation` has a canonical decimal safe-integer `value`;
  an absent row means generation 1. Malformed or nonpositive stored values
  fail the deployment closed.
- The checked-out Worker source exports the version-controlled integer
  `ROOTS_FORMAT_SUPPORTED_GENERATION`; the RSD1 codec/rooting server sets it to
  2. The deploy helper reads this constant from the candidate artifact, never
  from mutable workflow input or the currently deployed Worker. A candidate
  artifact that predates or omits the constant deterministically means
  generation 1 (or may fail closed); it can never inherit the deployed
  generation or the stored floor.
- After production migrations and before Worker deploy, the production job
  reads `meta_deploy_floor`, compares the candidate generation with the stored
  floor, and refuses the deploy when candidate `< floor`. Equality is allowed.
- Only after the candidate Worker deploy succeeds, the same job's RSD1-era
  path transactionally upserts the row to
  `max(storedFloor,ROOTS_FORMAT_SUPPORTED_GENERATION)` and verifies readback.
  A failed Worker deploy never advances the floor. The first RSD1 writer may
  not be enabled until readback is 2; once it is 2, an old generation-1
  candidate is rejected before deploy. A failed post-deploy floor write fails
  the job and keeps RSD1 writing disabled until the idempotent step succeeds.

Recovery is a forward fix with history pruning and RSD writers disabled. This
follows the existing explicit kill-switch convention at
`apps/api/src/env.ts:47-55` without claiming old code can enforce a new switch.

**Design-150 seam:** design 149 owns the schema, constants, ordering, failure
semantics, and tests above, but `.github/workflows/deploy-api.yml` is currently
owned by design 150's GHA revamp. The workflow step lands only through a
150-coordinated PR after a joint seam review; 149 does not independently edit
that YAML.

### C4 — retention grace read fix (narrowed per F16)

`retentionPrune` consults grace only after plan resolution and only when
the resolved plan is `none` (`apps/api/src/retention.ts:51-59` reorder).
Regression pair: paid plan with live stale stamp IS pruned; locked account
within grace is NOT.

### C5 — surface (F17)

`GET /v1/account/usage` adds `fairUse: { activeBytes, historyBytes,
bound, lastCompletedEpochAt, pruningActive, overshoot:{maxBatches:1,
maxSequences:500} }`. The epoch-specific fields are read from the scan ledger;
the static `overshoot` policy descriptor is appended by the API. The API
description and `rbox status` text state that the bound is exact at quiescence; concurrent
account mutation may remove at most one extra batch of at most 500 sequences
from the single oldest eligible workspace, never a head and always from the
oldest retained history within the plan window. `rbox status` renders the
enforcement line when `pruningActive`.

The displayed totals are exactly the latest stable epoch:

```sql
SELECT active_bytes,history_bytes,bound_bytes,completed_at,pruning_active,status
FROM fairuse_scans
WHERE account_id=? AND completed_at IS NOT NULL
ORDER BY completed_at DESC,epoch DESC LIMIT 1;
```

Lifecycle is durable: terminal pin verification writes `complete` and
`completed_at`. Before dispatch, the lease holder stores the exact canonical
body in `pending_prune_request` but leaves `pruning_active=0`. Recovery uses
C3's full pre-batch re-probe: exact pins may safely replay; a target-floor-only
mismatch may replay solely to recover an existing fenced result and otherwise
fails stale without mutation; every other drift aborts. Only a positive
`pruned>0` response (original or reconciled replay) CAS-transitions
`complete→pruning`, sets `pruning_active=1`, and clears the pending request.
Every non-positive/error outcome clears or reschedules the pending request
without displaying active pruning. Thus the first actual floor move is what
sets the flag and a crash is recoverable on the next queue turn. The next
completed stable epoch at/below bound becomes `converged,0`.
A live locked-account grace
becomes `paused_grace,0`; a resolved-plan change becomes
`invalidated_plan,0` and forces a new epoch; kill switch becomes
`paused_kill,0`; pin churn becomes `aborted_pins,0` and never supplies
displayed totals. Plan writes at `apps/api/src/billing.ts:145-163` and
`apps/api/src/stripe.ts:213-242` invalidate/clear in the same D1 batch as the
plan change. Every admin paid/locked path and Stripe active/nonpaying/deleted
path uses one D1 `batch()` containing: the guarded account-plan write; an
`INSERT ... ON CONFLICT(account_id) DO UPDATE` that rotates
`fairuse_leases.value` to a fresh canonical, expired, immediately-takeoverable
plan-change tombstone; invalidation of every reusable/prunable scan with
`release_checkpoint=NULL,pending_prune_request=NULL,pruning_active=0,
status='invalidated_plan'`; and
the account-queue upsert. A duplicate/no-op plan event may conservatively
rotate too. Any statement failure rolls back the plan write and rotation
together.

The invalidated set explicitly includes `capture_pins`, `materialize_roots`,
`classify_entitlements`, `complete`, and `pruning`; a completed or pending
old-plan epoch can never remain a prune source. For
`customer.subscription.deleted`, first resolve the candidate `account_id` by
the existing guarded `(stripe_customer_id,stripe_subscription_id)` lookup,
then execute the account-id-keyed batch with the same ownership predicates on
the plan UPDATE; a race may conservatively rotate/invalidate that candidate
but cannot downgrade a new owner. The N=1/shard-directory limitation remains
the existing `stripe.ts:234-243` constraint.

`migrateShellSubscription` (`apps/api/src/stripe.ts:353-368`) is also a
plan-change writer. Its existing co-resident shell+destination D1 batch adds
lease rotation, reusable-scan invalidation, and queue upsert for BOTH account
IDs beside the two guarded plan writes. Either the entire two-account move
and both fences commit, or all roll back.

The old holder's exact lease predicate then fails. Every later capture,
materialize, classify, verify, complete, pending-dispatch, result, status, and
queue transition also requires its expected status and exact old
`plan_snapshot`; an old holder therefore changes zero rows and cannot
checkpoint or issue a new prune. The next owner acquires over the valid
expired tombstone and allocates a new epoch with the new snapshot.
Resumption never reuses paused/invalidated/aborted epochs.

## Tests the implementation MUST write

- A: capability recompute matrix (per-floor incapable observation drops a
  floor/gen; capable contacts from the same `deviceId` neither clear nor
  refresh it; another incapable contact refreshes only affected timestamps;
  expiry raises the floor only after 24h), old-daemon/new-CLI mixed-process
  fixture, and observation persistence on every early-stale branch. Race a
  floor/gen change between the preliminary transaction and head CAS and
  require the final authoritative rejection. Cover the split declaration
  matrix and every cross-product, especially manifest raw + refset delta;
  stale gen × floor-lowering/preserving change; independent tri-state flag
  seams; per-axis override validation, including proof that each non-overridden
  axis still fails closed; and the fact that opaque raw versus snapshot content
  is not server-verifiable. Pin `RBOX_MDE_SNAPSHOT=0` + `RBOX_MDE_DELTA=1` to
  raw/no-delta/no-manifest-override and exactly one
  `mde_delta_ignored_snapshot_kill_switch` warning. Legacy omission always admits;
  a nonempty chain logs exactly `legacy_chain_commit`. Retain direct-push
  account-key pinning, exact keys/latest shapes, directory failure/overflow
  all-false, API-key population, trusted-header stripping, and a successful
  v1.7.1 fixture after floor drop.
- B: fold property tests (random chains: reorder/cycle/dup/depth/
  disjointness/trailing-byte/header-length violations all reject;
  every header↔descriptor↔fold cross-field mismatch rejects; both golden
  vectors are byte-pinned in client and Worker; parent fetch occurs only
  after entitlement), 422 missing-parent versus 400 corrupt taxonomy,
  candidate/delete-fence parent recovery, 32MiB/depth/subrequest/CPU bounds,
  exact whole-union cap at `dataRefCap` and cap+1 (including duplicate
  non-data SHA, parent/manifest overlap, 15 parents, and candidate
  encode/hash-before-upload ordering), and streaming fold
  allocation high-water ≤48 MiB for maximal full and 16-link chains and
  inline high-water ≤28 MiB. Assert inline-inline, sidecar-sidecar, and either
  admission mode versus roots/fair-use folds serialize on the shared isolate
  semaphore; the gate remains held through the last accounting allocation;
  every success/inline/400/422/503 path cleans up before release; carrier and
  inline wire buffers become collectible; and no 250k SHA string array/Set
  exists. Test additive `chain` with unchanged `carrierSha`
  meaning against old/new collectors, old page caps before readiness, and
  fail-closed new page/byte caps after readiness. Cover platform-admin
  roots-coverage GET/status and POST/kick across D1 pages including cold DOs;
  crash-conservative backfill; child DELETE → non-delete parent UPSERT → child
  INSERT with foreign keys on; and byte-budgeted composite pagination. Keep
  cascade sweep
  (retention floor passes a parent; retained child keeps it alive; pruning
  the child releases it), threshold-crossing anchor reset, crash-restart
  and second-device verified evidence, and old-Worker magic rejection.
- C: ledger scan resumability (cursor mid-scan crash), pin-change abort,
  atomic page+cursor commit for all three phases, membership join, exact
  per-tick budget exhaustion/requeue, value-CAS lease acquire/renew/
  takeover/loss, and every lease/status/plan-snapshot predicate mismatch.
  Exercise `materialize_cursor` crashes at each carrier/page boundary,
  cursor/pin tamper, exact no-gap/no-dup output, atomic working-set+cursor,
  a 250k full and 16-link chain across ticks, and charging the 16 allowed
  parent/current GETs (17th refused before start). Prove fold ticks use one
  600-record budget, output ticks atomically maintain membership plus
  `fairuse_sha_last` for at most 200 SHAs/600 physical row mutations within 64
  statements, intermediate output pages retain un-emitted rows, final range
  cleanup is bounded, and abort/plan cleanup pages. Exact workspace-set tests:
  64 succeeds, 65 fails closed, create after capture, delete+create with the
  same count (including during sliced pin verification), final-transition set
  equality, and non-target pin drift before dispatch; each pre-batch re-probe
  must count every workspace. Marginal-query tests cover a SHA shared across
  target sequences, across workspaces, reachable from head, and uniquely
  released; crash before/after the atomic last-location upsert; smallest exact
  target, 500 clamp, global-oldest boundary, timestamp gap, zero-release
  advance, and one move then mandatory fresh epoch. Pin `EXPLAIN QUERY PLAN`
  to `idx_fairuse_sha_last_release` and both named entitlement/blob indexes
  with no DISTINCT/temp B-tree; force the 2001-row lookahead, rows-read and CPU
  checkpoints, then prove exact resume without double-summing across ticks.
  Race a non-target head/floor/set mutation immediately after its re-probe and
  prove overshoot is at most the one selected ≤500-sequence batch from the
  oldest workspace, never a head and always from retained history within the
  plan window, followed by a mandatory fresh epoch. The small synthetic 45× corpus converges across
  epochs within `ceil(excess/batchRelease)`. Retain completed/status and
  grace/kill transitions, stale epoch, identical `prune_deferred` replay and
  lost-response-after-positive-move fenced-result reconciliation,
  roots-coverage refusal for retention and fair-use, and the C4 regression
  pair. Admin upgrade/downgrade, Stripe active/nonpaying/deleted, and shell
  subscription migration atomically rotate/invalidate/queue every affected
  account; cover deletion lookup races, plan change after completion and
  after pending-request creation, a stale holder that cannot checkpoint/
  dispatch, duplicate events, and whole-batch rollback.
  Deployment-gate tests cover absent floor→1, malformed floor refusal,
  candidate below floor refusal, omitted candidate-generation constant treated
  as generation 1/fail-closed, equality acceptance, failed deploy without
  advancement, successful RSD1-era deploy plus verified floor-2 write, and an
  idempotent retry after post-deploy write failure.
- Acceptance: in a quiescent design-142 runner re-run post-C, partition holds
  and `retained-history ≤ 5 × max(active-head, 1 GiB)`. The adversarial
  concurrent schedule may cause extra deletion beyond the freshly recomputed
  target only in one oldest-workspace batch of at most 500 non-head sequences
  within the retained plan window; it does not turn sequence count into a byte
  allowance.

## Rollout order (per F18)

Every server stage below is a separate `main` merge, dev deployment and
verification, green-CI checkpoint, and explicit production fast-forward as
required by `docs/DEPLOYMENTS.md`. Production applies D1 migrations before
the corresponding Worker. CLI readers/writers are later tagged releases.

1. Apply `0029_storage_economics.sql`, including `fairuse_sha_last` and
   `meta_deploy_floor`; ship C4 and C2 observe-only. Scans complete, lifecycle
   is visible, `RBOX_HISTORY_PRUNE_DISABLED=1`, and no retention or fair-use
   floor moves.
2. Deploy A's Worker→DO capability path, cooperative declaration admission, and
   legacy v1.7.1 exception before any declaring writer depends on it.
3. Collector-first: deploy and verify the GC reader; land and run/verify the
   storage-truth reader. Both retain `carrierSha`, accept additive `chain`, and
   exhaust byte-bounded cursors. The server still emits the old shape/caps in
   this stage.
4. Only after collector verification, deploy B's streaming codec/fold,
   full-accounting-lifetime ≤48-MiB semaphore, non-delete normalized rooting,
   additive response, new page caps, and platform-admin coverage driver. The
   design-150-coordinated production gate must read/compare the candidate
   generation before this deploy; after the successful generation-2 deploy it
   writes and verifies `roots_format_generation=2`. No RSD1 writer exists.
   Exhaust fresh GET/POST `/v1/admin/roots-coverage` passes over the D1
   workspace enumerator; do not proceed until every authoritative workspace
   reports generation 2, ready, and head-synced.
5. Ship v1.8.0 B readers and second-device base reconstruction with RSD1
   writing still off; capability population can now truthfully raise
   `refsetDelta` after the 30-day rule.
6. Deploy every admin/Stripe plan writer's atomic lease rotation and the C3
   exact marginal selector, whole-account 64-workspace re-probe, and
   tri-predicate transitions while the prune kill switch remains set. Rotate
   existing leases once during this deploy so no pre-deploy holder survives.
7. Enable C3 and resume retention by clearing the history-prune kill switch.
   Coverage generation and pin validation remain structural guards for both.
8. In the next client release, default B writers on only where
   `refsetDelta` is true. Snapshot AND manifest-delta defaults both
   become floor-driven here, replacing v1.7.1's manual gate (founder
   default-on ruling: no extra staging release beyond the floor gate).

## §8 Riders recorded, not designed

- Commit debouncing (multiplies through every per-commit cost; needs a
  latency-vs-cost design).
- Bundle retention (recon candidates on file; smallest term today).
- `SIDECAR_THRESHOLD` revisit after B (delta may invert its purpose).
- Commit-delta fixed-layout fast path re-enable against reconstructed
  buffers, measurement-driven.

## Appendix A — measurement digest (evidence for §Problem)

From the 2026-07-17 storage-truth run (spool `final2`, REST adapter,
status complete, partition 940,446/940,446, zero anomalies):
active-head 49,271 rows / 4,616,884,812 B; retained-history 41,706 rows /
207,512,814,204 B; stranded classes 849,469 rows / 60,738,419,189 B.
Size bands (retained-history): 10–100MB × 4,344 = 180.9 GiB;
1–10MB × 5,320 = 10.2 GiB; <1MB × 32,033 = 0.7 GiB; >100MB × 9 = 1.4 GiB.
Sequences: `SELECT COUNT(*) FROM commits WHERE workspace_id =
'ws_2b6e15da…'` → 4,780 (lo=1, hi=4781). Commit cadence ≈ 480/day over
the 10-day window (all retained versions ≤10 days old; 60% ≤24h).
