# ADR 001 — files-sdk: build vs buy for the R2 blob layer

**Status:** Accepted (M9). **Decision: BUILD — keep our blob layer; borrow
techniques, not the dependency.**

## Context

rbox's blob layer (content-addressed R2 storage) was built and verified across
M3 (production blob path), M5 (convergent encryption), M6 (reachability GC), and
M7 (multi-tenant entitlement). `files-sdk` is the storage-layer prior art that
already shaped several of those decisions. M9 records whether to adopt it.

## What rbox's blob layer needs (and already has)

- Content-addressed PUT to R2 with server-side sha256 verification, staging-key →
  publish-to-canonical (M3). ✅ verified live.
- Resumable multipart for large objects with server-authoritative `upload_parts`
  and streaming sha (M3). ✅
- Convergent AES-256-GCM encryption addressed by ciphertext sha (`encSha`),
  self-describing via the manifest (M5). ✅ 7/7.
- Reachability GC with candidate-tagging that never moves canonical keys, global
  authoritative DO roots, fail-closed (M6). ✅
- Per-account blob entitlement created only by verified upload; account-scoped
  existence checks; atomic quota reserve (M7/M7b). ✅ verified.

These are tightly coupled to two rbox-specific subsystems: the **WorkspaceSync
Durable Object** (the commit sequencer + entitlement boundary) and the
**plan/quota model**. The blob layer isn't a generic file store bolted on; it's
woven into how rbox sequences commits and bills storage.

## Comparison

| Capability | rbox (built) | files-sdk | Verdict |
|---|---|---|---|
| Content-addressed PUT + sha verify | ✅ M3, live | ✅ | parity; ours is coupled to commit validation |
| Resumable multipart (server-authoritative parts) | ✅ M3 | ✅ | parity; **gap:** per-part retry/progress UI (see below) |
| Convergent encryption (`encSha`) | ✅ M5, 7/7 | partial | ours is rbox-specific (manifest-described) |
| Reachability GC w/ candidate-tagging | ✅ M6 | ✅ different model | ours is coupled to DO roots |
| Per-account entitlement + atomic quota | ✅ M7/M7b | ❌ not its concern | rbox-only; files-sdk wouldn't own it |
| DO commit sequencing integration | ✅ (the whole point) | ❌ | rbox-only |
| workerd/Worker bundling | ✅ native | ⚠️ caveat (prior-art §7) | decisive against adopting |
| Direct-to-R2 (presigned) upload | ❌ not built | ✅ | files-sdk technique worth borrowing later |

## files-sdk fit

- **Pro:** battle-tested patterns for the upload/encryption/GC concerns we built.
- **Con (decisive):** the workerd bundling caveat (prior-art §7) — it doesn't
  drop cleanly into a Worker. Adopting it would mean wrapping/patching, then
  re-coupling it to our DO sequencer + entitlement checks anyway. The integration
  cost approaches the build cost, on top of a dependency we'd carry forever.
- The work is **already done and verified**. Replacing verified, coupled code
  with an external dependency to do the same job is negative-value churn.

## Decision

**Build (keep ours).** The blob layer stays first-party. We treat files-sdk as a
*reference* — if a concrete gap appears (a resumable-upload edge case, a
multipart-GC interaction, an encryption-format improvement), we borrow the
specific technique rather than taking the dependency.

## Residual gaps in our blob layer (acknowledged, not blockers)

These are real gaps the ADR keeps honest — none justifies taking the dependency,
but each is a candidate for borrowing a files-sdk *technique*:
1. **Per-part retry/progress.** Multipart resumes from `upload_parts`, but a flaky
   single part retries the whole attempt; no per-part backoff or progress UI.
2. **Direct-to-R2 (presigned PUT).** All bytes currently transit the Worker
   (bounded, streamed). Presigned direct upload would cut Worker egress for very
   large blobs — a files-sdk pattern worth borrowing if blob sizes grow.
3. **Manifest-metadata E2EE + key rotation.** M5 encrypts blob *contents*; the
   manifest is still plaintext (paths/sizes leak) — tracked under the full-E2EE
   milestone, independent of files-sdk.

## Consequences

- No new runtime dependency in the Worker; no bundling workarounds.
- We own the blob layer's correctness (already covered by live verification +
  the M3/M5/M6/M7 suites) and its evolution.
- Revisit only if we need a capability that's expensive to build and that
  files-sdk provides cleanly under workerd (none identified today).

## Revisit triggers

- A resumable-upload or multipart-GC class of bug we can't economically fix.
- files-sdk ships first-class workerd support that removes the bundling caveat
  AND a feature we'd otherwise have to build (e.g. cross-region replication).
