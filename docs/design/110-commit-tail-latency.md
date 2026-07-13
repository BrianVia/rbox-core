# 110 — First-publish commit-tail latency

Status: INITIAL DRAFT, 2026-07-12 — no adversarial review yet.

This design addresses the long synchronous tail of a greenfield first publish.
It deliberately does not change manifest semantics, the signed commit format, or
the atomic head advance. The proposed optimization is a genesis-only bulk
implementation of the existing full-ref admission predicate, guarded by a
server kill switch and shadowed against the current implementation before it can
enforce.

## Problem

A field first publish of `flat-meadow` on 2026-07-13 transferred 2.85GB and
published 49,382 blobs. `FirstPublishStats` reported `commit46100`: 46.1s of
commit wall after the upload lane. The push timing line attributed 41.7s to the
commit `p` token.

That tail matters independently of bulk upload throughput. By the time it is
visible, the files have uploaded and the user is waiting for the workspace head
to become durable. A forty-second final barrier also magnifies retries: a lost
response or late parent conflict repeats a conspicuously long operation.

The tempting description — “uploading a 118k-file manifest takes 41.7s” — is
not what the code measures. This design first pins the timing boundary, then
optimizes the work that can actually occur inside it.

## Evidence

### Field observation

| Signal | Value |
|---|---:|
| Workspace | `flat-meadow` |
| Date | 2026-07-13 |
| First-publish wire bytes | 2.85GB |
| Published blobs | 49,382 |
| Manifest entries | approximately 118k files |
| `FirstPublishStats.commitWallMs` | 46.1s |
| push timing `p` | 41.7s |

This is one field sample, not yet a distribution. The raw
`srv/env/acct/ssc/cm/mir/rsp` values from that same push line must be preserved
in the gate record in Phase 0; the two headline values alone identify the
boundary but do not fully split the work within it.

### What `p` measures

`formatCommitTimings` renders `p` from `CommitTimings.postMs`
(`src/cli/sync.ts:142-147`). `postMs` starts immediately before
`this.api.commitSigned(parentSequence, built.commit)` and stops after that call
returns (`src/cli/e2ee-remote.ts:886-895`). Before this timer starts, the client
has already:

1. built and uploaded the canonical refset sidecar for a large ref set
   (`src/cli/e2ee-remote.ts:780-809`);
2. encoded and encrypted the genesis snapshot (`:839-877`); and
3. uploaded the encrypted manifest blob (`:878-884`).

Those operations render separately as `sc`, `e`, `c`, and `u`. Therefore `p`
is **not** client-side manifest serialization, compression, encryption, or wire
transfer of the encrypted manifest blob.

There is one important client-side component inside `p`: `commitSigned` first
drains outstanding upload receipts through `redeemReceipts`, in batches of at
most 5,000, and only then sends the commit POST
(`src/cli/remote/commits.ts:163-236`). Thus:

```
p = final receipt-redemption drain
  + final commit request/response outside the DO
  + serverTimings.totalMs
```

The final POST is small for this workload. A large workspace uses the binary
refset sidecar; the signed body contains its `{sidecarSha,count,totalBytes}`
descriptor, and the POST body is `{parentSequence, commit, receipts:{}}`, not
the 118k-entry manifest or the 49k-address refset.

`FirstPublishStats.commitWallMs` supplies a useful cross-check: the timer around
`api.commit` subtracts receipt-redemption wall accrued during that interval
(`src/cli/sync.ts:1016-1022`). Consequently, the observed 46.1s commit KPI is not
explained by simply relabeling 41.7s of `p` as receipt drain. The exact
attribution still requires the same-line server suffix, but the observation is
consistent with the synchronous commit POST being the pole.

### Server decomposition

Design 97 defines the suffix precisely:

| Token | Boundary |
|---|---|
| `srv` | Durable Object commit handler wall |
| `env` | capped request read, JSON parse, envelope checks |
| `acct` | ref presence/entitlement validation and accounting |
| `ssc` | sidecar entitlement, R2 fetch, hash/shape parse |
| `cm` | synchronous DO head/epoch/watermark CAS |
| `mir` | alarm scheduling and best-effort D1 mirror |
| `rsp` | response assembly |

The implementation matches those boundaries in
`apps/api/src/workspace-sync.ts:356-478,516-529,545-558,650-722`.

Prior production evidence on a roughly 114k-ref workspace found 5.8–6.6s of a
6.8–7.5s `srv` in `acct` (design 102 §1). The `flat-meadow` result is materially
slower and must not inherit those ratios without its actual suffix. It does,
however, take the genesis path that performs full admission regardless of the
design-102 mode.

## Root-cause analysis

### Genesis is a full snapshot, by design

Design 84 requires genesis/no-proven-base commits to emit a snapshot: there is
no authenticated base against which a delta can be computed. Compression may
shrink that snapshot, but manifest deltas help only subsequent commits
(`docs/design/84-manifest-delta-encoding.md:325-340`). The server is
zero-knowledge and treats the encrypted manifest as an opaque blob; it cannot
validate or reconstruct its plaintext.

That explains why the first commit has a full manifest blob, but not the 41.7s
`p`: that blob was uploaded under `u` before `p` began.

### Genesis also falls back to full server admission

For sidecar commits, `WorkspaceSync.computeCommitDelta` immediately returns
`fallback: "first_commit"` when `parent === 0`
(`apps/api/src/workspace-sync.ts:276-287`). Both
`RBOX_COMMIT_DELTA_ADMISSION=shadow` and `enforce` therefore materialize the
full child refset and call the existing `validateCommitRefs` plus
`commitAccounting` path (`workspace-sync.ts:572-616`). This is correct: at
genesis every ref is logically added and there is no accepted parent whose
durability can be inherited.

`validateCommitRefs` checks every address for present+entitled state and for GC
candidate/delete-fence barriers in bounded D1 batches. At workspace scale this
means many sequential statements and round trips. `commitAccounting` then
catalogs, charges, grants, and clears barriers for refs not already admitted.
The whole interval is reported as `acct`. Only after it succeeds does the DO
atomically compare parent/epoch/watermark and store the signed commit.

This yields the working diagnosis:

- **Not client manifest work:** it finished before `p` and has separate tokens.
- **Not encrypted-manifest transfer:** that is `u`; the final POST carries an
  opaque hash and a refset descriptor.
- **Possibly some receipt/network tail:** quantified by `p - srv`, with receipt
  timing split out separately.
- **Expected dominant genesis server work:** full-ref admission, confirmed for
  this sample only if its `acct` is dominant. If instead `env` is dominant, the
  premise is falsified and the request path must be investigated; if `p >> srv`,
  client receipt drain/upstream networking is the target.

### Why the server cannot validate after publication

The current order is an integrity invariant, not incidental latency:

```
resolve authenticated refset
→ prove every referenced blob satisfiable and account it
→ atomic head CAS/store
→ acknowledge success
```

Advancing the head and validating asynchronously would permit an accepted head
to reference absent, fenced, or unentitled blobs. Future pulls could then be
irrecoverably broken. Returning success before the CAS would also violate the
existing meaning of commit success. A submit/poll protocol could move waiting
between requests, but would not reduce validation work or end-to-end publish
latency and would add pending-state, expiry, conflict, and epoch semantics.

## Options considered

### A. Stream or compress the genesis manifest upload

Design 84 already supports compressed snapshot envelopes, and a streaming
encoder/uploader could reduce peak memory and `u` for very large manifests.
This is worthwhile only if `e/c/u` is the bottleneck. It cannot remove the
observed `p` tail because the encrypted manifest upload completes before `p`.
It also requires fleet-wide reader capability before a new encoding is written.

**Decision:** not the fix for this design. Keep as an independent manifest-lane
optimization.

### B. Validate asynchronously after accepting the commit

This would make the response fast by weakening what the response means. It
violates manifest/ref integrity and commit atomicity. A safe two-phase variant
must finish admission before the final CAS, so it merely relocates the wait.

**Decision:** reject post-publish validation. Do not change success semantics.

### C. Overlap client manifest preparation with the upload lane

Today final manifest construction occurs after encryption/upload because churn
can defer files and the committed snapshot may include only the stable subset
(`src/cli/sync.ts:957-983`; `src/cli/sync-recovery.ts:467-491`). Encoding mutable
entries earlier risks publishing a descriptor for bytes that were deferred or
changed. An incremental serializer could stage settled entries, then finalize
the sorted manifest/hash after the lane, but the remaining finalization is not
inside `p` and the complexity is disproportionate to this symptom.

Receipt redemption is a safer overlap target: it is idempotent and already has
first-publish overlap instrumentation. Any residual final drain should be
reduced separately by continuously draining during upload, while retaining the
final barrier. That improves `p - srv`, not `srv/acct`.

**Decision:** retain as a conditional client follow-up if Phase 0 finds an
unoverlapped receipt tail above the gate; do not couple it to the server fix.

### D. Pre-admit genesis asynchronously, then finalize with a token

A server could validate/account the full refset into durable state, record a
token bound to account/workspace/project/epoch/refset, and later consume it
before the head CAS. This can be correct if delete-fence and account-deletion
invariants remain live until finalize. In the present client, however, the
final refset is not uploaded until immediately before snapshot encoding, so the
available overlap is only the small `e/c/u` tail unless a substantially larger
session protocol is introduced. It shifts work and adds token recovery without
making the work cheaper.

**Decision:** reserve for a later design only if bulk admission cannot meet the
latency gate.

### E. Bulk full-ref admission for genesis

The current validator uses parameter-limited `IN` queries and many sequential
D1 statement batches. Genesis cannot reduce the set, but it can reduce the
number of database round trips. Feed bounded chunks through one JSON parameter
and `json_each(?)` (or an equivalently measured D1-supported bulk relation),
join that relation once against `blobs`, `blob_refs`,
`blob_ref_candidates`, and active `gc_candidates`, and return exactly the same
per-SHA classification as `validateCommitRefs`.

This remains synchronous and full-set: it changes the execution shape, not the
predicate or ordering. For approximately 49k refs, a measured chunk of 2k–5k
would replace hundreds of small statements with tens of bulk statements. The
chunk size is a benchmark result, not a constant chosen in this draft.

**Decision:** recommended, subject to Phase 0 confirming `acct` and a D1 rig
proving semantic parity and resource bounds.

## Recommended design

### 1. Add a genesis bulk validator, not a new admission model

Add `validateCommitRefsBulk` beside `validateCommitRefs` in
`apps/api/src/commit-accounting.ts`. Its inputs and result are identical:

```
(env, db, accountId, shas, receipts, nowMs)
  → { ok: true, newRefs }
  | { ok: false, needsUpload }
```

Normative requirements:

1. Input SHAs remain the verified canonical child refset plus carriers and
   manifest-chain addresses, deduplicated exactly as today.
2. For every SHA, “have” means `blobs.present=1`, an account entitlement exists,
   no account `blob_ref_candidates` marker exists, and no active
   `gc_candidates.deleting_at` intent exists — the current predicate, unchanged.
3. A non-have SHA enters `newRefs` only with a valid receipt; chargeable size is
   derived only from `verifyReceipt`, never from the sidecar.
4. Missing output preserves the existing bounded/deterministic 422 contract.
5. `commitAccounting` remains unchanged. Quota triggers, delete fences,
   idempotent partial accounting, and account deletion behavior therefore remain
   the authority.
6. Any bulk-query error fails closed to the current validator before the CAS.
   It never skips a ref and never converts an error into success.

The implementation should use a bounded JSON array per statement, validate that
the returned classification cardinality equals the input cardinality, and
reject duplicate/unknown returned rows. This guards against silent truncation,
unsupported JSON behavior, or a query-plan mistake. Chunk-size and total JSON
bytes get explicit caps below the request/isolate memory limits.

### 2. Invoke it only for the existing `first_commit` fallback

In `WorkspaceSync.commit`, preserve `computeCommitDelta` and
`shouldUseDeltaAdmission`. When all of these hold:

- receipts protocol;
- sidecar mode;
- `parent === 0` / fallback reason `first_commit`; and
- the genesis bulk flag permits it,

run the bulk validator over the same `fullChildShas()` set the fallback uses
today. All other fallbacks and all non-genesis commits remain byte-for-byte on
their current path.

The final `transactionSync` parent/epoch/watermark CAS is untouched. Sidecar
resolution remains before admission. Mirror and response semantics are
untouched. No signed or stored format changes.

### 3. Shadow is compare-only; enforce has a fail-safe fallback

The new mode is independent of, but compatible with,
`RBOX_COMMIT_DELTA_ADMISSION`:

| Delta admission | Genesis bulk shadow | Genesis bulk enforce |
|---|---|---|
| `off` | compare bulk classification, current result authoritative | bulk result authoritative; current fallback on internal error |
| `shadow` | existing full result authoritative; compare bulk | bulk result authoritative only after its own shadow gate; delta telemetry still records `first_commit` |
| `enforce` | same as `shadow` because genesis remains a delta fallback | bulk handles only `first_commit`; subsequent commits retain delta enforce |

Shadow must not double-run `commitAccounting`. It compares the pure
classification (`have/new/missing`, receipt-derived sizes) and then accounts
once through the current authoritative result. Emit only counts, timings, and a
bounded digest/sample under the same privacy rules as design 102; never paths or
manifest plaintext.

In enforce, cardinality mismatch, query error, timeout, or unsupported D1
feature immediately runs `validateCommitRefs`. This can be slower but cannot be
less safe.

### 4. Preserve manifest and scan integrity

This design never decrypts, parses, or rewrites the manifest. Design 84's
snapshot/delta envelope, AEAD, canonical hash, chain completeness, epoch rule,
and fail-closed reader behavior are unchanged. Designs 83/85's “doubt does more
work, never loses a change” rule applies directly: a bulk fast-path doubt falls
back to full validation before publication.

The committed manifest is still formed only from carried base entries or files
whose final bytes/descriptors survived churn checks. No preparation is moved
across the decision→upload→state-save interval.

## Flag and rollout

Add a server environment variable:

```
RBOX_GENESIS_BULK_ADMISSION = "off" | "shadow" | "enforce"
```

Unset, empty, unknown, and `"0"` mean `off`. `off` executes the exact current
path and is the kill switch. No D1 migration, client capability, or wire-format
change is required.

Rollout order:

1. Land instrumentation and the bulk classifier with the flag `off`.
2. Deploy the API to dev first, per `docs/DEPLOYMENTS.md`.
3. Run the D1/DO rig and dev fleet with `shadow` across the workload matrix
   below. Do not enable enforcement with any harmful divergence.
4. Enable dev `enforce`; run forced conflict, epoch, quota, 422, deletion-fence,
   and response-loss retries.
5. Deploy prod code with `off`, then `shadow`. Require the sample-count gate.
6. Enable prod `enforce`. Roll back instantly by setting `off`; no stored state
   or protocol downgrade is needed.

## Validation plan

### Phase 0 — preserve and classify the field sample

Before implementation, capture the complete `flat-meadow` push timing line and
FirstPublishStats object. Add/confirm numbers-only fields for:

- receipt count, batch count, total redemption wall, overlap wall, and final
  unoverlapped drain wall;
- final commit POST request bytes;
- existing `p`, `srv/env/acct/ssc/cm/mir/rsp`;
- existing design-102 `admit_stmts`, `admitAccountMs`, `childParseMs`, fallback
  reason, and D1 call count.

Derive:

```
unattributed client/upstream = max(0, p - receiptDrain - srv)
server residual = max(0, srv - env - acct - ssc - cm - mir - rsp)
```

Decision gate: proceed with genesis bulk admission only if `acct` is at least
50% of `p` or at least 10s p50 on three reproduced first publishes. If final
receipt drain is instead at least 10s, prioritize continuous eager redemption.
If `env` is at least 10s, inspect Worker→DO request streaming/body buffering;
the small request-byte measurement must agree before changing transport.

### Correctness matrix

Run each with bulk `off`, `shadow`, and `enforce`, and with
`RBOX_COMMIT_DELTA_ADMISSION=off|shadow|enforce`:

1. Genesis at 0, 1, 49,382, approximately 118k, and the protocol maximum refs.
2. All refs already entitled; all refs receipt-backed; mixed; duplicate content
   collapsing to one ref; missing receipt; bad/expired receipt.
3. Missing manifest carrier, missing sidecar carrier, corrupt/truncated/unsorted
   sidecar, descriptor count/bytes mismatch, and oversized refset.
4. Account quota crossed in the first, middle, and last accounting super-batch;
   retry proves idempotent charge/grant behavior.
5. `blob_ref_candidates`, active delete intent, mark landing between bulk
   classification and accounting, and in-progress account deletion.
6. Parent race (two genesis writers), epoch rotation before admission and before
   CAS, lost success response, and exact retry.
7. Manifest snapshot raw and zstd, plus a subsequent one-file delta commit, to
   prove design-84 behavior and delta admission are unchanged.
8. Kill switch flipped while requests are in flight; each request uses one
   captured mode and returns an ordinary current-contract result.

Shadow acceptance requires zero harmful classification divergence across every
rig case and production soak. Benign ordering differences are not accepted
silently: missing lists and `newRefs` are normalized to the current deterministic
order before comparison.

### Performance and resource gates

Use the same CLI/API build, daemon stopped, same workspace and network path.
For each of 49k, approximately 118k, and maximum-ref genesis workloads, collect
10 warm successful samples per mode plus three cold-isolate samples. Report
p50, p95, and range for client commit wall, `p`, every design-97 server token,
D1 calls/statements, CPU time, and peak Worker heap.

Initial gates, to revise only with a recorded Phase-0 reason:

- 49k genesis `acct` p50 at least 5x lower than flag-off and no more than 5s;
- approximately 118k genesis `acct` p50 at least 5x lower and no more than 8s;
- end-to-end commit-wall p50 at least 2x lower, with no regression above 10% in
  `ssc`, `cm`, or `mir`;
- maximum-ref request stays within the Worker memory/CPU budget with at least
  20% headroom; no bulk JSON chunk exceeds its explicit cap;
- subsequent one-file commit p50 changes by no more than 5%;
- zero harmful shadow divergences, broken accepted heads, double charges, or
  missed delete fences.

Validation is not complete with unit tests. Ship a dev build to the local fleet
and reproduce a greenfield publish, or run the full `bun run rig` first-publish
scenario, then perform the dev deployment soak required above. Finish with the
repository test suites covering commit accounting, workspace sync, remote
commit parsing, and E2EE sync, plus `git diff --check`.

## Out of scope

- Changing design 84's rule that genesis is a full snapshot.
- A new manifest wire encoding or streaming manifest implementation.
- Returning commit success before admission and the atomic head CAS.
- Removing the full validator; it remains the permanent fail-safe.
- Optimizing non-genesis admission beyond design 102.
- Eager receipt-drain scheduling, unless Phase 0 shows that `p - srv` is the
  dominant tail; that should be a small independent client design and flag.
