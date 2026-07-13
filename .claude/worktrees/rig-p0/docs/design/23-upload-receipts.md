# §23 — Upload receipts + commit-time batched accounting (P0)

> Status: **design** (pre-codex-review). Basis: [`22-server-throughput.md`](22-server-throughput.md).
> **The single biggest server-side throughput win.** Decomposed into independently
> shippable chunks (`23-upload-receipts/`).

## Problem (one paragraph)
Every blob `PUT` does ~5 D1 round-trips; a 1041-blob push ≈ ~5,200 D1 round-trips and D1
is single-threaded per DB — the measured plateau (conc≥32 flat, conc=4 threw "connection
lost"). Root cause (Dropbox Magic Pocket / FileJournal): **the content server mutates
metadata on every PUT.** Fix: R2 = dumb content store; sequencing+accounting move to a
batched step at commit (the metadata journal).

## Boundary
This design follows the [Dropbox Magic Pocket](https://dropbox.tech/infrastructure/inside-the-magic-pocket)
/ [streaming sync](https://dropbox.tech/infrastructure/streaming-file-synchronization),
[Git objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects), and
[Syncthing BEP](https://docs.syncthing.net/specs/bep-v1.html) split, adapted to rbox's
M7 no-oracle rules:
- **R2 is immutable content**: hash-verified ciphertext bytes keyed by `encSha`, following
  the same content-identity discipline as [Dropbox content hash](https://www.dropbox.com/developers/reference/content-hash).
  `PUT` writes bytes and returns a short-lived receipt; it does not grant entitlement,
  charge quota, advance heads, clear GC candidates, or write canonical metadata.
- **DO/D1 are the metadata journal**: workspace sequencing, entitlement (`blob_refs`),
  blob catalog rows, quota accounting, and GC condemnation are mutated only at commit or
  by the platform GC/reconciliation job.
- **Blob existence is account-scoped**: `missingBlobs` never reports global R2 presence
  for an unentitled account. If the caller is not already entitled, the response is
  "missing" unless the client already holds a valid upload receipt from its own PUT.

## Target
- `PUT` → auth + R2 sha-verified put + return an **upload receipt**. **Zero D1 on the hot path.**
- **Commit** validates refs (entitled OR valid receipt) and does **one batched D1 transaction**.
- Per-blob D1: ~5 → 0 on PUT; per-commit D1: O(blobs) → O(chunks). Bench target: lift the
  conc-32 plateau on `scripts/bench/push-sweep.ts`.

## Chunks (implement / review in order)
| # | Chunk | What | Depends |
|---|-------|------|---------|
| 23.1 | [Receipt primitive](23-upload-receipts/1-receipt-primitive.md) | HMAC mint/verify, rotation, TTL | — |
| 23.2 | [PUT → R2-only](23-upload-receipts/2-put-r2-only.md) | drop per-PUT D1; return receipt; legacy fallback | 23.1 |
| 23.3 | [missingBlobs + receipts](23-upload-receipts/3-missingblobs-receipts.md) | no-oracle check; client-held receipts; advisory quota | 23.1 |
| 23.4 | [Commit grant batch](23-upload-receipts/4-commit-grant-batch.md) | validate + one D1 `batch()` + quota gate | 23.1–23.3 |
| 23.5 | [Quota + orphan GC](23-upload-receipts/5-quota-and-orphan-gc.md) | commit-time charge; RECEIPT_TTL < GC grace; reclaim | 23.4 |
| 23.6 | [Accounting concurrency](23-upload-receipts/6-accounting-concurrency.md) | exactly-once charge; D1-RETURNING vs Account DO | 23.4 |

## Key risks (carried in the chunks)
- **23.6 is the load-bearing risk** — exactly-once `used_bytes` under concurrent same-account
  commits. Spike D1 `RETURNING`-in-batch first; fall back to an AccountAccounting DO.
- **Quota moves to commit-time** → orphan R2 bytes; mitigated by `RECEIPT_TTL < GC_GRACE` +
  the reconciliation worker (23.5, backlog #7).
- **No existence oracle stays absolute** → `missingBlobs` must not return a `present`
  bucket for blobs that only exist globally. Unentitled refs are "missing" unless the
  client supplies its own valid receipt.
- **Protocol change** → ship server+client together; keep a legacy per-PUT-grant fallback
  behind a CLI-version flag, deprecate after adoption.

## Review gate
Run this whole §23 (overview + 6 chunks) back through **codex adversarially** before code —
especially §23.4 + §23.6 (the grant transaction + concurrency). Then implement chunk-by-chunk
behind the legacy fallback, deploy dev, and re-bench each step.

---

## Benchmarking this change (against **dev**, not prod)

Validate on the **dev** worker `rbox-dev-api` — real Cloudflare D1/R2/DO, the only place
the latency/contention this change targets actually shows up (local Miniflare has ~0
network latency and would hide it). The dev deploy is a **separate, manual** step —
**do NOT push to `main` to test**: push-to-`main` auto-deploys *prod* (`deploy-api.yml`).

```bash
# on a branch/worktree with the change (server + the client binary if it's a protocol change):
cd apps/api && bunx wrangler deploy                  # → rbox-dev-api (dev only; prod untouched)
bun build --compile --target=bun-darwin-arm64 \      # match your platform; only if the client changed
  ./src/cli/index.ts --outfile /tmp/rbox
bun scripts/bench/push-sweep.ts --bin /tmp/rbox \
  --remote https://rbox-dev-api.brian-via.workers.dev --conc 8,16,32,64
```

- **Compare base vs head back-to-back** (deploy baseline → sweep → deploy change → sweep) so
  dev's shared-instance noise cancels — relative deltas are valid even though absolute dev
  numbers wander vs prod.
- **Drive the path this change affects:** push via `push-sweep.ts`; pull/clone-side changes
  by timing a fresh `rbox init --workspace <id>` into an empty dir (a clone-sweep is a TODO).
- **Success metric = this doc's Target/Goal section.** Once the §25 server metrics are live on
  dev you can read the server-side split (`d1Calls` / `d1Ms` / `r2Ms` per op) directly instead
  of inferring it from client wall-time — land §25 on dev first.
- Only merge to `main` (→ prod) once it's proven on dev.
- For an **isolated, repeatable** target (no contention with other dev work, wipe-and-repeat),
  set up a dedicated `[env.bench]` → `rbox-bench-api` + throwaway `rbox-bench-db`/`-blobs` and
  point `--remote` at it. (See the README "Benchmarking" section.)

---

## v2 — codex adversarial review resolutions (2026-06-30)

Codex flagged 5 BLOCKERs + 5 MAJORs. The root issue: accounting must be **atomic with
publication** across two systems (the WorkspaceSync DO that sequences commits, and D1
that holds usage/entitlements). Resolutions, by finding:

### B1 — accounting↔publish atomicity (publish-then-account, post-publish charge)
**Reorder:** the DO `transactionSync` head-advance is the SOLE commit point. Accounting
runs ONLY after the head advances. If the DO returns 409/epoch-stale we never touch D1 →
no charge, no grant. If the DO accepts but the D1 grant later fails (crash), the commit is
published-but-unaccounted → a **reconcile pass** re-derives entitlements + usage from the
committed manifest (the committed body is authoritative; accounting is a deterministic
function of it). This mirrors today's already-best-effort post-head D1 mirror. (Was "grant
before head advance" — wrong.)

### B2 + B3 — race-safe charge WITHOUT the false rollback
- **D1 is single-threaded per database**, so two same-account commits (different workspaces)
  hitting the same D1 are **serialized by D1 itself** — the race only exists if `newBytes` is
  computed in the Worker (read) then charged in a later write. Fix: compute AND charge inside
  **one statement**, in SQL: `UPDATE accounts SET used_bytes = used_bytes + (SELECT
  COALESCE(SUM(b.size_bytes),0) FROM blobs b WHERE b.sha256 IN (…) AND NOT EXISTS (SELECT 1
  FROM blob_refs r WHERE r.account_id=? AND r.sha256=b.sha256))` then `INSERT OR IGNORE
  blob_refs` in the SAME `batch()`. The second commit's batch (serialized after) sees the
  first's grant → charges 0 for shared refs. No double-charge, no Worker-side read-then-write.
- **Quota under concurrency = soft-at-the-exact-boundary.** Codex B2 is right: D1 `batch()`
  rolls back on statement FAILURE, not on a 0-row UPDATE. So we do NOT rely on a conditional
  UPDATE to abort the batch. Instead: (a) `missingBlobs` returns `{used,cap,remaining}` and the
  client refuses a doomed push up front; (b) the post-publish charge is unconditional (the
  commit is already published). A cross-workspace same-account race can exceed cap by at most
  ONE commit's bytes; the **next** push is rejected by the advisory pre-check. Document this as
  the quota model (soft boundary, firm on next op) — acceptable for a paid product; avoids the
  distributed-atomic-quota complexity. (If hard caps are ever required → a per-account
  AccountAccounting DO becomes the serialized reserve/commit authority; deferred, not needed now.)

### B4 — receipts cover EVERY charged object incl. the encrypted manifest
The commit request carries `receipts: { [sha]: receipt }` for every referenced stored object
— the file blobs AND `encManifestSha` (+ the §24 sidecar object once it exists). **Billing
size = the server-measured ciphertext size** baked into each receipt (and stored in `blobs.
size_bytes` on PUT), NOT `blobRefs.size` (which is plaintext, client-supplied → advisory only,
ignored for accounting). The signed body already commits to `encManifestSha`; the manifest is
uploaded as a normal blob first, so it has a receipt like any other.

### B5 — GC must not purge a freshly re-uploaded object
Once PUT stops clearing `gc_candidates`, a stale candidate mark could purge a new object with a
valid receipt. Fix: GC purge does an R2 `head(blobKey)` and **refuses deletion when
`object.uploaded > marked_at` OR object age < grace** (R2 exposes `uploaded`, strongly
consistent). Purge keys on the live object's timestamp, not just the mark. (`versions.ts:68`.)

### M6 — `blobsCheck` rewrite: no existence oracle
Query `blob_refs(account, sha)` FIRST. For shas NOT entitled to this account, **do not touch
global `blobs`, R2, or `gc_candidates`** (those are the M7 existence oracle). "present but
unentitled" (the §23.3 receipt path) is determined WITHOUT a global probe — the client uploads
(idempotent R2 PUT by sha → cheap if it exists) and gets a receipt from the PUT, rather than
the server confirming existence. Revises §23.3: drop the "mint a receipt for already-present"
path; the client always PUTs unentitled shas (R2 dedups the bytes) and the PUT returns the receipt.

### M7 — orphan-byte bound (not per-blob D1)
`RECEIPT_TTL < GC_GRACE` stops resurrection but not an authenticated client spamming uncommitted
R2 bytes. Add a coarse **per-account upload rate/orphan budget** — Cloudflare account-keyed rate
limiting or an AccountUpload DO leaky bucket — NOT a per-PUT D1 SELECT (that's the cost we're
removing). Sized generously; trips only on abuse.

### M8 — scope to a measured ref ceiling
Set `MAX_ACCOUNTING_REFS_PER_COMMIT` (chunk the SQL to D1's 100-param / 100-KB / 30-s batch
limits; ~40 refs/statement). Large monorepos (50k) need §24 (sidecar) + a proven large-commit
accounting path FIRST — §23 lands for the small-file hot path it actually targets.

### M9 — accounting authority stays D1 (with the in-SQL transaction of B2/B3)
Keep D1 authoritative for usage + entitlements (blobGet/missingBlobs read D1, unchanged). The
in-transaction charge+grant (B2/B3) is race-safe given D1's single-threaded serialization, so an
AccountAccounting DO is NOT needed for correctness — avoiding the "mirror failure → unreadable/
unbilled" hazard (M9) and the per-GET DO hop.

### M10 — explicit protocol matrix
`X-Rbox-Protocol: upload-receipts-v1`. PUT → `200 { receipt, sizeBytes }`. Commit body →
`{ commit, receipts: {[sha]: receipt} }`. Absent header ⇒ legacy per-PUT-grant path (kept until
min-CLI moves past the receipts release). New clients persist receipts across 409/422 retries
(re-PUT only the shas the server still reports missing).

### M11 — receipt hardening (chunk 1)
Domain-tag the HMAC; require `v===1`; assert `0 < e-t <= RECEIPT_TTL`; reject future `t`
(clock-skew bound); minimum key length; NO default secret (fail closed if `RBOX_RECEIPT_KEY`
absent); and a startup/test assertion that `RECEIPT_TTL < GC_GRACE` (today GC grace = 1h in
`worker.ts`, so RECEIPT_TTL must be e.g. 30m, strictly less).

### M12 — scope the "R2-only" claim
Only the SINGLE-PUT path becomes R2-only. Multipart keeps its D1 resumability metadata
(`uploads`/`upload_parts`) — it's the rare >90 MB path, not the measured many-small-files hot
path. State this precisely; don't claim multipart is R2-only.

> **Next:** fold these into the chunk docs (4/5/6 + 1 + a new GC note), then re-run codex on
> the revised design before implementing. A real-D1 spike (in-SQL NOT-EXISTS charge; batch
> rollback behavior) is the first implementation task — verify before building on it.

---

## v3 — second codex pass corrections (2026-06-30)

The second adversarial pass confirmed B3, B4, M6, M8, M9, M10, M12 closed but found the v2
*publish-then-account* model created a worse hole. Final decisions (the chunk docs §23.4/5/6
are authoritative; this supersedes the matching v2 bullets):

- **B1 → account-then-publish.** Catalog (`blobs`) + charge + grant land in ONE D1 batch
  *before* head-advance, so a published head never references an uncataloged blob (no 404, no
  GC data loss). The benign tail: a 409-then-abandon leaves entitled-but-unreferenced blobs the
  account genuinely uploaded — a bounded, reclaimable quota leak, not data loss. (§23.4 v3.)
- **B2 → hard cap via `CHECK (used_bytes <= cap_bytes)`.** Over-cap fails the charge statement
  → the whole `batch()` rolls back (D1 rolls back on statement *failure*). D1's per-DB
  serialization makes each account's CHECK see prior commits' `used_bytes`, so the
  "N workspaces each pass preflight → N× overshoot" storm is impossible. (§23.4/§23.6.)
- **B5 → commit R2-heads candidate-revived refs + GC re-heads before delete.** The only
  GC-racing case (reviving a condemned orphan) is verified at commit; the residual head→delete
  window is shrunk by the age test and made *recoverable* (commit returns `needs_upload`),
  never silent corruption. Fully closing it needs R2 conditional-delete (unavailable);
  documented honestly. (§23.5.)
- **M7 → concrete orphan bound.** Per-account PUT rate limit (Cloudflare native, account-keyed)
  + R2 lifecycle expiry on the staging prefix ⇒ orphan bytes ≤ `PUT_RATE × max_size × GC_GRACE`,
  then reclaimed. No per-blob D1. (§23.5.D.)
- **M11 → receipt hardening in the primitive spec.** Domain tag `rbox.receipt.v1|`, `v===1`,
  `t`-not-future (±SKEW), `0 < e-t <= RECEIPT_TTL`, fail-closed on absent/short key, startup +
  unit assertion `RECEIPT_TTL < GC_GRACE` (30m < 1h). (§23.1.)

The two load-bearing assumptions both reduce to ONE D1 spike (first implementation task):
(1) the in-SQL `NOT EXISTS` charge is exactly-once under D1 serialization, and (2) a CHECK
violation rolls back the whole `batch()`. Run it against dev D1, not just local SQLite.

---

## v4 — third codex pass: staging/canonical split (2026-06-30)

The third pass (web-grounded in Cloudflare's R2/D1 semantics) **confirmed B2 and M11 closed**
but showed B1/B5/M7 all share one root cause: deleting content-addressed objects at the
canonical key races re-reference, and **R2 has no conditional delete** (same-key PUT/DELETE is
last-writer-wins). You cannot fix that TOCTOU with another R2-head. v4 removes the race instead
of narrowing it (supersedes the v2/v3 GC bullets above):

- **Two namespaces.** PUT writes a per-account **staging** key `staging/{acct}/{sha}` (§23.2).
  Commit **promotes staging→canonical** via R2 server-side copy, then catalogs + charges +
  grants before publish (§23.4). **§23 never deletes canonical objects.**
- **B1/B5 closed structurally.** GC deletes only *staging* orphans, which no committed head
  ever references → no delete can race a commit, no dangling head, no resurrection dance, no
  `gc_candidates`. A committed ref's canonical bytes are never deleted by §23, so
  `blob_refs` reliably implies the bytes exist (fixing the "entitled→skip→publish absent" hole).
- **M7 closed honestly.** Orphans = staging objects; bounded by an R2 **lifecycle rule on the
  `staging/` prefix** + a per-account PUT rate limit. Lifecycle granularity is ~24h (multipart
  abort ~7d), so `STAGING_GC_GRACE ≈ 24h` and `RECEIPT_TTL = 12h` (`< STAGING_GC_GRACE`) — the
  earlier 1h/30m figures were below what R2 lifecycle actually delivers.
- **B2 caveat resolved.** A migration materializes `accounts.cap_bytes` (kept in sync with the
  plan); the `CHECK (used_bytes <= cap_bytes)` is a same-row invariant.
- **Out of scope (deferred, tracked in backlog):** reclaiming *canonical* dedup'd blobs that
  reach zero `blob_refs` — a rare offline mark-sweep needing a quiescence/lease protocol.
  Until then canonical objects are retained (storage is cheap; we trade disk for a race that
  R2 primitives cannot otherwise win).

Cost of v4: commit does an R2 server-side copy per *new* blob (no worker egress; already-present
shas skip it). The §25-measured win (removing ~7 D1 calls / ~956 ms from the PUT hot path) is
preserved — the copy is not D1 and not worker egress.

The two load-bearing assumptions remain one D1 spike (first impl task): the in-SQL `NOT EXISTS`
charge is exactly-once under D1 serialization, and a CHECK violation rolls back the whole batch.

---

## v5 — fourth codex pass: admission check + legacy-GC removal (2026-06-30)

Fourth pass: **B1 CLOSED, B5 CLOSED** (conditional on actually removing the legacy canonical
GC), **M7 the last open** — plus a sharp new catch: v4 promoted staging→canonical *before* the
quota CHECK, so an over-cap commit rolled back D1 but left the promoted canonical bytes parked
forever (canonical GC is out of scope) → an account could park unbounded uncharged bytes with
unique shas. Fixes:

- **M7 → admission check before promote (§23.4 step 3).** Commit reads `used`/`cap` and returns
  `402` *before* promoting if over cap. D1-serialized, so a serial account can never park
  over-cap canonical bytes (admission fails once `used ≈ cap`). The residual is only the
  concurrent-race window (two commits pass admission, one then fails the CHECK), bounded by the
  account's in-flight commit concurrency × commit size — not unbounded over time. This is the
  "server-side admission step before promote" the fourth pass required.
- **B5 → §23 removes the destructive canonical GC (§23.5).** The existing scheduled
  `gc_candidates`/canonical purge (`worker.ts` `runScheduledGc` + `versions.ts`) is deleted and
  replaced by staging-prefix reclamation. The legacy pre-receipts *upload* fallback may still
  write canonical (additive, safe); the legacy *deletion* path must be gone. Exactly one deleter
  remains (staging GC); it never touches canonical.
- **M7 multipart horizon stated:** R2's incomplete-MPU abort default is **7 days** (≠ the ~24h
  object-age rule), so the multipart-orphan bound is `PUT_RATE × max_size × 7d` and
  `RECEIPT_TTL` (12h) is `< 7d`. Set the abort horizon explicitly.

Commit order is now: validate → **admission** → promote staging→canonical → D1 batch
(catalog+charge+grant under CHECK) → advance head. Grant durable ⟹ canonical present (promote
precedes the batch); over-cap ⟹ no serial over-promote (admission precedes promote).

---

## v6 — fifth codex pass: reservation leases + no legacy canonical write (2026-06-30)

Fifth pass: **B1 CLOSED, B5 CLOSED**. M7 still open because a bare admission *read* doesn't
bound *concurrent* commits — K commits all read `used=0`, all promote, K attacker-controlled.
Plus the legacy canonical-write fallback was a serial bypass. Final fixes:

- **M7 → atomic reservation (`commit_leases`) before promote.** Admission becomes a D1 *write*:
  catalog receipt sizes → INSERT a lease for `newBytes` → `UPDATE reserved_bytes += newBytes`
  under `CHECK (used_bytes + reserved_bytes <= cap_bytes)`. D1 serializes per account, so total
  in-flight reserved ≤ `cap - used` **independent of K** → promoted-but-uncharged canonical
  bytes are hard-bounded by `cap`, not `K × size`. The commit batch converts the lease
  (`used += newBytes`, `reserved -= newBytes`, grant, delete lease); a lease-expiry sweep
  releases crashed reservations. (§23.4 steps 3/5/6.)
- **No legacy canonical-write path.** rbox controls all clients, so a PUT without
  `X-Rbox-Protocol: upload-receipts-v1` gets `426 Upgrade Required` — every canonical write goes
  through the bounded promote, closing the serial bypass. (§23.2.)
- New schema: `accounts.reserved_bytes`, `CHECK(used+reserved<=cap_bytes)`,
  `commit_leases(lease_id, account_id, bytes, expires_at)` + expiry sweep.

Final commit order: validate → **reserve** (lease, CHECK) → promote staging→canonical → D1
batch (charge via NOT-EXISTS, grant, release lease) → advance head. Invariants held together:
*grant durable ⟹ canonical present* (promote precedes the grant batch); *uncharged canonical
parking ≤ cap* (reservation precedes promote, serialized); *committed ref bytes never deleted*
(§23 deletes only staging).

---

## v7 — sixth codex pass: charge-before-promote (the fundamental fix) (2026-06-30)

Sixth pass confirmed B1–B5 closed but showed v6's lease model couldn't bound *cumulative*
canonical parking: promote-before-charge writes uncharged canonical bytes, and since canonical
can't be safely deleted (R2 race), crash/timeout cycles accumulate them past `cap` over time —
the lease only bounds *instantaneous* in-flight, and the lease lifecycle itself raced the charge.

The fundamental fix — **charge + grant BEFORE promote** (supersedes v5/v6's reservation):

- **M7 closed by construction.** Commit does the D1 batch (catalog + charge via `NOT EXISTS` +
  grant) under `CHECK(used_bytes <= cap_bytes)` FIRST; only then promotes staging→canonical.
  **Canonical bytes are never written uncharged**, so there is nothing to bound and no lease
  machinery. An attacker who charges then abandons spends their *own* quota (self-limiting at
  `cap`); their staging objects are reaped; no canonical is written.
- **entitled ⟹ canonical** held by: promote is **receipt-keyed + idempotent** (re-runs on
  retry); on a clean promote failure the grant is **compensated** (D1-only undo, no R2 race);
  the rare crash-after-grant-before-promote tail is reconciled by a D1-authoritative sweep
  (re-promote within TTL, else revoke+refund) — and that ref is in no published head meanwhile.
- **committed head ⟹ canonical** held by advancing head only after promote succeeds.
- Schema simplifies back to just `accounts.cap_bytes` + `CHECK(used_bytes <= cap_bytes)`; no
  `reserved_bytes`, no `commit_leases`.

Final order: validate → D1 batch (catalog+charge+grant, CHECK) → promote staging→canonical
(receipt-keyed, idempotent) → compensate-on-promote-fail → advance head. The three invariants
(no double-charge, no uncharged canonical, no dangling head) now hold simultaneously without a
cross-system 2PC — the staging/canonical split + charge-before-promote + D1-only compensation is
what makes it work on R2's primitives.

---

## v8 — seventh codex pass: decouple "charged" from "present" (2026-06-30)

v7 closed M7's parking but reopened B1: `blob_refs` (granted before promote) was treated as
"bytes present," so a crash/fail between grant and promote left an **entitled-but-absent** ref a
later same-account commit could reference (skip promote → publish a head over absent bytes), and
compensation/reconcile could revoke a ref another commit relied on.

Root cause: one row (`blob_refs`) carried two facts — *charged* and *canonical present*. v8 splits
them with **`blobs.present`** (set only after a confirmed promote):

- **Reuse / `missingBlobs` / head-validate gate on `present=1`, never on `blob_refs` alone.** A
  `present=0` ref is *missing to every consumer*, so it can never enter a published head — closing
  the "entitled-but-absent reuse → dangling head" hole (B1) and the "head ⟹ canonical" invariant.
- **Cleanup is safe without head-reachability proof.** Because `present=0` is in no head, the
  reconcile sweep can revoke (`DELETE blob_refs` + refund) or re-promote any stale `present=0` ref
  unconditionally; a `present=1` ref is never swept. This closes codex's "revoke a still-used ref"
  and "unsafe compensation" hazards — no active compensation needed at all.
- **M7 stays closed:** charge still precedes promote (no uncharged canonical); abandon-after-charge
  spends the attacker's own quota.

Final order: validate (`present=1` or receipt) → D1 batch (catalog `present=0` + charge + grant,
CHECK) → promote staging→canonical (receipt-keyed, idempotent) → set `present=1` → advance head.
Three invariants hold simultaneously on R2's primitives, no 2PC:
*no double-charge* (NOT-EXISTS in one batch), *no uncharged canonical* (charge before promote),
*no dangling head* (head + reuse gate on `present=1`, which is set only after promote).
Schema adds `blobs.present`; everything else simplifies.

---

## v9 — eighth codex pass: reconcile checks canonical before refund (2026-06-30)

v8 confirmed B1–B5 closed and per-sha `present` sound. The last M7 corner: a crash *after* the R2
copy succeeds but *before* `present=1` leaves a **real canonical object flagged `present=0`**; if
staging then expires, the v8 reconcile would revoke+refund → uncharged canonical bytes →
cumulative parking. Fix (§23.5):

- **Reconcile R2-`head`s canonical BEFORE any refund.** If the canonical object exists → the
  promote succeeded; **adopt it (`present=1`), keep the charge** — never refund a sha whose bytes
  exist. Only when canonical AND staging are both absent does it revoke+refund (the bytes truly
  don't exist; the ref is in no head). Since §23 never deletes canonical, a present `head` is
  durable, so adoption is race-free.

This removes the last uncharged-canonical path; M7 is closed by construction *and* in the
crash-recovery tail. Net invariants (all simultaneous, no 2PC, on R2 primitives):
no double-charge · no uncharged canonical · no dangling head · safe reconcile.

---

## v10 — ninth codex pass: revoke is lease-guarded + atomic (2026-06-30)

v9's reconcile fixed the crash-after-copy case but the *revoke* branch still had a TOCTOU:
reconcile observes stale R2 state (canonical absent, staging absent), then a concurrent re-upload
+ commit re-grants/promotes/sets `present=1` before reconcile's `DELETE` lands → it deletes a
now-valid entitlement + refunds → uncharged canonical / dangling head. Fix (§23.4 grant + §23.5):

- **Lease timestamp.** The grant is `INSERT … ON CONFLICT DO UPDATE SET granted_at = now`, so
  every reference refreshes `blob_refs.granted_at`. Reconcile revokes a `present=0` ref only when
  `granted_at < now − REVOKE_GRACE` (`REVOKE_GRACE ≫ max commit duration`, e.g. 1h). A concurrent
  or retrying commit refreshes `granted_at` → the ref is never revoke-eligible while in flight.
- **Atomic conditional delete.** Revoke is one statement guarded by `present=0 AND granted_at < ?`
  with `RETURNING`, and the refund is computed from the rows *actually deleted* (0 rows → 0 refund).
  A commit that set `present=1` first makes the DELETE a no-op; if reconcile wins, the later commit
  re-grants from its receipt.

This is the standard timestamp-lease + atomic-conditional-delete closure for the revoke TOCTOU,
on top of the v9 head-before-refund rule. M7's every facet — instantaneous parking, cumulative
parking, crash-after-copy, and the revoke race — is now closed.
