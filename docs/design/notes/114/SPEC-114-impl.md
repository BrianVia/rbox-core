# SPEC-114-impl — blob packing implementation (reader-first rollout step 1)

NORMATIVE SOURCE: `docs/design/114-blob-packing.md` (ALIGNED v6) +
`docs/design/REVIEW-114.md`. Read BOTH before coding your dispatch. When this
spec and the design conflict, the design wins — flag the conflict in your
report instead of silently choosing.

Branch: `impl/114-blob-packing`. Work only in this worktree.

## Global constraints (every dispatch)

- No plaintext ever reaches the server; packs carry opaque per-blob ciphertexts.
- Metrics/logs: numeric + low-cardinality enum fields ONLY. Never raw paths,
  SHAs, pack IDs, account/workspace/device IDs (house rule; see `metrics.ts`,
  `util.ts::logErr`).
- Old clients and the existing canonical estate must be completely unaffected.
  Absence of a `blob_locations` row means canonical storage — no backfill, no
  migration of old blobs.
- D1 bound params ≤100 per statement. Mirror the chunking idioms in
  `commit-accounting.ts` / `d1-batch.ts`.
- Follow #264 test hygiene: close/await all async work before test teardown;
  real-time deadlines (no arbitrary tiny sleeps).
- Test commands that must be green after your dispatch:
  - `bun test ./src/` (tolerated pre-existing host flakes: same-SHA heal,
    shellStateOf, ctime)
  - `npm run typecheck`
  - `cd apps/api && npx vitest run`
  - `bun scripts/ci-shard-tests.ts guard --shard-count 6`
- Do NOT touch: `apps/web/`, release workflows, existing migration files,
  `docs/STATUS.md`.
- Commit nothing. Leave the working tree for review.

## Shared vocabulary

- `encSha` = SHA-256 hex of a ciphertext blob (logical identity, unchanged).
- Pack R2 key: `packs/v1/<packId>`; `packId` = 32 lowercase hex (128-bit random).
- Pack format `rbox-pack-v1` (design §2): 16-byte header
  (`magic="RBOXPK01"`, `headerBytes:u32=16`, `flags:u32=0`), contiguous
  ciphertexts, directory of 48-byte entries (`encSha[32] | offset:u64 |
  length:u64`, big-endian, ascending offset), 72-byte footer
  (`magic="RBOXEND1"`, `version:u32=1`, `entryBytes:u32=48`, `count:u32`,
  `reserved:u32=0`, `directoryOffset:u64`, `directoryBytes:u64`,
  `directorySha256[32]`).
- Strict validation (design §2): known magic/version/flags; reserved zero;
  count 1..2048; unique encSha; ascending offsets; every length >0 and
  ≤256 KiB; extents contiguous covering exactly `[headerBytes,
  directoryOffset)`; directoryBytes == count*48; directory hash matches;
  footer ends exactly at EOF; per-extent SHA-256 equals its encSha (hashing is
  the CALLER's job — the codec validates structure and exposes extents).
- Size policy: eligible ciphertext 1..256 KiB; target payload 7.5 MiB; hard
  body cap 8 MiB (whole request incl. header/directory/footer); max 2048
  members; activation ≥16 eligible blobs or ≥1 MiB eligible bytes per publish;
  tail pack may be smaller.

---

## Dispatch 1 — shared pack codec, migration 0025, receipt v2

### 1a. `src/engine/blob-pack.ts` (NEW, dependency-free)

Follow the `src/engine/refset.ts` pattern exactly: pure, zero `node:*` imports,
bundleable into the Worker (apps/api imports it via a relative path like
`../../../src/engine/blob-pack.js` — see `apps/api/src/sidecar.ts`).

Exports:
- Constants: `PACK_HEADER_MAGIC` ("RBOXPK01" bytes), `PACK_FOOTER_MAGIC`
  ("RBOXEND1"), `PACK_HEADER_BYTES=16`, `PACK_FOOTER_BYTES=72`,
  `PACK_DIR_ENTRY_BYTES=48`, `PACK_MAX_MEMBERS=2048`,
  `PACK_MAX_MEMBER_BYTES=256*1024`, `PACK_MAX_BODY_BYTES=8*1024*1024`,
  `PACK_TARGET_PAYLOAD_BYTES=7.5*1024*1024` (integer: 7864320),
  `PACK_MIN_ACTIVATION_COUNT=16`, `PACK_MIN_ACTIVATION_BYTES=1024*1024`,
  `PACK_CONTENT_TYPE="application/x-rbox-pack"`, `PACK_ID_RE=/^[0-9a-f]{32}$/`.
- `interface PackDirEntry { sha256: string; offset: number; length: number }`
  (offsets fit in Number — body ≤8 MiB; still validate integer bounds and
  reject > Number.MAX_SAFE_INTEGER when reading u64).
- `encodePackHeader(): Uint8Array`
- `encodePackDirectory(entries: PackDirEntry[]): Uint8Array` (directory bytes
  only — caller hashes them for the footer)
- `encodePackFooter(f: { count: number; directoryOffset: number;
  directoryBytes: number; directorySha256: Uint8Array }): Uint8Array`
- `packOverheadBytes(count: number): number` = header+dir+footer.
- `parsePack(bytes: Uint8Array): { ok: true; entries: PackDirEntry[] } |
  { ok: false; error: PackParseError }` where `PackParseError` is a string
  enum ("truncated" | "bad_magic" | "bad_version" | "bad_flags" |
  "bad_reserved" | "bad_count" | "bad_entry_bytes" | "bad_directory_bounds" |
  "duplicate_sha" | "bad_order" | "bad_length" | "not_contiguous" |
  "directory_sha_mismatch" — pick precise names, one per structural rule).
  NOTE: `parsePack` CANNOT verify `directorySha256` itself without a hasher —
  accept an optional pre-computed hash comparison instead: signature
  `parsePack(bytes, directorySha256Of: (dir: Uint8Array) => Uint8Array)` where
  the caller passes a synchronous SHA-256 over bytes. Client passes a
  node:crypto-backed fn; Worker passes one over `sha256-stream.ts`'s pure-JS
  SHA-256 or precomputes via crypto.subtle — if awkward, make it
  `parsePack(bytes): {ok:true; entries; directory: Uint8Array;
  directorySha256: Uint8Array}` returning the CLAIMED hash + directory slice
  and let the caller verify (prefer this simpler shape: codec = structure,
  caller = all hashing). Choose the second shape.

### 1b. Bun unit tests `src/engine/blob-pack.test.ts`

Golden vectors per design Validation §"Unit and API gates": empty/truncated/
over-cap bodies, wrong magic/version/flags/reserved, integer overflow u64,
duplicate SHA, non-contiguous/overlapping extents, descending offsets,
directory/footer mismatches, count 0/1/2048/2049, zero-length member, >256 KiB
member, exact 8 MiB total boundary (valid), 8 MiB+1 (caller-capped — codec
just parses), round-trip encode→parse equality of entries.

### 1c. Migration `apps/api/migrations/0025_blob_packing.sql`

READ `apps/api/migrations/README.md` first. 0025 is the next free number —
verify with `ls apps/api/migrations/` and the vitest config guard.

```sql
CREATE TABLE IF NOT EXISTS packs (
  pack_id      TEXT PRIMARY KEY,
  pack_sha256  TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  member_count INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('uploading','ready','swept')),
  created_at   INTEGER NOT NULL,
  touched_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_packs_created ON packs (created_at);

CREATE TABLE IF NOT EXISTS pack_members (
  pack_id TEXT NOT NULL,
  sha256  TEXT NOT NULL,
  offset  INTEGER NOT NULL,
  length  INTEGER NOT NULL,
  PRIMARY KEY (pack_id, sha256)
);

CREATE TABLE IF NOT EXISTS blob_locations (
  sha256       TEXT PRIMARY KEY,
  storage      TEXT NOT NULL CHECK (storage IN ('pack')),
  pack_id      TEXT NOT NULL,
  offset       INTEGER NOT NULL,
  length       INTEGER NOT NULL,
  pack_sha256  TEXT NOT NULL,
  installed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blob_locations_pack ON blob_locations (pack_id);

CREATE TABLE IF NOT EXISTS pack_gc_candidates (
  pack_id     TEXT PRIMARY KEY,
  epoch       TEXT NOT NULL,
  marked_at   INTEGER NOT NULL,
  deleting_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pack_gc_candidates_intent
  ON pack_gc_candidates (marked_at, pack_id) WHERE deleting_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pack_gc_candidates_execute
  ON pack_gc_candidates (deleting_at, pack_id) WHERE deleting_at IS NOT NULL;
```

Triggers (all `IF NOT EXISTS`; model on `0024_gc_state.sql`):

1. Install delete-fence — BEFORE INSERT and BEFORE UPDATE ON `blob_locations`
   WHEN EXISTS (SELECT 1 FROM pack_gc_candidates pg WHERE pg.pack_id =
   NEW.pack_id AND pg.deleting_at IS NOT NULL) →
   `SELECT RAISE(ABORT, 'rbox_delete_fence_pack');`
   The message MUST contain the substring `rbox_delete_fence` (deployed
   classifier `isDeleteFenceAbort`, `commit-accounting.ts:15-17`).
2. Inventory guard — BEFORE INSERT and BEFORE UPDATE ON `blob_locations`
   WHEN NOT EXISTS (SELECT 1 FROM pack_members m JOIN packs p ON
   p.pack_id = m.pack_id WHERE m.pack_id = NEW.pack_id AND m.sha256 =
   NEW.sha256 AND m.offset = NEW.offset AND m.length = NEW.length AND
   p.state = 'ready') → `SELECT RAISE(ABORT, 'rbox_pack_inventory');`
3. Displacement candidacy — AFTER DELETE ON `blob_locations` WHEN NOT EXISTS
   (SELECT 1 FROM blob_locations l WHERE l.pack_id = OLD.pack_id):
   `INSERT OR IGNORE INTO pack_gc_candidates (pack_id, epoch, marked_at)
   VALUES (OLD.pack_id, lower(hex(randomblob(16))),
   CAST(strftime('%s','now') AS INTEGER) * 1000);`
   Plus the same as AFTER UPDATE OF pack_id ON blob_locations WHEN
   OLD.pack_id != NEW.pack_id AND NOT EXISTS (...OLD.pack_id...).

### 1d. Receipt v2 (`apps/api/src/receipts.ts`)

- Export `CLOCK_SKEW_MS` (currently private — pack GC needs it for the
  compile/test-asserted quiescence relation).
- `MintClaim` gains optional `packId?: string`. `mintReceipt`: when `packId`
  present, payload `{ v: 2, a, s, n, t, e, p: packId }`; else v1 unchanged.
  Same domain tag, kid, MAC scheme.
- `verifyReceipt`: accept v1 and v2. v2 requires `p` matching
  `/^[0-9a-f]{32}$/` else `malformed`. `VerifyResult` ok-arm becomes
  `{ ok: true; size: number; packId?: string }` (packId present ⇔ v2 ⇔
  storage "pack"; absent ⇔ canonical). All other checks identical.
- Tests in `apps/api/test/receipts.test.ts` (extend): mint/verify v2
  round-trip; tampered p rejected; v1 unaffected; worst-case encoded v2
  receipt-redeem entry byte size pinned: compute the JSON entry
  `"<64-hex sha>":"<receipt>"` byte length for a worst-case v2 receipt
  (max accountId length seen in fixtures — use a 64-char account id) and
  assert (a) it is under a named constant you add to the test, and (b) the
  v2−v1 delta is < 90 bytes (design §4).

### 1e. Env flags (`apps/api/src/env.ts`)

Add optional `RBOX_BLOB_PACK_ACCEPT?: string` (default off; "1" enables the
pack PUT route only) and `RBOX_BLOB_PACK_GC?: string` (default off; "1"
enables physical pack GC + uploading-orphan sweeper). Doc comments in the
style of the neighbors, naming design 114.

Also add to `apps/api/vitest.config.ts` miniflare bindings:
`RBOX_BLOB_PACK_ACCEPT: "1"`, `RBOX_BLOB_PACK_GC: "1"` (tests exercising the
disabled paths construct `{...env, RBOX_BLOB_PACK_ACCEPT: "0"}` when calling
handlers directly).

Acceptance: all four global test commands green (the new migration must pass
the numbering guard); new codec + receipt tests pass.

---

## Dispatch 2 — server pack PUT endpoint + uploading-orphan sweeper

### 2a. `apps/api/src/blob-pack.ts` (NEW)

Exports used elsewhere: `packKey(packId) => \`packs/v1/${packId}\``,
`packAcceptEnabled(env) => env.RBOX_BLOB_PACK_ACCEPT === "1"`,
`packGcEnabled(env) => env.RBOX_BLOB_PACK_GC === "1"`,
`PACK_ORPHAN_GRACE_MS = 13 * 3600_000`.

`blobPackPut(req, env, accountId)` — POST /v1/blob-pack/put, bearer-authed
exactly like batch PUT (route added in the AUTHED group; grants NEVER appear
in this wire contract). Metrics op `blob.packPut` via `startOp`; outcomes are
low-cardinality enums; `op.done(outcome, { count: memberCount, bytes:
bodyBytes })`.

Flow (order is load-bearing — design §3/§4 "critical ordering"):

1. `packAcceptEnabled` false → `404 { error: "pack_disabled" }`.
2. `usesReceipts(req)` false → `400 { error: "receipts_required" }`.
3. Headers: `x-rbox-pack-id` must match PACK_ID_RE, `x-rbox-pack-sha256`
   64-hex, content-type `application/x-rbox-pack` → else 400 bad_request.
4. Body: `readBytesCapped(req, PACK_MAX_BODY_BYTES)`; null → 400 (too large).
   Exactly-8MiB body must be accepted (add boundary test).
5. `sha256Hex(body)` must equal declared pack sha → 400
   `{ error: "pack_sha_mismatch" }` (R2 also verifies on PUT — both layers).
6. `parsePack` strict → 400 `{ error: "bad_pack", reason: <enum> }`. Verify
   the claimed directorySha256 against `sha256Hex(directory)`.
7. Hash EVERY extent (`sha256Hex`) before any durable write; any mismatch →
   400 `{ error: "member_sha_mismatch" }` — whole request fails, no receipts,
   no D1/R2 garbage.
8. Aggregate entitlement-aware quota precheck (fail-fast only; redemption's
   cap-guard stays authoritative): add
   `wouldExceedCapAggregate(env, accountId, members: {sha,size}[])` to
   `billing.ts` reusing `account()`/`planFor` + `entitledSubset` — sum sizes
   of non-entitled members; over → `402 { error: "quota_exceeded", used, cap }`.
9. Inventory (before R2 write). Read `packs` row for packId:
   - No row: one `db.batch`:
     `INSERT OR IGNORE INTO packs (pack_id, pack_sha256, size_bytes,
     member_count, state, created_at, touched_at) VALUES (?,?,?,?,
     'uploading',?,?)` + member inserts, each row as
     `INSERT OR IGNORE INTO pack_members (pack_id, sha256, offset, length)
     SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM packs WHERE pack_id=? AND
     pack_sha256=?)` (6 params/row → ≤16 rows/statement; the EXISTS guard
     means a same-id/different-hash race can NEVER interleave foreign member
     rows into the winner's inventory). Then re-read the packs row.
   - Row exists (or after the insert+re-read):
     - `pack_sha256` differs → `409 { error: "pack_conflict" }`.
     - `state='swept'` → tombstone: fail closed `503 { error: "retry_later" }`
       (client retries members under a FRESH packId; no R2 write).
     - `state='ready'` same checksum → READY-VERIFY branch (step 13).
     - `state='uploading'` → heartbeat: `UPDATE packs SET touched_at=? WHERE
       pack_id=? AND state='uploading' AND pack_sha256=?`; `changes===1`
       required, else `503 retry_later` and NO R2 write (lost a sweeper race).
10. One verified R2 PUT: `env.rbox_dev_blobs.put(packKey(id), body,
    { sha256: packSha })` wrapped in `op.span.r2`. Failure → `500
    { error: "pack_r2_error" }` (no receipts; the uploading row is an
    inventoried orphan for the sweeper). NEVER issue per-member R2 writes.
    NEVER delete the shared R2 key on any failure path (round-4 BLOCKER: a
    losing same-id handler must not destroy the winner's published bytes).
11. Fence read: capture `checkTime = Date.now()` BEFORE the read (mirrors
    `mintFenceCheckedReceipts`). One `db.batch` of two SELECTs: (a) any
    `gc_candidates` row with `deleting_at IS NOT NULL` for any member sha
    (json_each IN-list like `mintFenceCheckedReceipts`; ≤2048 shas in one
    JSON bind is fine — same idiom); (b) ANY `pack_gc_candidates` row for
    packId — marked OR opened (§7.3 property 1). Any hit or any query error →
    `503 { error: "retry_later" }`, no receipts.
12. Ready transition: `UPDATE packs SET state='ready', touched_at=? WHERE
    pack_id=? AND state='uploading' AND pack_sha256=?`; `changes===1`
    required else `503 retry_later`.
13. READY-VERIFY branch (same-id retry, row already 'ready', same checksum):
    `head(packKey)` must exist with size === body length (else `503
    retry_later`); then step 11's fence read (fresh checkTime); then mint —
    NO state transition (round-3 fix: crash between ready and response is
    recoverable).
14. Mint one receipt per directory entry, IN DIRECTORY ORDER:
    `mintReceipt(env, { accountId, encSha: e.sha256, size: e.length,
    nowMs: checkTime, packId })`. Response `200 { packId, packSha256,
    results: [{ sha256, ok: true, sizeBytes, receipt }] }`. There is no
    partial-success contract — any earlier failure returned an error status.

### 2b. Uploading-orphan sweeper + tombstone re-sweep (same file)

`sweepUploadingPacks(env, nowMs = Date.now())` — gated by callers on
`packGcEnabled`. Page-capped (e.g. 50 rows):

- SELECT pack_id FROM packs WHERE state='uploading' AND created_at < ? AND
  touched_at < ? (both bounds `nowMs - PACK_ORPHAN_GRACE_MS`) LIMIT 50.
- Per pack, ONE `db.batch` (round-4 single shape; destructive predicates
  EMBEDDED, a JS pre-select is not the guard):
  1. `DELETE FROM pack_members WHERE pack_id=? AND EXISTS (SELECT 1 FROM
     packs p WHERE p.pack_id = pack_members.pack_id AND p.state='uploading'
     AND p.created_at < ? AND p.touched_at < ?)`
  2. `UPDATE packs SET state='swept' WHERE pack_id=? AND state='uploading'
     AND created_at < ? AND touched_at < ?`
  R2 `delete(packKey)` runs ONLY if the UPDATE reports `changes === 1`.
- Tombstone re-sweep: keyset cursor over `packs WHERE state='swept'` (cursor
  in `gc_state` key `pack_tombstone_cursor`, page ≤100): `head(packKey)`;
  if present → `delete` + metric `pack.gc.resweep_deleted` (count). Tombstones
  are PERMANENT — never delete a `swept` row.
- Metrics: swept count, tombstone count observed, re-deletes.

### 2c. Wiring

- Route: in `apps/api/src/routes/blob-batch.ts` add
  `POST /v1/blob-pack/put` → `blobPackPut(req, env, p.accountId)` (authed
  group — bearer required; a grant-only request never reaches it).
- `worker.ts`: add `"blob-pack"` to ROUTE_VOCAB; add `seg[1] === "blob-pack"`
  to `apiKeyAllowed`'s blobs clause; in `scheduled()` regular-maintenance
  ticks add an own-try `if (packGcEnabled(env)) await sweepUploadingPacks(env)`.

### 2d. Tests `apps/api/test/blob-pack-put.test.ts`

Use the SELF.fetch + bootstrap pattern from `blob-batch.test.ts`. Build packs
with the shared codec + node:crypto. Cover:

- 401 with no bearer; 401 with ONLY `x-rbox-upload-grant` (mint a real upload
  grant via `grants.ts` helpers — grant-only pack PUT must be rejected).
- `RBOX_BLOB_PACK_ACCEPT` off (direct handler call with overridden env) →
  404 pack_disabled.
- Happy path: N members → 200, receipts in directory order; R2 object exists
  at `packs/v1/<id>`; NO canonical `blobKey` objects were written; each
  receipt verifies as v2 with the packId; `packs` row ready; `pack_members`
  rows match the directory.
- Cross-implementation golden: bytes built by the client codec parse in the
  Worker to identical directory entries and each extracted extent re-hashes
  to its encSha (this is inherent — assert it explicitly once).
- member sha mismatch → 400, NO packs/pack_members rows, no R2 object.
- whole-pack sha mismatch → 400.
- structural rejects (sample a few enums), body > 8 MiB → 400, exact 8 MiB
  accepted (members sized to hit the boundary).
- quota: over-cap non-entitled aggregate → 402; already-entitled members cost
  zero (entitle them first via canonical upload + redeem, then verify a pack
  of the same shas passes the precheck).
- Idempotent same-id/same-checksum retry (uploading state): second call → 200
  with FRESH receipts; still exactly one ready row.
- Same-id retry when already 'ready' → ready-verify branch: 200 fresh
  receipts, no transition, R2 intact.
- Same-id different-checksum → 409, and the winner's pack_members are
  UNCHANGED (no foreign rows).
- Fence: open logical intent (`gc_candidates` deleting_at NOT NULL) on one
  member → 503 retry_later, no receipts, packs row left 'uploading'
  (safe orphan). Any `pack_gc_candidates` row (marked-only, deleting_at NULL)
  → 503 (property 1: marked OR opened).
- Tombstone: set state='swept' → same-id retry → 503, NO R2 write (assert
  object absent).
- Heartbeat/sweeper race: heartbeat UPDATE with changes=0 → 503.
- Sweeper: uploading row younger than grace → untouched; older on BOTH
  created_at+touched_at → members deleted, state='swept', R2 object deleted;
  fresh heartbeat (touched_at now) → NOT swept. Tombstone re-sweep: put an
  object back at a swept id → re-HEAD pass deletes it.
- RELEASE-BLOCKING same-id concurrent PUT: dispatch two concurrent
  `blobPackPut` calls (direct handler, same env) with the same id+checksum;
  assert: at most one 200 (or both 200 via ready-verify), the R2 object
  survives and serves the winner's bytes, exactly one ready inventory, and
  NEITHER handler deleted the shared key.

---

## Dispatch 3 — read path + blobsCheck + redemption/accounting placement

### 3a. Placement resolution helpers (`apps/api/src/blob-pack.ts`)

- `packedLocation(db, sha): Promise<{pack_id, offset, length} | null>` —
  single-row read of `blob_locations`.
- `packedLocations(db, shas): Promise<Map<sha, {pack_id, offset, length}>>` —
  `batchedInLookup` over `blob_locations`.
- `readPackedExtent(op, env, sha, loc): Promise<Uint8Array | null>` —
  `op.span.r2(() => env.rbox_dev_blobs.get(packKey(loc.pack_id), { range:
  { offset: loc.offset, length: loc.length } }))`; require object present,
  byteLength === length, AND `sha256Hex(bytes) === sha` (round-1 MAJOR b: an
  equal-length corrupted offset must NEVER serve wrong bytes with 200). On any
  failure: `logErr("pack_extent_error", ...)` + metric op outcome
  `pack_extent_error` (this is the paged index-corruption signal) and return
  null. Callers MUST treat null as not_found — NEVER fall through to the
  canonical key (could mask a torn location transition).

### 3b. Single GET (`apps/api/src/blobs.ts`)

`blobGet` and `blobGetWithVerifiedGrant`: AFTER the existing authorization
(grant verify / isEntitled — order unchanged, authorization always before
placement or R2), look up `packedLocation(dbFor(env, accountId), sha)`.
Row → packed read path (404 on null extent); no row → existing canonical
`R2.get(blobKey(sha))` unchanged. Note: this adds one D1 read to the
grant-preauth path — accepted by design §6 explicitly.

### 3c. Batch GET (`apps/api/src/blob-batch.ts`)

In `streamBatch`/`authenticatedResults`/grant path: after the entitlement
filter, resolve ALL authorized shas in one placement query
(`packedLocations`). Split into canonical (existing `fetchObject` fan-out,
unchanged) and packed groups by pack_id. Two independent budgets (design §6):

- existing 8 MiB RESPONSE cap on emitted frame payloads — unchanged;
- an 8 MiB FETCH-BYTE budget counting every fetched byte at full
  covering-range size across ALL packs and canonical objects in the request
  (canonical objects count their size).

Per pack: sort requested extents by offset; the smallest covering range is
`[minOffset, maxEnd)`. If `fetchBytes + coveringBytes ≤ 8 MiB` → ONE ranged
R2 GET for the covering range, slice each member out; else → exact per-extent
ranges (no gap bytes). Every sliced/fetched extent is verified (length +
SHA-256) exactly like 3a; a failed member becomes a status frame
`{ status: "error", code: "pack" }` — never a canonical fallback. Response
order stays completion order; frame semantics `(sha, payload|status)`
unchanged; old clients see no wire difference.

Keep the pre-buffering shape (bounded by the two 8 MiB budgets) — do NOT
serialize bodies through the stream one at a time (see the d76 comment).

### 3d. `/v1/blobs/check` usable-location clause (`blobs.ts`)

Both branches (receipts + legacy) additionally exclude a sha whose
`blob_locations` row points at a pack under ACTIVE pack deletion:
`AND NOT EXISTS (SELECT 1 FROM blob_locations l JOIN pack_gc_candidates pg
ON pg.pack_id = l.pack_id AND pg.deleting_at IS NOT NULL WHERE l.sha256 =
r.sha256)` (adapt alias for the legacy branch). Visible contract identical —
old clients just see `missing`. Defense-in-depth, not load-bearing (§4).

### 3e. Redemption installs placement (`commit-accounting.ts`,
`workspace-sync.ts`)

- `RefWithSize` gains optional
  `pack?: { packId: string; offset: number; length: number;
  packSha256: string }`.
- New helper `resolvePackPlacements(db, wanted: Array<{sha, packId}>):
  Promise<Map<sha, pack-placement>>` (put it in `blob-pack.ts`): group by
  packId, `SELECT m.sha256, m.offset, m.length, p.pack_sha256 FROM
  pack_members m JOIN packs p ON p.pack_id = m.pack_id WHERE m.pack_id = ?
  AND p.state='ready' AND m.sha256 IN (...)` chunked ≤80 shas, batched.
  The receipt itself NEVER carries offsets — placement is derived from the
  immutable inventory (round-1 MAJOR c).
- `validateCommitRefs`: skip-if-entitled `have` check UNCHANGED and FIRST
  (skipped receipts install no placement change — §4). For verified v2
  receipts (`v.packId`), batch-resolve placements; unresolved (pack missing /
  not ready / member absent) → that sha goes to `needsUpload`. Resolved →
  `newRefs` entry carries `pack`.
- `redeemReceipts` (workspace-sync.ts): same resolution after the verify
  loop; an unresolved v2 receipt counts as `rejected` (no grant, no install).
- `commitAccounting`: inside each ACCOUNTING_INSERT_CHUNK's statement group,
  append:
  - for chunk refs WITH `pack`: multi-row
    `INSERT INTO blob_locations (sha256, storage, pack_id, offset, length,
    pack_sha256, installed_at) VALUES (?,?,?,?,?,?,?)... ON CONFLICT(sha256)
    DO UPDATE SET pack_id=excluded.pack_id, offset=excluded.offset,
    length=excluded.length, pack_sha256=excluded.pack_sha256,
    installed_at=excluded.installed_at` — sub-chunk ≤13 rows (7 params/row).
    storage literal 'pack'.
  - for chunk refs WITHOUT `pack` (v1/canonical): `DELETE FROM blob_locations
    WHERE sha256 IN (<v1 shas>)` (selects canonical; the §5 displacement
    trigger handles former-pack candidacy atomically — no JS pre-read).
  All inside the SAME `db.batch` as catalog/charge/grant/un-condemn — the
  existing `isDeleteFenceAbort` catch already converts a
  `rbox_delete_fence_pack` abort into the whole-super-batch 422 `needsUpload`.
  Do not shrink the failure unit.

### 3f. Tests

`apps/api/test/blob-pack-read.test.ts`:
- Packed single GET (bearer path + download-grant path) returns
  byte-identical ciphertext; canonical GET unchanged; mixed batch GET
  (packed from 2 different packs + canonical + missing) → correct frames,
  entitlement checked before placement (unentitled packed sha → missing
  status, and NO R2 range read happens — assert via response only).
- Range boundaries: first member (offset=16), last member (ends at
  directoryOffset), single-member pack.
- Batch GET where the covering range would exceed the fetch budget → exact
  ranges still return correct bytes (construct via many small members spread
  across a large pack — or directly unit-test the coalescing planner if you
  extract it as a pure function; PREFER extracting a pure
  `planPackReads(extents, budgets)` and unit-testing it).
- Corrupted index: craft a pack with two equal-length members; UPDATE
  pack_members AND blob_locations to swap the two offsets for one sha
  (bypasses the inventory guard consistently); single GET → 404 (not wrong
  bytes); batch GET → error status frame; assert no canonical fallback
  happened (canonical object for that sha deliberately planted with WRONG
  bytes must NOT be served).
- Torn/missing pack object (delete the R2 object under a live location) →
  404 / error frame, never canonical fallback.
- `/v1/blobs/check`: same logical D1 state canonical vs packed → identical
  responses; packed sha with `pack_gc_candidates.deleting_at` set → missing;
  marked-only (deleting_at NULL) → NOT missing.

`apps/api/test/receipts-flow.test.ts` (extend) or new
`blob-pack-redeem.test.ts`:
- Full flow: pack PUT → redeem v2 receipts via the dedicated endpoint →
  blob_locations installed with pack_members-derived extent; GET serves from
  pack; re-redeem charges zero and keeps one location; commit referencing the
  shas succeeds.
- Commit-fallback path: pack PUT → commit with receipts in the body (no
  pre-redeem) → placement installed.
- skip-if-entitled: entitle sha canonically first; redeem a v2 receipt for it
  → alreadyEntitled, NO blob_locations row appears (asserted directly).
- v1-after-v2 displacement: packed sha, then canonical re-upload + v1 receipt
  redeem → blob_locations row DELETED, and (if it was the pack's last
  location) an UNOPENED pack_gc_candidates row appeared via the trigger.
- v2 A→B relocation: same sha in two packs; redeem pack A then pack B → one
  location pointing at B; pack A candidacy appears when it was A's last.
- Mixed v1/v2 super-batch tripping `rbox_delete_fence_pack` (open a pack
  intent, then redeem a v2 receipt into that pack) → 422 needsUpload for the
  WHOLE super-batch; also unit-assert
  `isDeleteFenceAbort(new Error("...rbox_delete_fence_pack..."))`.
- Unresolved placement (receipt for a pack whose row was swept) → rejected /
  needsUpload, no phantom location.
- Design-111 interplay: worst-case v2 entry size respects the 7 MiB slicer
  (client-side constant test exists in Dispatch 1d; here just ensure redeem
  endpoint handles a 2048-entry v2 batch).

---

## Dispatch 4 — physical pack GC executor (the release-gate fence work)

READ design §7.3 and REVIEW-114 rounds 3–5 + confirmation COMPLETELY first.
The four historical BLOCKERs live here; do not reintroduce them:
1. `deleting_at` MUST be stamped from a LIVE clock read taken AFTER observing
   the candidate row (never the invocation-start nowMs).
2. Every opening/destructive statement binds the observed candidacy `epoch`
   (a stale statement against a replaced candidacy must be a changes=0 no-op).
3. The deletion proof is case-complete; the code expression of it is: mark
   only under embedded zero-location predicates, execute only after epoch
   quiescence, terminal transition is ONE guarded atomic db.batch ending in a
   durable 'swept' tombstone.
4. The trigger message is `rbox_delete_fence_pack` (already done in 0025).

### 4a. Lease reuse (`apps/api/src/versions.ts`)

Parameterize the private lease helpers (`acquireLease`, `renewLease`,
`releaseLease`, `releaseLeaseWithRetry`, `leaseGuard`) over the gc_state key
(default `'purge_lease'` — existing behavior byte-identical) and export them
for pack GC, which uses key `'pack_purge_lease'`. Keep `PURGE_LEASE_TTL_MS`
etc. shared. Touch nothing else in versions.ts.

### 4b. `apps/api/src/pack-gc.ts` (NEW)

Constants:
- `PACK_INTENT_QUIESCENCE_MS = 24 * 3600_000`;
- compile assert + unit test:
  `PACK_INTENT_QUIESCENCE_MS >= RECEIPT_TTL_MS + CLOCK_SKEW_MS` (import from
  receipts.ts). Compile-level: `const _q: true = (PACK_INTENT_QUIESCENCE_MS
  >= RECEIPT_TTL_MS + CLOCK_SKEW_MS) as true;` won't typecheck on numbers —
  instead do a module-load throw + a unit test asserting the relation.
- `PACK_GC_CLOCK_STALENESS_MS = 3600_000` (defense-in-depth open-skip guard,
  NOT proof-bearing).
- Page caps ~50 rows/pass.

`runPackGc(env, opts: { nowMs?, clock?, owner?, deadlineMs? })` — mirrors
`gcPurge`'s shape (own metrics op `gc.pack`): scope is `packs.state='ready'`
ONLY (uploading remnants belong to the Dispatch-2 sweeper; swept is terminal).
Acquire the `pack_purge_lease`; under it run four passes; always release with
retry. All keyset cursors persist in `gc_state`
(`pack_mark_cursor`/`pack_intent_cursor`/`pack_execute_cursor`).

1. RESURRECT: page unopened candidates (`deleting_at IS NULL`); for those
   whose pack has active locations →
   `DELETE FROM pack_gc_candidates WHERE pack_id=? AND epoch=? AND
   deleting_at IS NULL AND EXISTS (SELECT 1 FROM blob_locations l WHERE
   l.pack_id = pack_gc_candidates.pack_id)` (epoch-bound).
2. MARK: page `packs` `state='ready' AND created_at < nowMs -
   PACK_ORPHAN_GRACE_MS` (13 h — the mark grace, design §7.3) by
   `(created_at, pack_id)` keyset;
   `INSERT OR IGNORE INTO pack_gc_candidates (pack_id, epoch, marked_at)
   SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM blob_locations WHERE
   pack_id = ?) AND EXISTS (SELECT 1 FROM packs WHERE pack_id=? AND
   state='ready')` — zero-location predicate EMBEDDED in the INSERT; epoch =
   `crypto.randomUUID().replace(/-/g,'')` or 32-hex random; marked_at =
   invocation nowMs (fine — property 1 anchors on database order, not this
   value).
3. OPEN INTENT: page candidates `deleting_at IS NULL AND marked_at <
   nowMs - PACK_ORPHAN_GRACE_MS`... (use marked_at < nowMs — grace already
   ran pre-mark; open after observing the row). For each observed
   `(pack_id, epoch)` row: read `liveNow = clock()` AFTER the select; skip
   the whole pass if `clock() - nowMs > PACK_GC_CLOCK_STALENESS_MS`
   (defense-in-depth); then
   `UPDATE pack_gc_candidates SET deleting_at=? WHERE pack_id=? AND epoch=?
   AND deleting_at IS NULL AND NOT EXISTS (SELECT 1 FROM blob_locations
   WHERE pack_id = pack_gc_candidates.pack_id)` binding `liveNow` — the
   POST-READ live clock stamp (round-4 BLOCKER fix: gives
   `deleting_at > T_mark` directly).
4. EXECUTE: page candidates `deleting_at IS NOT NULL AND deleting_at <
   clock() - PACK_INTENT_QUIESCENCE_MS` (an invocation-start execute clock
   only DELAYS eligibility — the safe direction; using clock() is fine).
   Per candidate `(pack_id, epoch, deleting_at)`, under live lease +
   deadline checks (mirror `executePage`'s no-await-between-check-and-
   dispatch discipline):
   - readiness SELECT: candidate still open with this epoch, zero
     `blob_locations`, live lease → else skip/continue (never unwind on lease
     loss).
   - R2 `delete(packKey)`; `head(packKey)`; if still present → leave the
     intent for retry (never guess success), continue.
   - TERMINAL one `db.batch` (round-5: one guarded atomic transition; each
     statement embeds zero-location + live-lease + epoch/state guards):
     1. `DELETE FROM pack_members WHERE pack_id=? AND NOT EXISTS (SELECT 1
        FROM blob_locations l WHERE l.pack_id = pack_members.pack_id) AND
        EXISTS (SELECT 1 FROM pack_gc_candidates c WHERE c.pack_id=? AND
        c.epoch=? AND c.deleting_at IS NOT NULL) AND ${leaseGuard}`
     2. `UPDATE packs SET state='swept' WHERE pack_id=? AND state='ready'
        AND NOT EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id =
        packs.pack_id) AND EXISTS (SELECT 1 FROM pack_gc_candidates c WHERE
        c.pack_id=? AND c.epoch=? AND c.deleting_at IS NOT NULL) AND
        ${leaseGuard}`
     3. `DELETE FROM pack_gc_candidates WHERE pack_id=? AND epoch=? AND
        deleting_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM blob_locations
        WHERE pack_id=?) AND ${leaseGuard}`
     Count purged only when statement 2 reports changes=1. A crash before
     the batch leaves candidacy+fence intact for retry; the batch itself is
     atomic — no crash point leaves the object deleted with the fence
     retired but the tombstone absent.
   Metrics (§9): packs marked/opened/deleted/unwound, pinned pack count +
   aggregate pinned bytes (one COUNT/SUM query over packs ready with
   locations), swept tombstone count, reappeared re-deletes (from the
   Dispatch-2 sweeper), all numeric only.

### 4c. Wiring + admin surface

- `worker.ts` `scheduled()` GC_PURGE hour: after `gcPurge`, own-try
  `if (packGcEnabled(env)) await runPackGc(env)`.
- `routes/admin.ts` (platform secret via `isPlatform`, exactly like the
  existing GC block):
  - `POST /v1/admin/gc?phase=packs` → `runPackGc(env, { deadlineMs:
    ADMIN_PURGE_DEADLINE_MS })` — still requires `packGcEnabled(env)`, else
    `409 { error: "pack_gc_disabled" }` (the flag is the FIRST thing disabled
    on a fence anomaly; the admin path must not bypass it).
  - `GET /v1/admin/gc/pack-tombstones` → non-destructive audit list
    `{ tombstones: [{ packId, createdAt, touchedAt }], count }` (page-capped;
    packId exposure to the PLATFORM ADMIN surface only is acceptable — it is
    an authenticated internal ops route, mirroring multipart-inventory).
  - `POST /v1/admin/gc/pack-tombstones/resweep` → forced re-HEAD/re-delete
    pass over tombstones (calls the Dispatch-2 re-sweep helper; requires
    packGcEnabled). NO destructive tombstone admin surface exists (round-5:
    tombstones are permanent deny records).

### 4d. Fence property tests `apps/api/test/pack-gc.test.ts`
(THE RELEASE GATE — every named property is an explicit test)

Test IDs in comments referencing design gate numbers. Use direct handler
calls with injected `clock`/`nowMs` (see `gc-purge.test.ts` for the
patterns). Cover at minimum:

- **P1 mint-fence-any-candidacy**: marked-only candidacy (deleting_at NULL)
  blocks pack PUT receipt minting (503) — same-id retry included; after
  RESURRECT removes the candidacy, the same retry mints (per-epoch
  restatement, round 2).
- **P1 issuedAt anchoring**: receipts minted with `nowMs = checkTime`
  captured before the fence read — assert the signed `t` of every minted
  receipt ≤ the wall time the subsequent mark landed (drive: mint, then
  mark, compare receipt payload t < marked_at).
- **P2/gate-5 install fence**: with an OPEN intent (deleting_at set), a
  blob_locations install (redeem path) aborts via the trigger → caught as
  422 needsUpload; a pre-intent install makes the open UPDATE a no-op
  (zero-location predicate false).
- **Epoch guard (round-5 BLOCKER history)**: create candidacy C1 (epoch e1);
  resurrect (delete) it; displacement re-creates C2 (epoch e2); execute a
  stale open UPDATE bound to e1 → changes=0, C2 unopened; stale terminal
  DELETE bound to e1 → changes=0, C2 intact.
- **P3 quiescence**: unit-assert `PACK_INTENT_QUIESCENCE_MS >=
  RECEIPT_TTL_MS + CLOCK_SKEW_MS`; execute pass skips a candidate whose
  deleting_at is younger than quiescence; post-read stamp: with an injected
  clock that advances between invocation start and the open pass, assert
  `deleting_at > marked_at` (over-deadline-await history, round 4).
- **Gate 5b resurrect history**: pre-mark install → resurrect → retry-mint
  succeeds → last-location delete (trigger re-marks with NEW epoch) → fresh
  mark/open → delete only after quiescence restarted from the NEW intent.
- **Gate 7 pinning**: one live location pins the pack — mark INSERT is a
  no-op; after the last location retires (via 7.2 below) the pack becomes
  markable/deletable.
- **§7.2 logical Phase 2 on a packed candidate**: extend/verify via
  `gc-purge`-style flow — a packed sha with zero refs + open logical intent:
  the location DELETE embeds zero-ref/open-intent/lease predicates in ONE
  db.batch with the blobs/gc_candidates cleanup (mirror `cleanupCandidate`);
  the R2 PACK OBJECT IS NOT TOUCHED; the displacement trigger inserted the
  unopened pack candidacy. A resurrected candidate (refs regained) leaves
  the location intact. NOTE: this requires extending
  `versions.ts::executePage/cleanupCandidate` to handle candidates whose
  sha has a packed location: for those, the R2 delete/HEAD steps are
  SKIPPED and the cleanup batch additionally deletes the
  `blob_locations` row under the same embedded guards
  (zero-refs + open intent + live lease). Implement that in this dispatch;
  keep the canonical path byte-identical.
- **Gate 8 lease/kill safety**: lease expiry mid-execute → no fence cleared
  (candidate remains); R2-delete-failure / HEAD-still-present → intent
  survives for retry; re-run converges without double-count.
- **Scope (round 4)**: an 'uploading' pack is never marked/opened/executed
  by runPackGc even with zero locations; a 'swept' pack is only re-HEAD-swept.
- **Terminal atomicity**: after a successful execute, assert
  packs.state='swept', pack_members empty, candidate gone; simulate the
  crash-before-batch point (skip the batch) → candidacy + fence intact.
- **Gates 1/6 via flow**: an entitled+present packed blob always resolves
  (check + GET) while any of this runs with pack GC disabled/enabled — a
  small randomized-history smoke: N shas through pack publish / redeem /
  logical retire / re-add / pack GC ticks with injected clocks, asserting
  after every step: every entitled+present sha resolves to correct bytes,
  and no pack object is deleted while a location points at it (assert via
  HEAD after each runPackGc call).

Also extend `worker.test.ts` routeTemplate expectations if it enumerates
vocab (check first).

---

## Dispatch 5 — client pack writer behind RBOX_BLOB_PACK (default OFF)

### 5a. `src/cli/remote/blob-batch/gate.ts`

- Add pack-only process latch: `packUploadDisabled()`,
  `disablePackUploadForProcess()` — MUST be distinct from
  `disableUploadForProcess()` (round-1 MAJOR d: reusing it would collapse the
  batch lane). Reset in `resetBatchBlobStateForTests`.
- Add `export class UploadSlotArbiter`: `constructor(readonly limit:
  number)`; `tryAcquire(): boolean`; `release(): void`; `get inFlight():
  number`; `registerPump(fn: () => void): void` — release() first decrements,
  then invokes registered pumps (queueMicrotask) so BOTH lanes re-dispatch.
  SINGLE definition site here per design §3.

### 5b. `src/cli/remote/blob-batch/config.ts`

- `export function packUploadEnabled(): boolean` →
  `process.env.RBOX_BLOB_PACK === "1"` (default OFF — this flag does NOT
  follow ship-live; independent of RBOX_BATCH_BLOBS).
- Pack fill constants: `PACK_FILL_QUIET_MS = 200`,
  `PACK_FILL_ABSOLUTE_MS = 1000` (compiled; size/count HARD CAPS come from
  `src/engine/blob-pack.ts`).
- FOUNDER DIRECTIVE (workload-agnostic knobs — same env conventions as
  RBOX_UPLOAD_SLOTS, via `envInt` with clamps; compiled defaults, hard caps
  stay compiled):
  - `export interface PackConfig { enabled; streams; cutoffBytes;
    targetPayloadBytes; minActivationCount; minActivationBytes }` +
    `export function packUploadConfig(): PackConfig`:
    - `streams`: `RBOX_PACK_STREAMS`, default **4**, clamp [1, 64] — the max
      concurrent pack PUTs. NOT a separate pool: the pack lane still draws
      every permit from the shared UploadSlotArbiter (design §3: no
      independent pack-slot pool); `streams` only CAPS the pack lane's share
      of that budget (small-uplink users saturate at 2-3; big-pipe users
      raise it).
    - `cutoffBytes` (which blobs pack): `RBOX_PACK_CUTOFF_BYTES`, default
      `PACK_MAX_MEMBER_BYTES` (256 KiB), clamp [1, PACK_MAX_MEMBER_BYTES].
    - `targetPayloadBytes`: `RBOX_PACK_TARGET_BYTES`, default
      `PACK_TARGET_PAYLOAD_BYTES`, clamp [64*1024,
      PACK_TARGET_PAYLOAD_BYTES] (8 MiB body cap and 2048-member cap are
      hard, compiled, non-overridable).
    - `minActivationCount`/`minActivationBytes`: `RBOX_PACK_MIN_BLOBS` /
      `RBOX_PACK_MIN_BYTES`, defaults 16 / 1 MiB, clamps [1, 2048] /
      [1, 8 MiB].
  The pack lane must behave sanely across corpus complexions (all-small,
  all-large, mixed) — the router (canBatch + cutoff + activation fallback)
  handles this; tests pin it per shape (5g).

### 5c. `src/cli/remote/blob-batch/packer.ts` (NEW)

Pure-ish pack builder: given ordered members `{sha, size, srcPath}`, build a
pack into a TEMP FILE (never slots×8 MiB in heap — design §3): write header,
append each member file's bytes (verifying byte count against size), then
directory + footer; compute the whole-pack SHA-256 incrementally while
writing (node:crypto). Temp file goes in the first member's `uploadsDir` when
provided (the run temp dir) else `os.tmpdir()`, name prefixed `pack-`.
Returns `{ path, packSha256, entries, totalBytes }`. Caller deletes the temp
file after all member promises settle (or on abort). Enforce: members each
1..256 KiB, count ≤2048, encoded total ≤ 8 MiB (the builder must stop early —
the CARVER guarantees this, builder asserts).

### 5d. `src/cli/remote/blob-batch/pack-uploader.ts` (NEW)

`BlobPackUploader` — owns pack carving/scheduling. Constructor:
`(ctx: RemoteContext, arbiter: UploadSlotArbiter, fallback: (sha: string,
waiter: BatchPutWaiter) => void)` where fallback re-enqueues into the batch
lane (BlobBatchUploader exposes an internal `requeueFromPack` that calls its
private `enqueue` — export the `BatchPutWaiter` interface from uploader.ts).

Behavior:
- `putFile(sha, srcPath, size, uploadsDir?, onBytes?): Promise<void>` —
  coalesce duplicate shas exactly like the batch lane (waiters array).
- ACTIVATION (design §2 size policy): members accumulate until the pending
  set reaches ≥16 blobs OR ≥1 MiB ciphertext for this process ("publish"
  approximated as process — acceptable, flag is default-off); once activated,
  stays activated; tail packs may be smaller. If the quiet timer fires
  BEFORE activation, hand ALL pending members to `fallback` (they settle via
  the batch lane — a small publish must never hang).
- CARVE: when pending payload ≥ PACK_TARGET_PAYLOAD_BYTES (7.5 MiB) and a
  permit is available (`arbiter.tryAcquire()`), carve members (FIFO) whose
  payload+overhead stays ≤ 8 MiB body and count ≤2048, targeting 7.5 MiB
  payload, and dispatch. Timers: quiet PACK_FILL_QUIET_MS since last unique
  enqueue / absolute PACK_FILL_ABSOLUTE_MS since oldest pending → dispatch a
  tail pack (if activated) or fall back (if not). Register a pump on the
  arbiter to resume carving when permits free.
- DISPATCH: build via packer (temp file), generate a fresh `packId` (16
  random bytes hex, node:crypto), then POST `${baseUrl}/v1/blob-pack/put`
  with headers `{ ...ctx.protoAuth, "content-type": PACK_CONTENT_TYPE,
  "x-rbox-pack-id": id, "x-rbox-pack-sha256": packSha, "content-length":
  totalBytes }` and a file-stream body (`fileStream` from `../stream.js`) via
  `ctx.fetch` with a size-aware transfer timeout (mirror
  `blobs.ts::putBlobFile`'s timeout sizing). Bearer ALWAYS (protoAuth);
  NEVER attach `x-rbox-upload-grant` (REVIEW-114 seam: grants are not part
  of the pack wire contract). fetchResilient's transport retry MAY re-send
  the same packId (server-side idempotent by design).
- SETTLE (no member settles twice — track a settled flag per group):
  - 200: parse `{ results }`; for each ok record
    `ctx.captureReceipt(sha, { receipt })`, call onBytes(size), resolve
    waiters. Any sha missing from results (shouldn't happen) → fallback.
  - 404/405/415 (including `404 {error:"pack_disabled"}`):
    `disablePackUploadForProcess()`, then requeue THIS pack's members AND all
    other pending members to `fallback` (monotonic latch; batch lane
    unaffected).
  - 503 retry_later: reject every waiter with `BlobRetryLaterError` (mirror
    the batch lane's fence semantics — never immediately re-upload into the
    fence).
  - Any other non-OK / parse failure / thrown transport error after retries:
    requeue this pack's members to `fallback` (no latch — they settle
    canonically).
  - finally: release the permit; delete the temp file after all members of
    the pack settled.
- `close(err)`: reject all pending/in-flight waiters, clear timers, await
  in-flight settles, delete temp files (kill/resume: resume converges by
  re-uploading — receipts NOT-EXISTS guard prevents double charge
  server-side).

### 5e. `src/cli/remote/blob-batch/uploader.ts` integration

- Replace the private `active` counter with a shared
  `UploadSlotArbiter(config.slots)` instance (constructor-injectable for
  tests; default self-created). All `this.active < this.config.slots`
  checks become `arbiter.tryAcquire()` at launch / `release()` on settle —
  preserve the existing dispatch semantics EXACTLY (dispatchFull loop,
  idle_tail, fill-v2 re-arm). Register a pump that re-runs dispatchFull +
  fill-v2 re-arm so pack-lane releases wake the batch lane.
- Pack routing in `putFile`: when `packUploadEnabled() &&
  !packUploadDisabled() && this.canBatch(size)` → delegate to a lazily
  created `BlobPackUploader` (shared arbiter, fallback = internal
  `requeueFromPack(sha, waiter)` that enqueues into the batch queue,
  bypassing pack routing). `close()` closes the pack uploader first, then
  proceeds as today. `ownsLaneTiming` unchanged.
- 109 seam: batch-lane dispatch (grant refresh, batchPutAuth, auth timing
  hooks) is UNTOUCHED; the pack lane never calls
  `maybeRefreshUploadGrant()`.

### 5f. `docs/CODEMAP.md`

Add ownership lines under `src/cli/remote/blob-batch/` for `packer.ts` and
`pack-uploader.ts` (what they own / never own, matching house style), and
update `gate.ts` + `uploader.ts` lines (arbiter single-definition-site; pack
routing). Add `src/engine/blob-pack.ts` line under `src/engine/` (locked
format codec, bundles into client + Worker, never hashing).

### 5g. Client tests (bun, `src/cli/remote/blob-batch/pack-upload.test.ts`)

Use fetch stubbing/fake servers in the style of `blob-batch.test.ts` (client
side). Cover:
- Default OFF: without RBOX_BLOB_PACK, putFile never touches the pack lane.
- Activation: 15 small members → quiet timer → all fell back to batch lane
  (no pack request); 16+ members / ≥1 MiB → pack request with correct wire
  headers (bearer present, NO x-rbox-upload-grant header, content-type,
  32-hex id, correct pack sha) and body that `parsePack`s to the members.
- Carving: >7.5 MiB pending → pack ≤8 MiB body, ≥1 pack + tail; member
  >256 KiB never enters the pack lane (routed to batch/multipart as today).
- Receipts: 200 response → every waiter resolved, receipts captured into
  ctx.receipts, onBytes called with sizes.
- Mixed-lane slot cap (design §3 named requirement): arbiter limit N; drive
  concurrent batch PUTs + pack PUTs against a stub that stalls; assert
  combined in-flight requests NEVER exceed N (instrument the stub).
- 404 pack_disabled: latch fires once, this pack's members + pending requeue
  into the batch lane and settle there; batch lane keeps batching (assert
  `uploadDisabled()` is still false); NO member settled twice.
- 405/415 same latch; 503 → BlobRetryLaterError rejections; 500 → fallback
  to batch lane without latch.
- close() mid-pack (kill): waiters rejected with the close error, temp pack
  files removed, in-flight awaited (no dangling promises — #264 hygiene).
- Temp files: after a successful pack, temp file is gone.
- Corpus complexions (FOUNDER DIRECTIVE — one explicit test per shape):
  - all-small (every member ≤ cutoff): everything packs; batch lane sees
    nothing; publish completes.
  - all-large (every blob > cutoff / > 256 KiB): pack lane never engages, no
    timers left hanging, everything settles via the existing batch/single
    lanes.
  - mixed: small members pack, large route to batch/multipart, both lanes
    interleave under the ONE shared slot budget.
- Streams knob: `RBOX_PACK_STREAMS=2` with arbiter limit 24 → never more
  than 2 concurrent pack PUTs even with plenty of shared permits; batch lane
  may still use the rest.
- Knob clamps: cutoff/target/activation env values clamp to the compiled
  hard caps.

Acceptance: `bun test ./src/` green (plus the global commands).

---

## Rollback floor + docs (done by the orchestrating session, not codex)

- `apps/api/src/blob-pack.ts` carries
  `export const PACK_ROLLBACK_FLOOR = "unset — record the Workers version id
  of the first deployed build containing this file (design 114 rollout step
  1); see PR body for the pinned drill";` — a named constant beside the
  reader code per design; the actual version id is recorded at deploy time.
- PR body documents the pinned rollback drill (`cd apps/api && npx wrangler
  versions list` / `npx wrangler versions deploy <floor-id>@100%`, assert
  packed reads + v2 redemption + check unchanged, restore) — NOT executed.
