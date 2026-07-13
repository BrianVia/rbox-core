# Design 09 — Hardening & Scale (Milestone 9)

**Status:** v2 — IMPLEMENTED. Resolved a thorough codex NEEDS-PASS (6 must-fix).
The cold-scan benchmark found & fixed a real scale bug (bonus). Resolutions:

1. **FakeRemote = stateful server simulator** (blob map, head sequence, manifest
   log, parent-sequence check, blob-existence validation, byte-verifying
   `putBlobFile`) — NOT a scripted mock. Tests are oracle assertions: the 409
   test asserts the rescan preserves BOTH changes; the give-up test asserts our
   change is never committed nor lost; the no-op test asserts ZERO commits.
   `src/cli/sync.test.ts` (9 tests).
2. **SyncRemote flows through everything** — `pull`/`push`/`pushManifest`/`sync`/
   `captureGitForPush`/`encryptAndUpload`/`uploadBlobs`/blob-store + the recursive
   retry, all via a `SyncDeps` object; tests inject a **no-op backoff**.
3. **Cold-scan thresholds + a real fix.** Bar: cold <5s / warm <1s for ~50k
   syncable files; never publish manifests without content hashes (we don't).
   **The benchmark exposed an O(per-file-stream) bug**: a 50k-file tree took
   >2min. Fixed via (a) reading small files whole instead of streaming, (b)
   bounded-parallel hashing of cache misses → **cold 2.4s, warm 0.76s** (50k
   files; node_modules pruned, not descended). `scripts/bench-scan.ts`.
4. **Conflict metrics = two counters** (`commitConflicts409` via a sync hook +
   `fileConflicts` from reconcile actions), persisted in a SEPARATE
   `metrics.json` (never the correctness-critical `state.json`), surfaced in
   `rbox status`. `src/cli/metrics.ts`.
5. **Miniflare/workerd Worker tests** (`apps/api/test/worker.test.ts`, via
   `@cloudflare/vitest-pool-workers`): real DO+D1+R2. 4 pass — auth/401, blob
   entitlement, **cross-account 404 isolation**, **quota 402**. The 2 DO
   commit-sequencer tests are **skipped**: the DO uses `ctx.storage.kv` /
   `transactionSync`, newer than the workerd bundled with the pinned
   pool-workers (caps at compat 2025-07-30) — verified LIVE (M1–M7) + by the
   client FakeRemote 409/422 suite. Re-enable when a newer test runtime lands.
6. **files-sdk ADR** upgraded to a real comparison table + residual gaps
   (per-part retry, direct-to-R2, manifest E2EE) + revisit triggers.
   `docs/adr/001-files-sdk-build-vs-buy.md` — decision: **build/keep ours**.

---

**v1 plan (for reference):**

**Implements:** roadmap M9 (the final milestone). Four threads, ordered by value:
1. **Client/sync-layer tests** (the explicit coverage gap — engine is tested,
   the push/pull/conflict-retry control flow is NOT).
2. **Cold-scan cost** on a real large tree — validate "performance paramount."
3. **Conflict-rate metric** surfaced for dogfooding.
4. **files-sdk buy-vs-build decision** for the R2 blob layer (decision, not code).

## 1. Client/sync tests — make the remote injectable (the real gap)

`sync.ts`'s `pull`/`push`/`pushManifest`/`sync` build `new RboxApi(cfg)`
internally, so the conflict-retry control flow (the trickiest, highest-risk code
in the client) can only be exercised against a live server. That's why it's
untested.

**Refactor (minimal DI):** define the narrow interface `sync` actually needs and
inject it.

```
export interface SyncRemote {
  missingBlobs(shas: string[]): Promise<string[]>;
  putBlobFile(sha, absPath, size, uploadsDir?): Promise<void>;
  commit(parentSeq, deviceId, manifest): Promise<CommitResult>;
  latest(): Promise<{ sequence; manifest }>;
  blobStore(): BlobStore;   // for applyActions on pull
}
```

`RboxApi` already implements all of these (add a tiny `blobStore()` returning
`new RemoteBlobStore(this)`). The sync entry points take an optional
`remote?: SyncRemote`, defaulting to `apiFor(cfg)`. Threads through
`pull`/`push`/`pushManifest`/`sync` via a small `opts` object so the daemon and
CLI callers are unchanged (default path).

**Tests (in-memory `FakeRemote`):** a Map-backed blob store + a commit sequencer
with a settable "advance remote underneath us" hook, exercising:
- **no-op short-circuit:** nothing changed → no commit, sequence unchanged (the
  echo-storm guard that makes continuous bidirectional sync viable).
- **clean push:** uploads only missing blobs, commits, advances base.
- **409 conflict-retry:** remote moved → push gets conflict → pull + RE-SCAN +
  retry; succeeds within MAX_ATTEMPTS; bounded (gives up after the cap).
- **422 unsatisfied-blobs:** server reports missing → re-upload + retry.
- **pull reconcile:** remote manifest applied; invalid remote manifest rejected
  (never touches disk).
- **forward-only ignore carry:** a now-ignored but previously-synced file is
  carried (not seen as a deletion) unless `--purge`.

This converts the client's riskiest logic from "tested only live" to a tight,
offline feedback loop — directly the project's feedback-loop priority.

## 2. Cold-scan cost — measure, then decide if incremental is needed

The daemon already runs chokidar + a persistent `HashCache` (mtime/size keyed),
so steady-state is incremental. The open question is **cold start**: first
`scanManifest` on a large `~/Development` (no warm cache).

- **Benchmark:** a `scripts/bench-scan.ts` that times `scanManifest` on a target
  dir (cold: clear cache; warm: second run), reporting files scanned, bytes
  hashed, wall time, and time-to-first-manifest. Run on a real multi-GB tree.
- **Decision gate:** if cold-scan on a realistic tree is acceptable (target: a
  few seconds for ~50k files, dominated by hashing not walking), no incremental-
  scan work is needed — document the number. If it's bad, the fix is to defer
  hashing (manifest entries by mtime/size first, hash lazily on demand) — design
  it only if the benchmark says so. **Measure before building.**
- The `BUILTIN_IGNORE` set (node_modules/target/.venv/.git, M8 additions) already
  keeps the walk off the giant regenerable dirs — confirm the benchmark reflects
  that (it should not descend into them).

## 3. Conflict-rate metric

Continuous bidirectional sync amplifies conflicts; we need to see the rate.
Lightweight: the daemon already produces reconcile `Action[]`. Tally
`conflict`-kind actions into a per-session counter persisted in daemon state
(`conflicts`, `syncs`, `lastConflictAt`), surfaced in `rbox status` and the
daemon log. No new infra — just count what reconcile already emits. (A
server-side aggregate is out of scope; this is local dogfooding signal.)

## 4. files-sdk buy-vs-build decision

Per the prior-art notes, `files-sdk` is the storage-layer reference that already
shaped v2 encryption/GC/upload decisions. M9 records the **decision**, not code:
- What rbox's blob layer needs (content-addressed R2 PUT with sha verification,
  staging→publish, resumable multipart, entitlement/GC) — all already built and
  verified across M3/M5/M6/M7.
- files-sdk's fit + the workerd bundling caveat (prior-art §7).
- **Recommendation:** since the blob layer is built, verified, and tightly
  coupled to our DO sequencer + entitlement model, the decision is **build
  (keep ours)** — adopt specific files-sdk *techniques* if a concrete gap
  appears, but don't take the dependency. Documented in a short ADR.

## 5. Files

| File | Change |
|---|---|
| `src/cli/remote.ts` | add `SyncRemote` interface + `RboxApi.blobStore()` |
| `src/cli/sync.ts` | inject optional `remote` (default `apiFor`); thread via `opts` |
| `src/cli/sync.test.ts` | **new** — FakeRemote + the conflict-retry/no-op/ignore matrix |
| `scripts/bench-scan.ts` | **new** — cold/warm scan benchmark |
| `src/cli/daemon.ts` + state | conflict counters → `rbox status` |
| `docs/adr/001-files-sdk-build-vs-buy.md` | **new** — the decision record |
| `docs/roadmap.md` | M9 checkboxes |

## 6. Verification

- `sync.test.ts` covers no-op / clean-push / 409-retry (incl. give-up at cap) /
  422-reupload / pull-reconcile / invalid-manifest-reject / ignore-carry — all
  offline, deterministic.
- `bench-scan.ts` run on a real tree; numbers recorded in the design + learnings;
  cold-scan does NOT descend into ignored dirs (assert file count excludes them).
- Conflict counter increments across a forced conflict (reuse a sync test) and
  shows in `status`.
- ADR committed. `bun test` + both `tsc` green; antislop clean.

## 7. Open questions for codex review

1. Is the `SyncRemote` seam the right abstraction, or should tests use a real
   in-memory Worker (Miniflare) for higher fidelity at higher cost? (DI is
   lighter and tests the CLIENT logic, which is the gap; the server is separately
   verified live. Lean DI?)
2. Conflict-retry test fidelity: a `FakeRemote` that advances its sequence on a
   settable trigger vs a scripted sequence of commit responses — which better
   catches real races without becoming a mock that just re-asserts the code?
3. Cold-scan target threshold: what's "acceptable" for a dev's `~/Development`,
   and should time-to-first-manifest (defer hashing) be built now or only if the
   benchmark fails?
4. Is "build (keep ours)" for the blob layer the right call given it's already
   verified, or does files-sdk close a gap we're underrating (resumable-upload
   edge cases, multipart GC)?
5. Anything in M1–M8 that should be hardened before calling the roadmap done
   (a known sharp edge we've been deferring)?
