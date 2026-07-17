# 149 — Storage economics: O(change) commits and fair-use enforcement (v3)

v3 after review round 2 (CHANGES-REQUIRED, 12 findings — REVIEW-149.md).
All round-2 orchestrator rulings are binding. This revision makes the
capability handoff, sidecar bytes/rooting, and fair-use scan/fencing models
executable against the current routes, DO schema, and D1 schema. The next
free D1 migration is `apps/api/migrations/0029_storage_economics.sql` (the
current tail is `0028_fleet_alert_state.sql`); Unit A's index and Unit C's
tables share that one append-only migration.

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
  incapable INTEGER NOT NULL CHECK (incapable IN (0,1)),
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
  refset_delta_lowered_gen INTEGER NOT NULL,
  legacy_floor_off_seen INTEGER NOT NULL DEFAULT 0
);
```

Bootstrap inserts singleton generation 1 with all three floors false and all
lowered-generation counters 0; there is never an implicit all-true state.

Before dispatching the requested DO action, a `device`/`api_key` fact with a
null version upserts sticky `incapable=1,version=NULL`; only a later valid,
versioned contact by that principal clears it. A version below a constant is
incapable for that floor. `web` is ignored. Sticky rows older than
`CAP_WINDOW_DAYS = 30` age out. Effective floors are the component-wise AND
of the complete Worker summary and every live sticky fact. Any tuple change
increments `gen`; each TRUE→FALSE transition records its `*_lowered_gen` and
permanently sets `legacy_floor_off_seen=1`. Contact update, floor recompute,
generation bump, and (for a commit) the final capability check run in the
same `transactionSync` as head CAS (`workspace-sync.ts:680-710`).

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
encoding?: "raw" | "snapshot" | "delta" | "sidecar-delta";
override?: true;
```

New writers always send a nonnegative safe-integer `capabilityGen` and an
`encoding`; only explicit force-on sends `override:true`. The Worker view at
`apps/api/src/commit-envelope.ts:53-64` gains the same fields. Admission is:

| Declaration | Required structural facts | Floors relied upon |
|---|---|---|
| `raw` | empty/absent `manifestChain`; no RSD delta descriptor | none |
| `snapshot` | empty/absent `manifestChain`; no RSD delta descriptor | `mdeSnapshot` |
| `delta` | nonempty valid `manifestChain`; no RSD delta descriptor | `mdeSnapshot`, `mdeDelta` |
| `sidecar-delta` | B delta descriptor; manifest is snapshot when `manifestChain` is empty and delta otherwise | `refsetDelta`, `mdeSnapshot`, plus `mdeDelta` when chain nonempty |

For every relied-on floor, its current value must be true and
`capabilityGen >= *_lowered_gen`. `capabilityGen` may not exceed current
`gen`. `override:true` bypasses only those floor/lowered-generation tests;
generation and all structural tests remain mandatory. Unknown values,
`override:false`, or override without a declaration are 400. A failed gate
is `409 {"error":"capability_stale","capability":{"gen":18,"floors":{...}}}`;
the transport must distinguish it from today's generic conflict collapse at
`src/cli/remote/commits.ts:311-320`, re-pin through account keys, and encode
again before uploading.

**Legacy-absence rule and v1.7.1 transition.** If `encoding` is absent,
classify permanently as `legacy-raw-or-snapshot`: admit even without a gen
and regardless of floors. Before any floor-off event admit silently; after
`legacy_floor_off_seen=1`, still admit and emit
`legacy_encoding_after_floor_off`. This exception is required because the
released v1.7.1 snapshot-default writer emits neither field and raw and
snapshot are indistinguishable ciphertext today
(`src/cli/e2ee-remote.ts:783-795`). v1.7.1 remains on its manual inventory
gate until the new declaring client ships; new founder force-on clients send
their actual declaration plus `override:true`. The gate can never brick the
released fleet.

### A3 — defaults and flag seams

- With floors true, writers default to snapshot (and delta once
  `mdeDelta` floor is true — one release after snapshot, F5's cadence).
  Env flags become tri-state overrides at BOTH seams — `mdeWriteCaps()`
  (`src/cli/e2ee-remote.ts:73-80`) and push's deltaBase selection
  (`src/cli/sync/push.ts:629-636`): `"0"` force-raw (kill-switch), `"1"`
  force-on (bypasses floors — operator accepts responsibility), unset →
  floor-driven.

### A4 — the exclusion ruling and day-31 semantics (explicit, per F3/F4)

- **Product ruling (amends design 84's open compat window, requires
  founder sign-off at review exit):** a device absent for
  > `CAP_WINDOW_DAYS` days no longer holds back the workspace's floors.
- Day-31 semantics per surface for an excluded pre-Phase-B device:
  - **pull/sync**: decrypt succeeds, JSON.parse of the envelope fails →
    the generic manifest-validation error, NOT a friendly message
    (design 84 records pre-B readers have no envelope handling,
    `84:1063-1076`). Accepted: pre-B binaries cannot be taught new error
    text retroactively. Mitigation: the release notes and site FAQ carry
    the "upgrade rbox" translation; Phase-B+ devices (v1.1.0+, all known
    real devices) get the typed fail-closed error already shipped.
  - **push**: the stale device may upload a raw-v0 manifest and win a
    commit (raw always admits), re-entering the recent set and lowering
    floors via A1's recompute — the system heals toward the most
    conservative live population automatically. An orphaned uploaded
    manifest blob from a lost race is reclaimed by Phase 1 as unrooted.
- The v1.7.1 manual flip remains in force until A ships; A replaces it.

## Unit B — refset sidecar deltas

Review F6–F10: the server is a full sidecar READER (admission expansion
`apps/api/src/workspace-sync.ts:556-580`, GC roots
`apps/api/src/versions.ts:95-109`, commit-delta admission
`apps/api/src/commit-delta.ts:40-94`), and one hash cannot be both the
carrier address and the reconstructed-set identity. v3 wire contract:

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
  fast path) consume the RECONSTRUCTED buffer. The commit-delta
  parent/child fixed-layout optimization is DISABLED for delta-carried
  commits in the first release (correctness first; reinstated against
  reconstructed buffers as a follow-up if measurement demands).

Fold and writer limits are executable:

| Budget | Limit / action |
|---|---|
| Total carriers | 16 current-inclusive; signed parent chain ≤15 |
| Cumulative R2 bytes | 32 MiB across full anchor and all deltas; sum R2-reported sizes before each allocation and stream/fold one carrier at a time |
| Reconstructed refs | 250,000, matching `MAX_REFS_PER_COMMIT` (`commit-accounting.ts:43-48`); a maximal current full is 10,000,018 bytes, not v2's 6MB |
| Fold subrequests | ≤1 batched D1 entitlement check + ≤16 R2 GETs = 17, excluding existing bounded downstream accounting batches |
| Pure parse/fold CPU | `SIDECAR_FOLD_CPU_MS=500`; accumulate synchronous time after every carrier and every 5,000-record merge chunk |

CPU excess fails closed with 503 `sidecar_fold_budget` before accounting/head
move. Depth/byte/protocol excess is 400 `bad_sidecar`. The writer emits full
when projected chain bytes exceeds 32 MiB, total depth would exceed 16,
`deltaBytes >= 0.5*fullBytes`, threshold direction changes, or verified base
evidence is absent.

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
Pre-RSD1 sidecars are full anchors, so the initial backfill is one atomic:

```sql
INSERT OR IGNORE INTO seq_root_chains(seq,ord,carrier_sha)
SELECT seq,0,carrier_sha FROM seq_roots WHERE carrier_sha IS NOT NULL;
UPDATE seq_roots SET coverage_generation=2;
```

Those statements and the retained-range completeness check are one storage
transaction; only its success publishes KV coverage generation 2.

For every new fold, the same transaction that writes `seq_roots` and
`index_synced_seq` replaces the sequence's chain rows. Raw-gap construction
reads the signed chain plus current carrier. A retained child consequently
roots every ancestor even after the ancestor's own sequence is pruned.

`/roots` and `/roots-inspect` change each sequence entry to
`{seq,manifestSha,chain:[oldest..current]}` (gap entries use the same field).
`ROOTS_CHAIN_PAGE_BYTES=512*1024` bounds the exact UTF-8 JSON contribution
in addition to the 20,000-sequence ceiling: query ordered `(seq,ord)`, never
split a sequence, always emit at least one valid bounded sequence, and return
exclusive `nextSeq=last emitted`. The collector unions every `chain` SHA via
the existing deduper (`apps/api/src/versions.ts:49-55,90-109`) and replaces
the old four-pages×20k assumption with a total response-byte cap.

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

Server codec+fold+rooting deploys FIRST. Client B readers/base-evidence ship
in reserved v1.8.0 with writers still off; writer default-on ships ≥1 release
later behind Unit A's `refsetDelta` floor. An old Worker rejects the new
magic fail-closed, but no capable writer exists before every Worker reads
the format. B3's coverage gate below, not deployment order alone, permits
floor movement.

## Unit C — fair-use history enforcement

### C1 — invariant (renamed per F13)

Per account: `historyBytes ≤ 5 × max(activeBytes, 1 GiB)` — the
**floor-adjusted fair-use bound**, allowance account-global. Acceptance
uses this exact formula (a 100MiB-active account legitimately retains up
to 5 GiB of history).

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
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  workspace_cursor_created_at INTEGER,
  workspace_cursor_id TEXT,
  workspace_cursor_project TEXT,
  entitlement_cursor_sha TEXT,
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
  roots_done INTEGER NOT NULL DEFAULT 0 CHECK(roots_done IN (0,1)),
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

CREATE TABLE IF NOT EXISTS fairuse_leases (
  account_id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_account_scan
ON workspaces(account_id,created_at,workspace_id,project_id);
```

No foreign keys is intentional: account deletion adds explicit deletes for
these account-owned tables, and old epoch cleanup transactionally deletes
membership, workspace streams, then scan row by `(account_id,epoch)`.

The checkpoint machine is exact:

1. `capture_pins` keyset-pages workspaces by
   `(created_at,workspace_id,project_id)`. One D1 batch inserts each stream
   row with DO `{head,pruneFloor,indexGeneration,rootsFormatGeneration}` and
   advances the three scan cursor columns.
2. `materialize_roots` pages `/roots-inspect`, inserts
   `fairuse_root_membership`, and advances that workspace's opaque
   `roots_cursor/roots_done` in the same D1 batch. This is the durable
   membership relation the current endpoint does not provide
   (`apps/api/src/workspace-sync.ts:1018-1122`).
3. `classify_entitlements` keyset-pages the account's `blob_refs.sha256`,
   joins `blobs.size_bytes` to materialized membership, and atomically adds
   active bytes when any `head=1` membership exists or history bytes when
   only non-head membership exists, while advancing
   `entitlement_cursor_sha`.
4. At terminal cursor, re-read every workspace pin. Only an exact match sets
   `completed_at=now,status='complete'` and
   `bound_bytes=5*max(active_bytes,1073741824)`. Any mismatch deletes only
   that epoch's partial roots/streams, sets `aborted_pins` with
   `completed_at=NULL`, and the next tick allocates `MAX(epoch)+1`.

No prune may derive from a row with `completed_at IS NULL`. Per-tick limits
are hard counters checked before starting the next unit; the cursor and work
are committed together, then the account is requeued:

| Phase | Pages/tick and page size | DO/R2 subrequests | D1 subrequests | D1 statements | synchronous CPU deadline |
|---|---|---:|---:|---:|---:|
| `capture_pins` | 1 page, 8 workspaces | ≤8 DO pin reads | ≤2 | ≤16 | 25 ms |
| `materialize_roots` | ≤4 pages, ≤1,000 rows and endpoint byte cap/page | ≤8 (4 DO + at most 4 carrier reads) | ≤4 | ≤64 | 25 ms |
| `classify_entitlements` | 1 page, 2,000 refs | 0 | ≤3 | ≤8 | 25 ms |
| verify/complete | 1 slice, 8 workspaces | ≤8 DO pin reads | ≤2 | ≤16 | 25 ms |
| enforce | ≤8 prune attempts | ≤8 DO | ≤12 | ≤32 | 25 ms |

This is stricter than the current Phase-1 subrequest ceiling
(`apps/api/src/gc-phase1.ts:7-13`). `409 prune_deferred` consumes an enforce
attempt.

### C3 — enforcement pass (per F12/F14/F15)

- Runs under a value-CAS lease, mirroring the shipped GC mechanics at
  `apps/api/src/versions.ts:247-289,308-336`. `fairuse_leases.value` is
  canonical JSON `{owner,epoch,acquired,expires}` with a 10-minute TTL and
  30-minute takeover quiescence. Acquire uses `INSERT OR IGNORE`; a loser
  reads the exact prior string, fails closed if missing/malformed, and may
  take over only after quiescence with
  `UPDATE ... SET value=? WHERE account_id=? AND value=?`. Renew and release
  likewise compare the exact old value. Every cursor/aggregate/status write
  includes an unexpired `EXISTS` guard for that exact value; renew before
  five minutes and immediately before `/prune`. Zero changed rows means the
  lease was lost and work stops.
- **Grace qualification (F12)**: resolve the plan FIRST; if
  `resolvedPlan === "none"` and `now < grace_until`, the account is
  skipped entirely — the locked-account contract (all history preserved
  during grace, `apps/api/migrations/0012_billing_grace.sql`) dominates
  fair-use.
- Ordering: per-workspace oldest-first by the D1 commits mirror
  timestamp. A workspace whose candidate sequence lacks a mirror
  timestamp is SKIPPED this pass (fail closed, no cross-workspace
  guessing — F14); the pass logs the skip. Tie-break: lower sequence
  first within a workspace, workspace_id lexicographic across.
- Mutation budget: ≤`FAIRUSE_MAX_PRUNES = 8` DO `/prune` calls per
  invocation, each advancing one workspace's floor by at most 500 sequences;
  `409 prune_deferred` (`apps/api/src/workspace-sync.ts:1125-1143`)
  counts against the budget and retries next tick. After the budget,
  the pass re-queues; convergence is across ticks, verified by the
  next completed scan epoch.
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
`fairuse_scan_fence={epoch,pins}` rejects a lower epoch or the same epoch
with different pins; an identical retry is idempotent and a higher exact
epoch supersedes it. Effective target is
`min(floor,head-1,currentFloor+maxDelta)`, so the current synchronous delete
loop can never exceed 500. Response is
`{pruned,pruneFloor,requestedFloor,scanEpoch?}`. The existing
`target>=index_synced_seq` check and typed `prune_deferred` remain.

**Roots-format coverage is a mutation invariant, not rollout convention.**
Add `coverage_generation INTEGER NOT NULL DEFAULT 1` to DO `seq_roots`, and
set `ROOTS_FORMAT_REQUIRED_GENERATION=2`. B3 backfill parses every retained
`seq:*`, writes its full `seq_root_chains` rows and coverage=2 atomically,
and only after the entire retained range is covered sets KV
`roots_format_coverage_generation=2`; new folds write generation 2 from
birth. Rebuild clears chains and resets coverage to 1. Central `/prune`
therefore gates BOTH fair-use and `retentionPrune`: before moving a floor it
requires KV generation ≥2 and no crossed `seq_roots` row below generation 2,
otherwise `409 {error:"roots_coverage_incomplete",requiredGeneration:2,
coverageGeneration,maxSafeFloor}`. B rollback or partial backfill can no
longer strand an ancestor.

The Worker env adds `RBOX_FAIRUSE_ENFORCEMENT_DISABLED?: string`; exact
`"1"` disables fair-use floor moves while scans continue (unset/`"0"`
enables after rollout). The cron checks it before DO dispatch and CAS-clears
`pruning_active`, transitioning an active epoch to `paused_kill`. Retention
still runs, but remains protected by the same DO coverage and max-delta
checks. This follows the existing explicit kill-switch convention at
`apps/api/src/env.ts:47-55`.

### C4 — retention grace read fix (narrowed per F16)

`retentionPrune` consults grace only after plan resolution and only when
the resolved plan is `none` (`apps/api/src/retention.ts:51-59` reorder).
NO change to `adminSetPlan`/Stripe stamping. Regression pair: paid plan
with live stale stamp IS pruned; locked account within grace is NOT.

### C5 — surface (F17)

`GET /v1/account/usage` adds `fairUse: { activeBytes, historyBytes,
bound, lastCompletedEpochAt, pruningActive }` read from the scan ledger;
`rbox status` renders one line when `pruningActive`.

The displayed totals are exactly the latest stable epoch:

```sql
SELECT active_bytes,history_bytes,bound_bytes,completed_at,pruning_active,status
FROM fairuse_scans
WHERE account_id=? AND completed_at IS NOT NULL
ORDER BY completed_at DESC,epoch DESC LIMIT 1;
```

Lifecycle is durable: terminal pin verification writes `complete` and
`completed_at`; the first successful floor move CAS-transitions
`complete→pruning` and sets `pruning_active=1`; the next completed stable
epoch at/below bound becomes `converged,0`. A live locked-account grace
becomes `paused_grace,0`; a resolved-plan change becomes
`invalidated_plan,0` and forces a new epoch; kill switch becomes
`paused_kill,0`; pin churn becomes `aborted_pins,0` and never supplies
displayed totals. Plan writes at `apps/api/src/billing.ts:145-163` and
`apps/api/src/stripe.ts:213-242` invalidate/clear in the same D1 batch as the
plan change. Resumption never reuses paused/invalidated/aborted epochs.

## Tests the implementation MUST write

- A: capability recompute matrix (incapable device enters window →
  floors drop + gen bump; device ages out → floors rise), admission
  matrix (stale gen × floor-lowering vs floor-preserving change), both
  flag seams tri-state, direct-push account-key pinning and exact keys/latest
  response shapes, headerless/mixed-process sticky incapable state,
  directory failure/overflow all-false, API-key population, trusted-header
  spoof stripping, override validation, and legacy-absent admission both
  before and after the first floor-off event. A v1.7.1 fixture must commit
  successfully after a floor drop while emitting the legacy metric.
- B: fold property tests (random chains: reorder/cycle/dup/depth/
  disjointness/trailing-byte/header-length violations all reject;
  every header↔descriptor↔fold cross-field mismatch rejects; both golden
  vectors are byte-pinned in client and Worker; parent fetch occurs only
  after entitlement), 422 missing-parent versus 400 corrupt taxonomy,
  candidate/delete-fence parent recovery, 32MiB/depth/subrequest/CPU bounds,
  rooting backfill and byte-budgeted composite pagination, cascade sweep
  (retention floor passes a parent; retained child keeps it alive; pruning
  the child releases it), threshold-crossing anchor reset, crash-restart
  and second-device verified evidence, and old-Worker magic rejection.
- C: ledger scan resumability (cursor mid-scan crash), pin-change abort,
  atomic page+cursor commit for all three phases, membership join, exact
  per-tick budget exhaustion/requeue, value-CAS lease acquire/renew/
  takeover/loss, completed-at/status transitions, grace/plan/kill clears,
  missing-mirror-timestamp skip, stale-epoch/pin rejection, 500-sequence
  clamp, prune_deferred retry, roots-coverage refusal for both retention and
  fair-use (including partial backfill/rollback), floor-adjusted convergence
  on a synthetic 45× account across bounded ticks, and C4 regression pair.
- Acceptance: design-142 runner re-run post-C: partition holds and
  `retained-history ≤ 5 × max(active-head, 1 GiB)`.

## Rollout order (per F18)

1. Apply `0029_storage_economics.sql`; ship C4 and C2 observe-only. Scans
   complete, lifecycle is visible, `RBOX_FAIRUSE_ENFORCEMENT_DISABLED=1`,
   and no fair-use floor moves.
2. Deploy A's Worker→DO capability path, signed declaration admission, and
   legacy v1.7.1 exception before any declaring writer depends on it.
3. Deploy B server codec/fold/normalized rooting and run the retained-range
   coverage backfill. No RSD1 writer exists. Do not proceed until every
   active DO reports `roots_format_coverage_generation=2`.
4. Ship v1.8.0 B readers and second-device base reconstruction with RSD1
   writing still off; capability population can now truthfully raise
   `refsetDelta` after the 30-day rule.
5. Enable C3 by clearing the fair-use kill switch. Coverage generation and
   pin validation remain structural guards for both fair-use and retention.
6. In the next client release, default B writers on only where
   `refsetDelta` is true. Snapshot defaults become floor-driven here,
   replacing v1.7.1's manual gate; manifest delta defaults one release later.

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
