# 114 — Pack small ciphertext blobs into bandwidth-sized R2 objects

Status: **DRAFT v4** (2026-07-13) — rounds 1-3 of the adversarial review folded
(`docs/design/REVIEW-114.md`). Not yet approved; implementation must not begin
until the loop converges. This is a storage-format and GC-fence design. Field
baseline: `flat-meadow`, same host and corpus, 630 Mbps pipe, 2026-07-13.

## Problem

Small-file upload is bounded by R2 object operations, not by available network
bandwidth. Every encrypted blob is currently one canonical R2 object at
`blobKey(encSha)`. `POST /v1/blob-batch/put` reduces HTTP and fence overhead, but
`apps/api/src/blob-batch.ts::writeBatchPutRecords` still calls
`directWriteVerified` once per unique record. A request's writes settle through
roughly six simultaneous R2 subrequests, so batching records does not batch the
physical writes.

At the measured mean ciphertext size of about 8.5 KiB, sustaining 200 Mbps needs

```text
200,000,000 bits/s / 8 / (8.5 * 1024 bytes/blob) ~= 2,872 blob PUTs/s
```

or approximately 3,000 R2 object PUTs/s. That is unreachable through the
current Worker/R2 path. The best measured wall throughput is **48.8 Mbps** even
on a 630 Mbps pipe. In contrast, the existing multipart lane for large single
ciphertexts such as git packs sustains about **200 Mbps effective**: large
streaming R2 writes are fast enough. The missing operation is physical
coalescing, not more concurrency.

This design packs many already-encrypted small blobs into one R2 object while
preserving all logical behavior by `encSha`:

- encryption, keys, and MACs remain per blob;
- manifests and commits still name individual `encSha` values;
- `/v1/blobs/check`, receipts, quota, entitlement, retained roots, and GC Phase
  1 remain logically per blob;
- a reader can fetch one blob with one R2 range read; and
- unpacked historical blobs remain readable forever. There is no migration and
  no requirement to repack old data.

Constraints are binding: no plaintext reaches the server, commit shape is
untouched, old clients see no `/v1/blobs/check` semantic change, metrics contain
no raw paths or identifiers, and this design adds **no upload slots**.

## Evidence

### Field evidence and disproven levers

The 2026-07-13 `flat-meadow` run measured batch-PUT handlers at about **733 ms**
each. The server fans records into one R2 PUT per ciphertext; the platform
serializes those subrequests in waves of roughly six per Worker invocation.
With an approximately 8.5 KiB mean blob, the resulting wall tops out at 48.8
Mbps while the large-object lane reaches about 200 Mbps.

The adjacent tuning ledgers rule out the cheaper explanations:

- **Slots:** the #245 upload-slot sweep found 48 slots only +9% over the kept
  default of 24 (`DEFAULT_BATCH_PUT_SLOTS`, `src/cli/remote/blob-batch/config.ts`
  — the 48 default there is the *download* lane), and ≥64 collapses 3x through
  per-batch RTT inflation. All projection arithmetic in this design uses 24, the
  kept upload default. This design does not add or sweep slots.
- **Records per batch:** design 112 / `REVIEW-112.md` raised and measured the
  32→64 axis. The 64-record candidate failed the cap gate by **7%** in the
  2026-07-13 sweep. Even a perfectly filled request still performs one R2 PUT
  per record.
- **Authentication:** design 109 / `REVIEW-109.md` measured about 89 ms/request,
  approximately 9 s total, and parked the refactor at gate 0. It is not the
  factor separating 48.8 from 150–200 Mbps.
- **Bandwidth and encryption:** large multipart writes on the same path reach
  approximately 200 Mbps. The bytes can move; the small-object operation rate
  cannot.

### Concrete operation-count projection

Using design 112's measured sample of 40,828 records and 8.55 KiB mean
ciphertext:

```text
logical ciphertext bytes = 40,828 * 8.55 KiB ~= 349,079 KiB ~= 340.9 MiB
current R2 PUT objects    = 40,828
7.5 MiB payload packs     = ceil(340.9 / 7.5) = 46
physical PUT reduction    = 40,828 / 46 ~= 888x
```

The current batch route needed 2,360 HTTP requests for that sample, but still
issued 40,828 R2 PUTs. Packing needs about 46 HTTP requests and 46 R2 PUTs. Even
if a pack PUT paid the full measured 733 ms fixed settle cost, its idealized
24-slot request envelope is `46 * 0.733 / 24 = 1.4 s` (24 =
`DEFAULT_BATCH_PUT_SLOTS`, the kept #245 default); the approximately 341
MiB payload then dominates at 150–200 Mbps (about 18.2–13.6 s). These are
projections, not a latency promise; the validation gate measures real R2 pack
writes.

One honesty caveat is binding (round 1): the 150–200 Mbps evidence comes from
the *multipart* lane's streaming writes, and the 733 ms datum measures handlers
doing small-object fan-out — neither measures the proposed primitive, a
buffered, checksum-verified, non-multipart ~8 MiB `R2.put`. Phase 0 therefore
measures a dev-API curve of verified single PUTs at 1 / 4 / 7.5 MiB bodies
under the same 24-slot scheduler *before* implementation proceeds past the
format work. If that curve shows the 7.5 MiB verified PUT is itself
operation-bound below the gate, the design stops at the object-count win and
the larger streaming-pack follow-up is designed instead.

## Root cause

`BlobBatchUploader` (`src/cli/remote/blob-batch/uploader.ts`, whose ownership is
defined by `docs/CODEMAP.md`) coalesces scheduling and HTTP framing only. The
server validates every frame and maps every successful record to
`directWriteVerified(env, encSha, payload)`. Thus the physical storage address
and the logical content address are the same thing:

```text
logical identity encSha  ==  R2 object key blobKey(encSha)
```

That coupling makes every logical blob consume an R2 object operation. Raising
batch fill, records, or client slots cannot remove it.

The root fix is to split identity from placement:

```text
logical identity: encSha
physical placement: canonical(blobKey(encSha))
                 OR packed(packId, offset, length)
```

The split cannot be merely an upload optimization. Reads, download grants,
receipts, quota, `blob_ref_candidates`, `gc_candidates`, design-96 retained
roots, and the design-102 active deletion fence all currently assume the
logical SHA also selects the physical object. A correct design keeps those
systems logical and introduces one authoritative, fenced placement layer.

## Options

### A. Keep one object per blob and tune concurrency/batch fill

Rejected. The measured slot, record-cap, and auth gates disprove these as the
missing 3–4x wall-throughput lever. They do not reduce R2 object count.

### B. Pack bytes but put the lookup index only in a Durable Object

Rejected. Placement is account data-plane state used by blob GET, batch GET,
receipt redemption, accounting, and GC, while the WorkspaceSync DO owns commit
sequencing and retained roots. Making the DO own blob placement would cross the
`docs/CODEMAP.md` boundary, add a DO hop to every read, and couple one physical
pack to arbitrary projects/workspaces.

### C. Put the index only in each pack trailer

Rejected as the serving index. Resolving `encSha` would require knowing which
pack to inspect, so the server would still need a global catalog or an R2 LIST.
R2 LIST is neither an authorization index nor a suitable hot-path lookup. A
trailer remains valuable for integrity, offline audit, and catalog recovery.

### D. D1 active-location index plus a self-describing pack trailer

Recommended. D1 resolves an entitled logical SHA to its active placement in one
account-data-plane query. The immutable in-object trailer proves the physical
layout and permits repair/audit without trusting D1 offsets blindly. Absence of
a D1 packed-location row means the existing canonical key, preserving the old
estate without backfill.

### E. Rewrite live packs whenever some members become garbage

Rejected for v1. Compaction introduces byte copying, a second-location cutover,
read races, receipt/location generations, and a new way to cross the deletion
fence. V1 accepts space amplification: one live member pins the entire pack.
Compaction requires a later design and independent correctness review.

### F. Never delete packs

Safe but rejected as the terminal design because it creates unbounded physical
storage leakage. It is the rollout starting state and emergency fallback:
logical GC may run while physical pack deletion remains disabled.

## Recommended design

### 1. Invariants

1. **Logical identity is unchanged.** `encSha = SHA-256(ciphertext bytes)`;
   manifests, refsets, commits, entitlements, quota, receipts, and retained
   roots continue to name and account for each ciphertext independently.
2. **Cryptographic confidentiality is unchanged; the metadata surface shifts
   and the delta is stated and accepted.** The pack contains opaque, complete
   per-blob ciphertexts. There is no pack encryption key, cross-blob
   compression, or server-visible plaintext. Existing per-blob keys, AEAD
   framing, and MAC verification are untouched. What an R2-level observer
   learns changes shape (round 1 finding f): **before** packing, key listing
   exposes one object per `encSha` with its exact ciphertext size and upload
   time; **after**, packed blobs no longer appear as individual keys (a
   listing-only observer sees less), but an observer who can *read* pack
   objects gains the plaintext directory — durable proof of exact
   co-membership, ordering, and per-member lengths for the ~hundreds of
   ciphertexts published together, plus range-read patterns correlating
   intra-pack access. The `encSha` values themselves are already R2 key
   material today. This co-membership/ordering metadata is a new, permanent
   artifact and is explicitly accepted: it reveals grouping of an account's own
   uploads within one publish window, which the same observer could already
   approximate from upload timestamps.
3. **One active placement per logical blob.** An entitled+present blob resolves
   either to the legacy canonical object or to exactly one immutable pack
   extent. Placement changes only through authenticated receipt accounting.
4. **Publication remains fenced.** A packed receipt is minted only after the
   pack exists, every member hash verifies, and no logical member or the pack is
   under an active deletion intent. Redemption atomically installs placement,
   charges/grants the logical refs, clears Phase-1 markers, and respects the
   same `RAISE(ABORT)` failure unit as design 102.
5. **No pack is deleted while addressable.** Physical pack deletion requires
   zero active locations into the pack. Every logical location is retired only
   under that blob's existing active `gc_candidates` intent, zero-ref check,
   fresh design-96 reachability check, quiescence, and purge lease.
6. **Mixed estate is permanent.** Missing packed placement means canonical
   lookup. Old blobs are never repacked, old clients can upload canonical blobs
   forever, and rollback never makes packed data unreadable.

### 2. Pack format: `rbox-pack-v1`

All integers are unsigned big-endian. Offsets are absolute from byte zero. A
pack is immutable.

```text
+----------------------+ byte 0
| header (16 bytes)    | magic="RBOXPK01", headerBytes=u32(16), flags=u32(0)
+----------------------+
| ciphertext 0         | exact existing per-blob ciphertext bytes
| ciphertext 1         |
| ...                  | no padding and no cross-record encoding
+----------------------+
| directory            | count * 48-byte entries, ordered by offset
+----------------------+
| footer (72 bytes)    | fixed-size locator/integrity footer
+----------------------+ EOF
```

Each 48-byte directory entry is:

```text
encSha[32] | offset:u64 | length:u64
```

The 72-byte footer is:

```text
magic[8]="RBOXEND1"
version:u32=1
entryBytes:u32=48
count:u32
reserved:u32=0
directoryOffset:u64
directoryBytes:u64
directorySha256[32]
```

Validation is strict: known magic/version/flags; reserved zero; count 1..2,048;
unique `encSha`; entries in ascending offset order; every length >0 and
≤256 KiB; ciphertext extents are contiguous and cover exactly
`[headerBytes, directoryOffset)`; directory size equals `count*48`; directory
hash matches; footer ends exactly at EOF; and SHA-256 of each extent equals its
declared `encSha`. The client also sends `x-rbox-pack-sha256`, SHA-256 of the
whole pack, and R2 verifies that checksum on PUT. The pack checksum protects
the container; the per-entry checks preserve the existing content addresses.

The trailer, rather than a leading index, is chosen because the client can
append entries while building a temporary file and then append one canonical
directory. The API caps and buffers v1 packs, so it can read the fixed footer
first, validate the directory, then hash slices without a second upload pass.
The serving path uses D1, not the trailer.

#### Size policy

- eligible logical ciphertext: `1..256 KiB` (same small-record ceiling as the
  current batch lane);
- target ciphertext payload: **7.5 MiB**;
- hard request/pack body cap: **8 MiB**, including header, directory, and footer;
- hard member count: **2,048**;
- minimum activation: at least **16 eligible blobs** or **1 MiB eligible
  ciphertext** in the current publish; once activated, the final tail pack may
  contain fewer than 16;
- a single blob above 256 KiB stays on the existing single/multipart lane.

At the 8.55 KiB field mean, a 7.5 MiB payload holds about 898 blobs; directory
and footer overhead are about `898*48+88 = 43,192 bytes`, or 0.55%. The client
must stop adding records early enough that the final encoded body remains
≤8 MiB.

V1 deliberately does **not** use multipart packs. An 8 MiB object already
reduces this corpus from 40,828 physical writes to about 46 and is large enough
to make bandwidth dominant, while remaining inside the existing batch body
bound and a safe fraction of Worker memory. If the ≥150 Mbps gate fails because
7.5 MiB objects are still operation-bound, larger streaming/multipart packs are
a follow-up design; they are not silently enabled here.

### 3. Upload wire and server validation

Add an additive endpoint:

```text
POST /v1/blob-pack/put
authorization: Bearer <token>            (identical contract to blob-batch PUT)
content-type: application/x-rbox-pack
x-rbox-protocol: upload-receipts-v1
x-rbox-pack-id: <128-bit random lowercase hex>
x-rbox-pack-sha256: <64 lowercase hex>
body: rbox-pack-v1

200 { packId, packSha256, results: [{ sha256, ok, sizeBytes, receipt }] }
```

Authentication is stated explicitly because design 109 is being implemented in
parallel against the same dispatch surface (round 2 + REVIEW-114 seam note):
the route authenticates the **bearer token exactly as `/v1/blob-batch/put`
does** — the client sends `ctx.protoAuth` unconditionally, the server derives
`accountId` from `authenticate()`, and download grants are **never** an upload
credential and never appear in the pack wire contract. If design 109 lands a
server-side grant verification fast-path, it changes only how the bearer is
verified, not this contract. An API test asserts an un-authenticated /
grant-only pack PUT is rejected.

`packId` is an opaque random physical identity, separate from content identity,
and the R2 key is `packs/v1/<packId>`. The server rejects reuse of a `packId`
with a different pack checksum. Same-id/same-checksum retry is idempotent while
no `pack_gc_candidates` row exists for the id (marked or opened — §7.3
property 1). A client whose same-id retry is fenced generates a fresh `packId`
and retries; v1 deliberately does not embed the ID in the body, so the built
pack bytes are reused unchanged under the new identity.

The Worker reads at most 8 MiB and performs the strict format validation above.
It runs one aggregate, entitlement-aware quota precheck over the declared
logical members before creating inventory or writing R2; already-entitled
members cost zero, as in `wouldExceedCap`. This is fail-fast only—receipt
redemption's existing cap-guarded accounting remains authoritative.
It hashes every ciphertext extent before creating durable inventory, so a bad
member cannot create D1 or R2 garbage.
Before the R2 write it atomically creates an immutable `packs(state='uploading')`
inventory row plus every `pack_members` row, rejecting a same-ID/different-hash
collision (member inserts are parameter-bounded chunks within that D1 batch).
It then issues **one** verified R2 PUT for the pack. It does not issue per-member
R2 writes. Any structural,
whole-pack checksum, or member hash failure rejects the whole request and mints
no receipts. There is no partial physical success contract.

A failed request may leave an `uploading` inventory row but never an active
blob location. The `uploading`-orphan protocol is explicit because the sweeper
and a same-id repair can race (rounds 2–3):

- inventory carries a `touched_at` heartbeat; the original insert and every
  same-id retry set it via a **conditional single-row UPDATE before the R2
  write** (`changes = 1` required, else the request fails closed with
  `retry_later` and no R2 write);
- the `uploading -> ready` transition is a conditional single-row UPDATE
  (`state='uploading'` predicate, `changes = 1` required). A same-id retry
  that finds the pack already `ready` with the same checksum takes a distinct
  idempotent branch (round 3): verify inventory + object, run the fence read,
  and mint fresh receipts **without** requiring the transition — a crash
  between `ready` and the response is therefore recoverable;
- if the ready transition (or the fence read after it) fails, the handler
  best-effort deletes the R2 object it just wrote before returning
  `retry_later`, so a request that lost a race does not strand bytes;
- the sweeper acts only on inventory whose `state='uploading'` and whose
  `created_at` **and** `touched_at` are both past the §7.3 orphan grace, and
  its **destructive statements embed those predicates** (round 3 — a JS
  pre-select is not the guard): one `db.batch` deletes `pack_members`
  correlated to a still-eligible parent, then the `packs` row with the same
  eligibility predicate; the R2 delete runs only if the `packs` DELETE
  reports `changes = 1`. A repair heartbeat therefore either lands first and
  falsifies eligibility, or lands after and fails closed (`changes = 0`);
- because no platform bound is documented for how late an already-issued R2
  PUT can land (round 3), the sweeper's `packs` DELETE is actually a
  transition to a terminal **`state='swept'` tombstone** (members deleted,
  row retained): a late PUT that recreates `packs/v1/<packId>` after the
  sweep meets a tombstone on every later path (heartbeat, ready transition,
  fence read all require non-swept state → fail closed), and the sweeper
  re-HEADs tombstoned ids on subsequent ticks, re-deleting a reappeared
  object; the tombstone itself is removed only after the object has been
  confirmed absent on a later tick past a further grace.

After R2 accepts, one fail-closed D1 fence query checks:

- active logical `gc_candidates` for every member SHA; and
- **any** `pack_gc_candidates` row for `packId` — marked or opened (§7.3
  property 1: after the first candidacy, no receipt for this pack is ever
  minted again).

If either query fails or finds a fence, return `503 retry_later` and mint no
receipt. The unreferenced pack object is a safe inventoried orphan for later pack
GC. On success one D1 update marks the immutable pack inventory `ready`, then the
server mints **one receipt per logical blob**, in directory order. Same-ID/same-
checksum retry repairs `uploading` state after confirming or rewriting the R2
object and returns fresh receipt generations. Pack GC never acts on `uploading`
or `ready` inventory until the orphan grace described in §7.3.

This endpoint belongs beside `apps/api/src/blob-batch.ts` as a separate
`blob-pack.ts`; its route is additive. On the client, packing/scheduling belongs
under `src/cli/remote/blob-batch/` because CODEMAP assigns batched blob transfer
there. If implementation adds `packer.ts`/`pack-uploader.ts`, the same PR must
add their ownership lines to `docs/CODEMAP.md`. `RboxApi` remains the facade;
the publish pipeline does not own wire framing.

The pack uploader consumes permits from the existing upload slot budget. A
record moved into a pack is removed from the ordinary batch uploader; a pack
PUT occupies one of those same permits. No independent pack-slot pool exists.
Because today's permit counter is `BlobBatchUploader`'s private `active` field
(`uploader.ts`), this is a named implementation requirement, not an emergent
property (round 1): extract one shared upload-permit arbiter (owned beside the
existing process-wide state in `gate.ts`) that both the batch lane and the pack
lane draw from, and add a mixed-lane test asserting combined in-flight
batch+pack requests never exceed the configured slot count.

Capability and disable signaling is machine-readable and distinct from
transient fences (round 1): when `RBOX_BLOB_PACK_ACCEPT` is off, the route
returns **`404 { error: "pack_disabled" }`** — the same latch class as a
route-absent old server (404/405). `503 retry_later` remains reserved for the
post-write fence case only, exactly as in the batch lane, and the client
treats it as defer-and-retry, never as capability absence. The client-side
pack-off latch is a **separate flag in `gate.ts`**; it must NOT reuse
`disableUploadForProcess()`, which would wrongly collapse the established
batch lane to single PUTs. Latching pack-off requeues all unsettled members
into the ordinary batch/single uploader.

Client pack construction uses temp files in the existing run temp directory,
not 8 MiB multiplied by all active slots in heap. Temp files are deleted only
after all member promises have settled or on scoped abort cleanup.

### 4. Location-bound receipts and accounting

Per-blob receipts are mandatory. Extend the opaque receipt payload with a v2
variant whose authenticated claim is:

```text
{ accountId, encSha, logicalSize, storage:"pack", packId, issuedAt, expiresAt }
```

The receipt deliberately does **not** carry `offset`/`length`/`packSha256`
(round 1): the authoritative extent lives in the server's immutable
`pack_members` inventory, written before the receipt was minted. Redemption
resolves placement by `(packId, encSha)` from `pack_members` joined against
`packs.state = 'ready'`, so a receipt (or a bug in receipt handling) can never
install an offset/length tuple that the physical inventory does not prove.
This also keeps v2 receipt bytes close to v1: the only additions are the
storage tag and the 32-hex `packId`, bounding the encoded entry growth under
~90 bytes. Design 111's slicer is **byte-bounded** at 7 MiB
(`sliceReceiptBatch`, `src/cli/remote/commits.ts`), so even the larger entries
degrade only the per-request count, never the cap; a unit test pins the
worst-case v2 entry byte size.

Receipt v1 continues to mean `storage:"canonical"` at `blobKey(encSha)`.
Clients treat both versions as opaque strings; `RemoteContext.receipts` and the
design-111 generation-safe drainer remain `encSha -> receipt`. Count and byte
slicing, exact-generation deletion, 422 handling, retry, and final-drain-before-
commit semantics do not change.

`verifyReceipt` returns authenticated logical size plus placement intent. The
dedicated redeem endpoint and commit fallback feed that into
`commitAccounting`. In the same D1 accounting super-batch that catalogs
`blobs.present=1`, charges quota, grants `blob_refs`, clears
`blob_ref_candidates`, and un-condemns a non-active logical candidate,
accounting also installs the active location: a v2 receipt inserts the
`pack_members`-derived extent; a v1 receipt deletes any packed active location
(selecting canonical storage). Former-pack candidacy on displacement is
handled atomically by the schema trigger in §5, not by JS pre-reads. The
location install is guarded by the pack delete-fence trigger described in §7.

**Skip-if-entitled semantics are the deployed reality and are kept** (round
1): both the redeem endpoint and commit admission skip receipts whose sha is
already in the entitled+present `have` set (`workspace-sync.ts` redeem loop;
`validateCommitRefs`). A skipped receipt therefore installs **no** placement
change. This is safe by the following invariant, which the property rig
asserts: *an entitled+present logical blob always retains a valid active
placement* — its packed location (if any) cannot be under an active pack
intent (an active location blocks intent-open, §7.3), and its canonical object
cannot be deleted (logical Phase 2 requires zero refs). The skipped receipt's
own pack simply never gains that location and, if it ends with zero locations,
ages out as a safe orphan. Consequently `/v1/blobs/check`'s new
usable-location clause (§6) is defense-in-depth, not a load-bearing filter.

The critical ordering is:

```text
cap + structural/member verification
  -> immutable uploading inventory
  -> pack R2 PUT
  -> logical + pack fence read
  -> inventory ready
  -> mint per-blob location-bound receipts
  -> redeem: atomic catalog + charge + entitlement + active location
  -> commit admission / head CAS (unchanged)
```

No location is visible merely because an unredeemed pack exists. Conversely,
redemption may precede the commit, exactly like entitlement today; Phase 1's
grace and authoritative retained-root pass handle abandoned redeemed uploads.
The NOT-EXISTS charge guard remains keyed by `(account_id, encSha)`, so moving or
retrying placement never double-charges a logical blob. Quota is charged by the
per-blob ciphertext length, not by pack overhead and not by the whole pack for
each member.

### 5. D1 placement schema

Names are illustrative until migration review, but the invariants are binding:

```sql
CREATE TABLE blob_locations (
  sha256      TEXT PRIMARY KEY,
  storage     TEXT NOT NULL CHECK (storage IN ('pack')),
  pack_id     TEXT NOT NULL,
  offset      INTEGER NOT NULL,
  length      INTEGER NOT NULL,
  pack_sha256 TEXT NOT NULL,
  installed_at INTEGER NOT NULL
);
CREATE INDEX blob_locations_pack ON blob_locations(pack_id);

CREATE TABLE packs (
  pack_id      TEXT PRIMARY KEY,
  pack_sha256  TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  member_count INTEGER NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('uploading', 'ready', 'swept')),
  created_at   INTEGER NOT NULL,
  touched_at   INTEGER NOT NULL   -- §3 repair heartbeat; sweeper requires BOTH past grace
);

CREATE TABLE pack_members (
  pack_id TEXT NOT NULL,
  sha256  TEXT NOT NULL,
  offset  INTEGER NOT NULL,
  length  INTEGER NOT NULL,
  PRIMARY KEY (pack_id, sha256)
);

CREATE TABLE pack_gc_candidates (
  pack_id     TEXT PRIMARY KEY,
  marked_at   INTEGER NOT NULL,
  deleting_at INTEGER
);
```

Plus the indexes the executors actually scan (rounds 1–2), shaped for the
keyset cursors exactly as migration 0024 shapes them for `gc_candidates`:
`packs(created_at)` (with `touched_at` in the sweep predicate) for the
orphan-grace scan, and composite partial indexes
`pack_gc_candidates(marked_at, pack_id) WHERE deleting_at IS NULL` and
`pack_gc_candidates(deleting_at, pack_id) WHERE deleting_at IS NOT NULL` for
the cursored mark/execute passes in `versions.ts` style.

Three triggers make the placement lifecycle D1-serialized rather than
JS-read-then-hope (round 1 findings):

1. **Install guard (`rbox_pack_delete_fence`, raised as
   `rbox_delete_fence_pack`):** any INSERT/UPDATE of `blob_locations` whose
   `pack_id` has `pack_gc_candidates.deleting_at IS NOT NULL` →
   `RAISE(ABORT, 'rbox_delete_fence_pack')`. The message deliberately contains
   the existing `rbox_delete_fence` substring so the deployed classifier
   (`isDeleteFenceAbort`, `commit-accounting.ts`) — and any rollback binary
   carrying it — already converts the abort into the caught-super-batch 422
   `needsUpload` recovery. A test covers a mixed v1/v2 super-batch hitting
   this trigger.
2. **Inventory guard:** any INSERT/UPDATE of `blob_locations` must match an
   existing `pack_members(pack_id, sha256)` row with identical
   `offset`/`length` and a `packs.state = 'ready'` parent, else
   `RAISE(ABORT)`. Combined with §4's pack_members-derived install, an
   accounting bug cannot become durable serving state pointing at bytes the
   immutable inventory does not prove.
3. **Displacement candidacy:** AFTER DELETE on `blob_locations` (and AFTER
   UPDATE of `pack_id`, if an upsert path ever rewrites one), when
   `OLD.pack_id` has no remaining `blob_locations` rows, INSERT OR IGNORE an
   unopened `pack_gc_candidates(OLD.pack_id, now)`. This closes the v1-
   displacement and v2 A→B races without a post-delete JS lookup losing the
   former pack identity.

Because trigger 3 can fire on transient states, the pack-GC mark pass also
**resurrects** (deletes) any unopened pack candidate whose pack has regained
active locations, mirroring `openIntents`' resurrect arm.

`pack_members` is immutable physical inventory retained until the pack object is
deleted. `blob_locations` is the active serving map. Its absence means legacy
canonical storage, so there is no row or migration for the old estate. The API
must never infer canonical presence from location absence alone: the existing
`blobs.present`, entitlement, and candidate checks remain authoritative before
physical fetch.

The tables live in the same account-data D1 routing domain as `blobs`,
`blob_refs`, and `gc_candidates`. Keying stated precisely (round 1):
`blobs.sha256` is already a **global** primary key (migration 0001) — only
`blob_refs` is `(account_id, sha256)` — and the deployed model is effectively
single-tenant per content address, so a global `blob_locations.sha256` key
follows the existing `blobs` convention, not an account-uniqueness claim. A
future cross-account physical-dedup design must revisit these keys together
with the pack-wide zero-location predicates; design 114 does not introduce
that sharing.

The migration ships as the next free number — **0025 at time of writing,
re-checked after any rebase** per `apps/api/migrations/README.md` (filenames
are append-only; the vitest config guard fails on collisions).

### 6. Addressing and read path

Authorization order does not change: validate a download grant or entitlement
for the requested logical SHA **before** revealing placement or touching R2.
After authorization:

1. read `blob_locations` for `encSha`;
2. if a row exists, issue `R2.get(packKey(packId), { range: { offset, length } })`;
3. require the returned byte count to equal `length` **and SHA-256 of the
   returned extent to equal the requested `encSha`** (round 1: a corrupted
   equal-length offset would otherwise serve wrong bytes with HTTP 200 — the
   canonical path has no such failure mode because the key *is* the hash;
   hashing a ≤256 KiB extent is negligible Worker CPU). Then buffer/stream it
   as the ordinary `application/octet-stream` blob body;
4. if no row exists, use the current `R2.get(blobKey(encSha))` path.

The single GET URL, status behavior, grant behavior, content type, and returned
ciphertext bytes are unchanged. The client still hashes/decrypts/verifies the
per-blob ciphertext as today. A missing pack/range, size mismatch, or extent
hash mismatch is a server storage error/not-found equivalent and is paged (an
extent-hash mismatch is specifically an index-corruption signal); it must never
fall through to a canonical key because that could mask a torn location
transition.

For `POST /v1/blob-batch/get`, entitlement/grant checks remain per requested
SHA and result frames retain the existing `(sha, payload|status)` semantics.
The server resolves all authorized SHAs in one D1 placement query, then groups
packed members by `packId`. Coalescing is governed by **two independent
budgets** (round 1 — the response cap alone does not bound Worker memory,
because a covering range fetches gap bytes that never enter the response, and
today's implementation pre-buffers all results concurrently,
`blob-batch.ts::streamBatch`):

- the existing 8 MiB **response** cap on emitted frame payloads, unchanged; and
- an 8 MiB **fetch-byte** budget counting every fetched byte at full covering-
  range size, across all packs and canonical objects in the request.

For each pack the server coalesces requested extents into the smallest covering
range only while both budgets hold; otherwise it issues exact per-extent ranges
(no gap bytes). It slices the returned range back into independent frames and
verifies exact lengths plus per-extent SHA-256 as in the single path. Unpacked
members use the existing canonical GET fan-out. Response order may remain
completion order as it is today. The client batch downloader and single
fallback require no pack knowledge.

This adds D1 placement lookup to the verified-download-grant preauth path,
which is currently D1-zero. That cost is accepted for correctness in v1 and is
an explicit read-latency gate. Encoding placement into grants is rejected: a
grant spans many blobs and would become stale across GC/location replacement.

`/v1/blobs/check` retains its visible contract exactly: return `missing` unless
the account has a live, entitled, present, non-Phase-1-marked, non-active-GC
logical blob. The query additionally requires a usable physical location:
canonical by default or a packed location whose pack is not under active pack
deletion. Old clients do not learn that packs exist and react to `missing` by
uploading canonical bytes as they do now.

### 7. Reference accounting and conservative GC

Designs 96 and 102 remain authoritative for **logical** reachability. DO roots,
refsets, `blob_refs`, `blob_ref_candidates`, and `gc_candidates` continue to
contain individual `encSha` values. Packs are never roots and never appear in a
commit. Pack lifetime is derived from active logical placements; it cannot make
a logical ref reachable or entitled.

#### 7.1 Phase 1 is unchanged

`apps/api/src/gc-phase1.ts` still computes authoritative per-account reachable
logical SHAs from design-96 roots, marks unreachable `blob_refs`, recomputes
roots before purge, atomically releases quota/removes the ref under the
`blob_ref_candidates` marker, and condemns a globally unreferenced logical SHA
in `gc_candidates`. It does not delete R2 and does not reason about packs.

This is deliberate: all members of a pack may have different workspace and
retention lifetimes. Charging, resurrection, and candidate barriers must remain
per blob.

#### 7.2 Logical Phase 2 retires a packed location, not a byte range

For a canonical candidate, `versions.ts` keeps the existing R2 delete flow.
For a candidate whose active `blob_locations` row points into a pack, the
executor uses the existing purge lease, intent quiescence, fresh reachable set,
and final zero-`blob_refs` check, but it **does not modify the R2 pack**. Under
the same live lease and active logical intent it atomically:

1. deletes that exact active `blob_locations(sha256, pack_id)` row — with the
   zero-ref, open-intent, and live-lease predicates **embedded in the DELETE
   statement itself** inside the same `db.batch`, exactly like
   `versions.ts::cleanupCandidate` repeats its guards per destructive
   statement (round 2: a prior JS readiness check is not the guard);
2. deletes the logical `blobs` catalog row and logical `gc_candidates` row under
   the existing zero-ref/open-intent guards; and
3. relies on the §5 displacement trigger: the location DELETE itself atomically
   inserts the un-opened `pack_gc_candidates(OLD.pack_id, now)` row when it was
   the pack's last active location — no JS re-read of the pack id.

The immutable `pack_members` row remains until physical pack deletion, so audit
and retry can prove what the object contains. Retiring a member does not punch a
hole or reclaim physical bytes. A later request for that `encSha` sees missing
and uploads a fresh canonical object or a member of a fresh pack.

If the logical candidate resurrects before retirement, design 102's existing
marker/fence machinery clears or aborts it and the active location remains. If
it resurrects after retirement, the new receipt installs a new location; it
never points back into the old condemned pack.

#### 7.3 Physical pack deletion is a second, stricter fence

Pack GC is disabled initially and has its own kill switch. When enabled it is a
two-pass lease/quiescence executor modeled on existing `gc_candidates`:

- **mark:** only after `NOT EXISTS (SELECT 1 FROM blob_locations WHERE
  pack_id=?)` and an orphan grace of at least **13 hours** after `created_at`.
  A live member pins the pack indefinitely. Both `uploading` crash remnants and
  `ready` packs with no redeemed members use this same grace—there is no faster
  unsafe orphan path. The grace exists so a mark cannot race the *original*
  upload's redemption window; it is deliberately **not** the receipt-expiry
  argument (round 1: same-id retries re-mint receipts with a fresh 12-hour TTL,
  so no `created_at`-anchored window bounds the last valid receipt);
- **open intent:** after pack grace, atomically set `deleting_at` only if the
  same zero-active-location predicate still holds;
- **execute:** under an unexpired purge lease and intent quiescence, recompute
  and require zero active locations again, then delete `packs/v1/<packId>`, HEAD
  to confirm absence, and finally delete `pack_members`, `packs`, and the pack
  candidate;
- **unwind:** any active location or failed delete/HEAD clears or leaves the
  physical intent safely for retry; it never guesses success.

The safety of the terminal step — deleting the `pack_gc_candidates` row, which
retires the install trigger's fence — rests on three named, individually
enforced properties (round 1 restated this from a hand-wave into an invariant):

1. **Mint fence covers every candidate state, with pre-read timestamp
   anchoring.** Receipt minting (and same-id retry) for pack `P` fails closed
   on **any** `pack_gc_candidates` row for `P` — marked *or* opened, not just
   `deleting_at IS NOT NULL`. Because an HTTP invocation has no duration bound,
   "minted before mark" cannot be a wall-clock claim about when the HMAC
   completes (round 2); instead the signed `issuedAt` is **captured before the
   fence read**, exactly as `mintFenceCheckedReceipts` already anchors
   `checkTime` today (`blobs.ts`). What D1 order actually gives (round 3 —
   `marked_at`/`deleting_at` are JS invocation clocks, NOT database-assigned
   times, so no inequality against them follows from serialization): for every
   receipt whose fence read found no candidacy,
   `issuedAt < T_mark` where `T_mark` is the **wall time the mark INSERT
   landed** — the read preceded the insert in database order and `issuedAt`
   was captured before the read.
2. **Install fence covers the open intent.** The §5 trigger aborts any
   location install into a pack with an open intent, and a pre-intent install
   makes the intent-open predicate false — either way an await-sized race
   cannot thread between them.
3. **Quiescence dominates receipt lifetime plus clock staleness, per candidacy
   epoch — `PACK_INTENT_QUIESCENCE ≥ RECEIPT_TTL_MS + CLOCK_SKEW_MS +
   GC_CLOCK_STALENESS_BUDGET`.** A candidacy can be resurrected away (the §5
   resurrect arm removes an unopened candidate when the pack regains
   locations), after which minting legitimately resumes — so "never minted
   again after the first candidacy" is false and is not the invariant (round
   2). The invariant is **per candidacy epoch**: the candidacy that reaches
   delete existed continuously from its mark through the delete (intent-open
   re-checks, and the executor deletes the row only at the end), so by
   property 1 every valid receipt for `P` has `issuedAt < T_mark`, the wall
   time this epoch's mark landed. The wall-clock chain (round 3 — JS
   timestamps are stale by up to their invocation's age, so staleness must be
   budgeted, not assumed away):
   - `deleting_at` is the open pass's invocation-start clock; the open pass
     observed the mark row, so `deleting_at ≥ T_mark − S` where `S` bounds one
     GC invocation's age (the executor runs under a hard wall deadline — 15
     minutes today, `versions.ts::gcPurge` — so `S = 1 h` is a ≥4x-margin
     budget, compile-asserted against the deadline constant);
   - the execute pass requires `nowMs_exec − deleting_at > quiescence` and
     `nowMs_exec ≤ T_delete`, hence
     `T_delete > T_mark − S + quiescence`;
   - every valid receipt expires by `issuedAt + TTL + skew < T_mark + TTL +
     skew`, so with `quiescence ≥ TTL + skew + S` no unexpired receipt exists
     at the delete or at the terminal candidate-row removal.
   With 24 h quiescence, 12 h TTL, 60 s skew, and `S = 1 h` the margin is
   ≈ 11 h. The constant relation is compile/test-asserted; gate 5b injects
   stale invocation clocks to exercise it.

The deletion proof is conservative, and case-complete over how a pack reaches
zero active locations (round 1: the previous single-case proof omitted two
legitimate histories):

```text
pack delete
=> active pack intent + live lease + quiescence ≥ receipt TTL + skew
=> zero active blob_locations at intent open and immediately before delete
=> every former or would-be member is in one of exactly three states:
   (i)  logically retired — its location was removed under that blob's own
        gc_candidates intent + zero refs + fresh design-96 reachability (§7.2);
   (ii) relocated — an authenticated receipt redemption atomically replaced
        the location with another verified placement (canonical via v1, or a
        different ready pack via v2); the blob is live and served elsewhere;
   (iii) never published — the member was uploaded but never redeemed (orphan
        pack, fenced retry, abandoned client); its receipts are expired by
        property 3 and its bytes were never a serving location.
=> no published/entitled logical blob resolves into the pack
```

An all-members-unreferenced test alone is insufficient because a ref could be
regranted between a JS read and R2 delete. The active-location trigger and pack
intent are the D1-serialized barrier. This is the same reason design 102 relies
on a live D1 invariant rather than a read-then-hope fence snapshot.

**Kill-switch boundary, stated honestly** (round 1): `RBOX_BLOB_PACK_GC` is a
Worker env var, fixed per invocation — flipping it cannot recall an invocation
already executing, exactly like the existing GC flags. The exposure is bounded
by the executor's own limits (page-capped rows, wall deadline, single purge
lease); the flag guarantees no *new* invocation marks, opens, or deletes. This
is the same boundary the platform gives every env-var kill switch and is
accepted; a mid-invocation abort mechanism would require a durable-state flag
read per page and is not part of v1.

There is no compaction in v1. A pack with 897 dead members and one live member
keeps the full object. This knowingly sacrifices storage efficiency for fence
correctness. Operators may disable physical pack GC without disabling uploads,
reads, logical GC, or accounting.

### 8. Failure, retry, and resume

- Client crash before the pack PUT request: no server state; queued member
  promises retry.
- Server crash after inventory insert but before the R2 PUT: an `uploading`
  inventory row remains (this IS server state — round 2); the client retries
  same-id (heartbeat + repair, §3) or fresh-id; an abandoned row ages past the
  orphan grace and the sweeper removes inventory, then any object.
- R2 PUT failure: no receipts; retry the whole pack.
- Crash after R2 PUT but before response: retry same `packId` + checksum;
  idempotent validation (conditional heartbeat + single-row ready transition,
  or the ready-state verify branch when the transition already happened)
  returns fresh per-blob receipt generations.
- Same-id repair racing the orphan sweeper: the repair's conditional heartbeat
  or ready transition affects zero rows → fail closed, no receipts, fresh
  `packId`; the sweeper's inventory-first ordering leaves no
  served-but-uninventoried object.
- Fence after R2 PUT: no receipts; pack is an orphan. Client retries members in
  a fresh pack after `retry_later`; pack GC eventually removes the orphan.
- Some receipts redeemed before client death: they are normal per-blob
  entitlements/locations. Resume `/check` skips those blobs; unredeemed members
  are uploaded again. NOT-EXISTS charging prevents double charge.
- Kill during receipt draining: design 111 exact-generation deletion and final
  flush rules are unchanged.
- Kill after all redemption but before commit: Phase 1 grace protects the
  abandoned refs initially; later retained-root GC reclaims each logical member
  and eventually the pack.
- Batch/single read of a mixed pack/canonical set: each frame resolves
  independently; one packed failure falls through only to the existing client
  single-GET retry, never to an alternate server placement.
- Client packer failure or server 404/405/415 capability response (including
  `404 pack_disabled`): settle no member twice; monotonically latch packing off
  for the process via the pack-only gate (§3 — never
  `disableUploadForProcess`) and requeue every unsettled member into the
  existing batch/single uploader.

### 9. Metrics and privacy

Add only numeric and low-cardinality fields:

- client: eligible count/bytes, packs built/sent, members/pack, payload and
  overhead bytes, pack queue/build/upload wall, fallback reason enum;
- server upload: member count, body/payload bytes, parse/hash/R2/fence/receipt
  wall, outcome enum;
- reads: canonical vs packed counts, R2 range count, requested vs covering-range
  bytes, outcome enum;
- GC: logical packed locations retired, packs marked/opened/deleted/unwound,
  pinned pack count and aggregate pinned bytes.

No raw paths, SHAs, pack IDs, account/workspace/device IDs, path hashes, or
member-order fingerprints enter metrics or logs. Debug output follows the same
rule; integrity failures report only count/index class and error enum.

## Flags and rollout

### Kill switches

- Client `RBOX_BLOB_PACK`: unset/`0` = off for the initial release; `1` = pack
  eligible small ciphertexts. This is independent of `RBOX_BATCH_BLOBS` so an
  operator can disable packs while retaining the established batch lane.
- Server `RBOX_BLOB_PACK_ACCEPT`: default `0`; enables only the additive pack PUT
  route. Reads of existing packs stay enabled regardless—an upload kill switch
  must never strand stored data.
- Server `RBOX_BLOB_PACK_GC`: default `0`; enables physical pack intent/deletion.
  Logical per-blob GC stays enabled. This is the last flag enabled and the first
  disabled on any fence anomaly.

The pack-size/cutoff/count policy is compiled and reported, not an open-ended
production env surface in v1. The upload sweep may override target bytes and
cutoff only against the dev API.

### Server-first order

1. Add schema, receipt-v2 verification/accounting, location-aware reads/check,
   and metrics. Keep pack acceptance and pack GC off. Deploy dev first per
   `docs/DEPLOYMENTS.md`; D1 migrations auto-apply on the Workers build. **This
   release is the pack rollback floor** (version skew section below).
2. Enable pack acceptance in dev. Upload/read/GC-shadow fixtures; keep physical
   pack deletion off. Run the rollback drill against the floor build.
3. Deploy server support to production with acceptance off; after the floor
   has soaked one release cycle, enable acceptance. Old clients remain
   canonical.
4. Release a client with `RBOX_BLOB_PACK=0`; canary flag-on against dev and then
   internal production accounts.
5. Promote client packing only after throughput, resource, and correctness
   gates pass. Keep server acceptance on through at least one client rollback
   window.
6. Run pack GC in read-only shadow, then mark-only, then supervised delete in
   dev. Enable production physical deletion only after the fence property gates
   and a full grace window. It may remain off indefinitely without blocking the
   throughput win.

### Version skew

| Server | Client | Behavior |
|---|---|---|
| old | old | Canonical/batch behavior unchanged. |
| new, pack off | old | Canonical uploads and all reads unchanged. |
| new, pack on | old | Old client uploads canonical forever; server reads mixed estate. |
| old/no route | new, pack flag on | First 404/405/415 latches packing off for the process (pack-only latch, §3 — never `disableUploadForProcess`); all unsettled members requeue to existing batch/single PUT. |
| new, acceptance off | new, pack flag on | Machine-readable `404 pack_disabled` (decided, §3) latches client pack-off; no retry loop; batch lane unaffected. |
| new, acceptance on | new, pack on | Target packed upload; per-blob receipts and unchanged commits. |
| server ≥ rollback floor, rolled back after packs exist | any | Pack reads and receipt-v2 verification remain in the binary; only new pack PUTs stop. |
| server **below** the rollback floor | any | **Packed data is unavailable and v2 receipts unverifiable. Not a rollback target once acceptance has ever been on in that environment.** |

Receipt v2 and packed reads are storage compatibility, not removable feature
flags — and "forbidden" is made mechanical rather than aspirational (round 1
BLOCKER):

- **Rollback floor.** The release that first ships the pack reader, placement
  read path, and receipt-v2 verification (rollout step 1) is the **pack
  rollback floor**. Its deployed version is recorded in this design, in
  `docs/STATUS.md`, and as a named constant beside the reader code.
- **Reader-first soak.** Production pack **acceptance** (step 3+) may be
  enabled only after the floor release has been the stable production build
  through at least one subsequent release cycle, so every plausible rollback
  target still reads packs and verifies v2 receipts.
- **Rollback drill (gate), operationally pinned** (rounds 2–3). In dev, after
  writing and redeeming real packs: from `apps/api` (the wrangler config
  root), record the floor and active Worker version IDs
  (`cd apps/api && npx wrangler versions list` against the dev worker),
  redeploy the floor build at 100% via
  `npx wrangler versions deploy <floor-version-id>@100%` (acceptance off),
  assert packed single/batch GETs return byte-identical ciphertext,
  outstanding v2 receipts redeem, and `/v1/blobs/check` is unchanged; then
  restore the recorded active version the same way and re-verify. "One
  release cycle" of soak is
  defined measurably: the floor (or a later reader-capable build) has been the
  deployed production Worker for **≥7 days and ≥1 subsequent production
  deploy**, so every version in the plausible rollback window reads packs.
  This drill is a promotion gate, not documentation.
- **Inherent residual, stated plainly.** No mechanism can make a pre-floor
  binary read a format it predates; that is true of every storage-format
  addition. The control is that rollback below the floor is never required for
  a 114-originated problem: every 114 behavior above the floor is
  independently disableable by flag (acceptance, client packing, pack GC).

## Validation

### Unit and API gates

- Golden pack-format vectors in client and Worker: empty/truncated/over-cap,
  wrong magic/version/reserved, integer overflow, duplicate SHA, noncontiguous or
  overlapping extents, directory/footer mismatch, whole-pack mismatch, member
  SHA mismatch, 2,048/2,049 count, and exact 8 MiB boundary.
- Cross-implementation golden: client-built bytes parse to identical directory
  entries in Worker; extracting each extent reproduces the original ciphertext
  and `encSha`.
- Pack PUT performs exactly one R2 PUT and returns one ordered per-blob receipt;
  any member failure returns no receipts. Same-ID/same-checksum retry is
  idempotent; same-ID/different-checksum fails.
- Receipt v1 selects canonical; v2 installs the `pack_members`-derived packed
  placement (never receipt-carried offsets). Redeeming twice grants/charges
  zero the second time; a receipt for an already-entitled sha is skipped and
  installs no placement change (§4 skip-if-entitled), asserted directly. Mixed
  v1/v2 batches preserve design 111 count+byte slicing, exact-generation
  deletion, 422 whole-super-batch recovery, and final flush before commit; the
  worst-case encoded v2 entry byte size is pinned by test against the 7 MiB
  slicer.
- A mixed v1/v2 accounting super-batch that trips `rbox_delete_fence_pack`
  converts to the caught-super-batch 422 `needsUpload` via the existing
  `isDeleteFenceAbort` classifier (substring compatibility asserted by test).
- `/v1/blobs/check` response for the same logical D1 state is identical for
  canonical and packed storage, including old-client headers, Phase-1 marks,
  active logical intents, and active pack intents.
- Single GET range boundaries and batch GET grouping return byte-identical
  ciphertexts for canonical, packed, and mixed requests; grant and entitlement
  checks happen before placement/R2 access; missing/torn pack does not canonical-
  fallback.

### GC/fence property gates — release blocking

Extend the design-96/102 property rig with randomized histories containing
canonical and packed locations. At every injected await/crash boundary assert:

1. every accepted commit ref resolves to present bytes;
2. no R2 pack delete occurs while any active `blob_locations` row points to it;
3. a Phase-1 stale snapshot can mark but cannot retire a head-reachable member;
4. logical intent vs receipt redemption either aborts the accounting super-batch
   to `needsUpload` or leaves a live location—never partial publication;
5. pack intent vs packed receipt/location install is D1-serialized by the
   `rbox_delete_fence_pack` trigger;
5b. while any `pack_gc_candidates` row exists for a pack, no receipt for that
   pack is minted (same-id retry included); every signed `issuedAt` anchored by
   a passing fence read precedes the wall time the current candidacy's mark
   landed; and every such receipt is expired before that candidacy's delete
   step can run (`PACK_INTENT_QUIESCENCE ≥ RECEIPT_TTL_MS + CLOCK_SKEW_MS +
   GC_CLOCK_STALENESS_BUDGET`, asserted at compile/test time against the
   executor deadline) — exercised with clock-injected histories covering:
   mint→mark→retry-mint (must fail); pre-mark install→resurrect→retry-mint
   (must succeed)→last-location-delete→fresh mark→delete with quiescence
   restarted from the NEW intent; **stale invocation clocks** (mark/open passes
   whose `nowMs` lags their statements' landing by up to the deadline); and
   installs attempted at every await boundary;
6. re-add before logical retirement preserves the old location; re-add after
   retirement installs a fresh canonical/new-pack location and cannot resurrect
   the condemned pack;
7. one live member pins the pack; the pack becomes deletable only after the last
   active location retires;
8. lease expiry, R2 delete failure, HEAD-still-present, process kill, and cursor
   resume never clear a fence early or double-delete accounting state; and
9. brute-force retained roots equal design-96 indexed roots throughout.

Run these tests with pack GC disabled, shadowed, mark-only, and executing. Any
fence divergence disables `RBOX_BLOB_PACK_GC`; throughput rollout does not waive
this gate.

### Rig, kill/resume, and mixed estate

- Extend `bun run rig` with a permanent mixed estate: old canonical blobs, new
  packs, new canonical uploads from an old-client fixture, and no repacking.
  Join, restore, history, and ordinary sync must be byte-identical.
- Inject SIGINT/SIGKILL while building a temp pack, during pack PUT, after R2
  success/before response, during receipt drain, after partial redemption, and
  before commit. Resume must converge with the same committed ref set, no double
  charge, no stranded promises/temp files, and no premature commit.
- Roll acceptance off mid-publish: in-flight requests settle, new work falls
  back once, and the publish completes canonically without adding slots.
- Exercise both single and batch GET with ranges at pack boundaries and with a
  response crossing the 8 MiB batch cap.

### Upload sweep and promotion gates

Extend `rig/upload-sweep` with a `PACK_SET="0 1"` axis and recorded effective
pack target/cutoff/count, while holding the same corpus, host, 630 Mbps network
placement, API build, receipt settings, and upload slots. The script must require
an explicit dev `RBOX_API` for experimental size/cutoff cells and retain design
112's randomized repeated-cell discipline. Capture at least five cold publishes
per candidate plus canonical controls.

Promotion requires all of:

1. **Primary wall gate:** median small-file upload wall throughput
   **≥150 Mbps**, with no run below 120 Mbps, on the same `flat-meadow` corpus and
   host whose best current wall is 48.8 Mbps. Report total publish wall and
   receipt/commit tails separately.
2. **Object-count gate:** physical R2 PUT count for pack-eligible blobs falls by
   **≥95%** and observed mean members per non-tail pack is ≥700 at the field
   corpus mean. Canonical fallback count is non-inferior outside injected faults.
3. **Bandwidth-shape gate:** uploaded ciphertext bytes are identical ± pack
   overhead; median pack payload is ≥6 MiB; pack overhead ≤1%; projected and
   measured physical counts are reported side by side.
4. **Server resource gate:** zero Worker 1102/OOM/subrequest-limit errors; p99
   pack handler wall <10 s; per-request CPU <50% of configured limit; body never
   exceeds 8 MiB; aggregate error/retry rate non-inferior. Because the 128 MiB
   limit is per **isolate**, not per request (round 2), and remote fan-out may
   spread across isolates (round 3), the memory check is two-layered: (i) a
   deterministic same-isolate harness in the existing workers vitest runtime
   driving N concurrent pack-PUT + mixed batch-GET handler invocations with
   full 8 MiB bodies in one isolate, and (ii) the remote dev stress cell (24
   concurrent pack PUTs overlapped with batch GETs) for platform behavior —
   the same transient-buffer class the existing 8 MiB batch lane already
   carries (~16–24 MiB per in-flight request), made explicit rather than
   assumed.
4b. **Read gate — dedicated matched cells** (round 1: five cold publishes
   cannot establish read percentiles). A separate read harness runs, on the
   same host/API build, ≥200 single GETs and ≥50 32-record batch GETs per arm
   against the *same logical corpus* stored packed vs canonical (cold client
   cache; the two arms interleaved to share network weather). Gate: packed p95
   regresses ≤20% vs the matched canonical p95 for both shapes, computed
   nearest-rank; missing telemetry for any cell fails the gate rather than
   passing silently. Join wall: ≥5 matched joins per arm, median regression
   ≤5%.
5. **Receipt/accounting gate:** newly granted logical refs and charged bytes equal
   unique successful ciphertext members and their ciphertext sizes, not pack
   count or physical bytes; repeat redemption charges zero; final drain obeys
   design 111's ≤5 s median/≤10 s max candidate gate where applicable.
6. **Correctness gate:** every GC/fence property above passes, mixed-estate join
   is byte-identical, and all kill/resume cases converge.
7. **Privacy gate:** sweep output and production metrics contain counts, bytes,
   timings, flags, and low-cardinality reasons only—no paths, SHAs, pack IDs, or
   account/workspace/device identifiers.

If throughput misses 150 Mbps but object count and correctness pass, do not
raise the 8 MiB cap or add slots under this design. Use the measured pack R2
write curve to decide whether a separately reviewed larger streaming-pack
format is warranted. If read or GC correctness fails, keep packing off; storage
format correctness is not traded for upload throughput.

## Out of scope

- Repacking historical canonical blobs.
- Pack compaction or relocating a still-live member.
- Cross-account pack sharing or deduplication.
- Changing per-blob encryption, content addressing, manifests, refsets, commit
  envelopes, WorkspaceSync sequencing, or design-96 root semantics.
- Raising upload slots, the 8 MiB v1 pack body cap, or the 256 KiB packing
  cutoff.
- Exposing pack IDs or offsets to clients on read paths.
- Making physical pack bytes quota-authoritative; billing remains logical
  ciphertext bytes as today.
